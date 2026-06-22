// Setup wizard orchestration. ALL I/O is injectable so this is unit-
// testable without a TTY/browser/network. Defaults wire the real ones.
import fs from 'node:fs';
import path from 'node:path';
import { buildCredentialsJson, buildDotEnv, mergeCredentials, mergeDotEnv } from './config-writer.js';
import { verifyRemote } from './verify.js';
import { defaultAsk, realIsIgnored, writeSecret } from './io.js';

// Mask a top-level credentials section for the idempotency preview. For an
// object we show only its key names (structure, never values); for a scalar
// we reveal at most the last 4 chars and only when it is long enough that 4
// chars are not most of the secret. Never stringifies the whole section.
function maskValue(v) {
    if (v && typeof v === 'object') {
        return Array.isArray(v) ? `[${v.length} item(s)]` : `{${Object.keys(v).join(',')}}`;
    }
    const s = String(v ?? '');
    return s.length > 8 ? `••••${s.slice(-4)}` : '••••';
}

export async function runSetupWizard(deps = {}) {
    const cwd = deps.cwd || process.cwd();
    const ask = deps.ask || defaultAsk();
    const out = deps.out || ((s) => process.stdout.write(s + '\n'));
    const fetchFn = deps.fetchFn || globalThis.fetch;
    const isIgnored = deps.isIgnored || realIsIgnored;

    const credPath = path.join(cwd, 'config', 'credentials.json');
    const envPath = path.join(cwd, '.env');

    // A nullish answer means stdin closed (Ctrl-D / EOF / piped input ended).
    // We surface that as a clean cancel: nothing is written, exit code 1.
    const CANCEL = Symbol('cancel');
    const ask1 = async (q) => {
        const v = await ask(q);
        if (v == null) { out('Cancelled (input closed) — nothing written.'); throw CANCEL; }
        return String(v);
    };
    const askSecret = async (q) => {
        const v = typeof ask.secret === 'function' ? await ask.secret(q) : await ask(q);
        if (v == null) { out('Cancelled (input closed) — nothing written.'); throw CANCEL; }
        return String(v);
    };
    const askUrl = async (label) => {
        for (;;) {
            const v = (await ask1(`${label} apiUrl:`)).replace(/\/$/, '');
            if (/^https?:\/\/.+/i.test(v)) return v;
            out('  ✗ must start with http:// or https:// — try again');
        }
    };
    try {
        out('── Unified Job Scraper — setup ──');
        out('Run via: `npm run setup`  (note: `npm start --setup` will NOT work — npm consumes the flag; use `npm run setup` or `npm start -- --setup`).');

        // Idempotency pre-check
        let mode = 'overwrite';
        const credExists = fs.existsSync(credPath);
        const envExists = fs.existsSync(envPath);
        if (credExists || envExists) {
            if (credExists) {
                try {
                    const ex = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
                    out(`Existing config/credentials.json sections: ${Object.keys(ex).map((k) => `${k}(${maskValue(ex[k])})`).join(', ')}`);
                } catch { out('Existing config/credentials.json present (unparseable).'); }
            }
            if (envExists) out('Existing .env present.');
            mode = (await ask1('Existing config found. [merge / overwrite / cancel]?')).toLowerCase();
            if (mode !== 'merge' && mode !== 'overwrite') { out('Cancelled — nothing written.'); return 1; }
        }

        // The scraper always runs as production against the remote queue.
        const answers = { mode: 'remote' };
        answers.blacklight = { apiUrl: await askUrl('blacklight'), apiKey: await askSecret('blacklight apiKey:') };
        answers.scraperCredentials = { apiUrl: await askUrl('scraperCredentials'), apiKey: await askSecret('scraperCredentials apiKey:') };
        answers.scraperMode = (await ask1('SCRAPER_MODE [interactive/daemon] (default daemon):')) || 'daemon';
        answers.headless = (await ask1('Run the browser HEADLESS? [y/N]:')).toLowerCase().startsWith('y');
        answers.strictEmpty = (await ask1('Enable SCRAPER_STRICT_EMPTY now? [y/N]:')).toLowerCase().startsWith('y');
        answers.port = (await ask1('PORT (default 3001):')) || '3001';

        // git-ignore guard — fail closed on a confirmed-not-ignored path;
        // on unknown status (no git / not a repo) warn loudly and confirm.
        for (const p of [credPath, envPath]) {
            const ig = isIgnored(p);
            if (ig === false) { out(`✗ ${p} is NOT git-ignored — refusing to write secrets. Fix .gitignore first.`); return 1; }
            if (ig === null) {
                out(`⚠️ Could not confirm ${p} is git-ignored (no git / not a repo). If this directory is version-controlled, these secrets could be committed.`);
                const go = await ask1('Write secrets anyway? [y/N]:');
                if (!go.toLowerCase().startsWith('y')) { out('Aborted — nothing written.'); return 1; }
            }
        }

        // Build + (optionally) merge + write. In merge mode an unparseable
        // existing file must ABORT — silently overwriting it would destroy
        // the operator data the user explicitly asked to keep.
        let credObj = buildCredentialsJson(answers);
        let envText = buildDotEnv(answers);
        if (mode === 'merge' && credExists) {
            let prev;
            try { prev = JSON.parse(fs.readFileSync(credPath, 'utf-8')); }
            catch { out(`✗ Existing ${credPath} is unparseable — refusing to merge (it would be destroyed). Fix it, or re-run and choose "overwrite". Nothing written.`); return 1; }
            credObj = mergeCredentials(prev, credObj);
        }
        if (mode === 'merge' && envExists) {
            try { envText = mergeDotEnv(fs.readFileSync(envPath, 'utf-8'), envText); }
            catch { out(`✗ Could not merge existing ${envPath} — nothing written.`); return 1; }
        }
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        writeSecret(credPath, JSON.stringify(credObj, null, 2) + '\n', out);
        writeSecret(envPath, envText, out);
        out(`✓ Wrote ${credPath}`);
        out(`✓ Wrote ${envPath}`);

        // Verify
        out('Verifying APIs…');
        const result = await verifyRemote({ fetchFn, blacklight: answers.blacklight, scraperCredentials: answers.scraperCredentials });
        out(result.message);
        out('─────────────────────────────────────────────────────────────────────');
        out('IMPORTANT — next step (do not skip):');
        out('');
        out('  The runtime uses an on-disk LinkedIn profile, NOT the cookies you');
        out('  just saved. To make scraping work you MUST log in once:');
        out('');
        out('      npm run linkedin:login');
        out('');
        out('  Sign in to LinkedIn in the window that opens, press Enter in this');
        out('  terminal when you see your feed, then start the server:');
        out('');
        out('      npm start');
        out('─────────────────────────────────────────────────────────────────────');
        out('Setup complete. To run it as a managed service, see docs/MAC_SETUP.md or docs/WINDOWS_SETUP.md.');
        return 0;
    } catch (e) {
        if (e === CANCEL) return 1;
        throw e;
    } finally {
        if (typeof ask.close === 'function') ask.close();
    }
}
