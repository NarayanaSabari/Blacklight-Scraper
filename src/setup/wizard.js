// Setup wizard orchestration. ALL I/O is injectable so this is unit-
// testable without a TTY/browser/network. Defaults wire the real ones.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseCookieInput, validateLinkedinCookies } from './cookie-input.js';
import { buildCredentialsJson, buildDotEnv, mergeCredentials, mergeDotEnv } from './config-writer.js';
import { verifyLocal, verifyRemote } from './verify.js';

// Real readline wrapper. Two hardening properties beyond a bare question():
//  (1) EOF-safe: on Ctrl-D / closed stdin, rl.question() never settles, so
//      we race it against the interface 'close' event and resolve null.
//      Callers treat null as "cancel — write nothing".
//  (2) .secret(q): masks keystroke echo for API keys / passwords.
function defaultAsk() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    let muted = false;
    const onClose = new Promise((resolve) => rl.once('close', () => { closed = true; resolve(null); }));
    const origWrite = typeof rl._writeToOutput === 'function' ? rl._writeToOutput.bind(rl) : null;
    if (origWrite) {
        rl._writeToOutput = (s) => { if (!muted) origWrite(s); else if (/\n/.test(s)) origWrite('\n'); };
    }
    const core = async (q) => {
        if (closed) return null;
        try {
            return await Promise.race([rl.question(q + ' ').then((a) => a.trim()), onClose]);
        } catch (e) {
            if (e && e.code === 'ERR_USE_AFTER_CLOSE') return null;
            throw e;
        }
    };
    const fn = async (q) => core(q);
    fn.secret = async (q) => {
        process.stdout.write(q + ' ');
        muted = true;
        try { return await core(''); } finally { muted = false; }
    };
    fn.close = () => rl.close();
    return fn;
}

function realIsIgnored(p) {
    try { execFileSync('git', ['check-ignore', '-q', p], { stdio: 'ignore' }); return true; }
    catch (e) { return e.status === 1 ? false : null; } // 1 = not ignored; other/no-git = null (unknown)
}

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
    const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf-8'));
    const launchFn = deps.launchFn || (async (o) => (await import('cloakbrowser')).launch(o));
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
    // Write a secret file atomically (temp + rename) and lock it to 0600.
    // Never silently degrade: if chmod fails on a POSIX host, warn loudly.
    const writeSecret = (p, data) => {
        const tmp = `${p}.tmp`;
        fs.writeFileSync(tmp, data);
        try {
            fs.chmodSync(tmp, 0o600);
        } catch (e) {
            if (process.platform !== 'win32') {
                out(`⚠️ Could not chmod ${path.basename(p)} to 0600 (${e.code || e.message}); secrets may be world-readable — fix the file permissions manually.`);
            }
        }
        fs.renameSync(tmp, p);
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

        const runMode = (await ask1('Run mode? 1) Local single-host  2) Production/queue [1/2]:')) === '2' ? 'remote' : 'local';
        const answers = { mode: runMode };
        let liFailed = false;

        if (runMode === 'local') {
            answers.platforms = {};
            // LinkedIn (primary)
            for (let attempt = 1; attempt <= 3; attempt++) {
                const inp = await ask1('Paste LinkedIn cookie JSON (one line) OR a file path. For a multi-line paste, finish with a lone "." on its own line:');
                let blob = inp;
                const looksJson = inp.trimStart().startsWith('[') || inp.trimStart().startsWith('{');
                if (looksJson) {
                    let complete = true;
                    try { JSON.parse(inp); } catch { complete = false; }
                    if (!complete) {
                        const more = [];
                        let line;
                        while ((line = await ask('')) !== '.') {
                            if (line == null) break; // stdin EOF — stop accumulating, use what we have
                            more.push(line);
                        }
                        blob = [inp, ...more].join('\n');
                    }
                }
                try {
                    const cookies = parseCookieInput(blob, { readFile });
                    const v = validateLinkedinCookies(cookies);
                    if (!v.ok) { out(`  ✗ ${v.reason}`); if (attempt === 3) out('  (continuing without LinkedIn; re-run setup with a fresh export)'); continue; }
                    answers.platforms.linkedin = { credentials: cookies };
                    break;
                } catch (e) { out(`  ✗ ${e.message}`); if (attempt === 3) out('  (continuing without LinkedIn; re-run setup with a fresh export)'); }
            }
            liFailed = !answers.platforms.linkedin;
            // Optional extra platforms
            for (;;) {
                const more = (await ask1('Add another platform? [indeed/glassdoor/techfetch/done]:')).toLowerCase();
                if (more === '' || more === 'done') break;
                if (more === 'techfetch') {
                    const email = await ask1('  techfetch email:');
                    const password = await askSecret('  techfetch password:');
                    answers.platforms.techfetch = { email, password };
                } else if (more === 'indeed' || more === 'glassdoor') {
                    try { answers.platforms[more] = { credentials: parseCookieInput(await ask1(`  paste ${more} cookie JSON or path:`), { readFile }) }; }
                    catch (e) { out(`  ✗ ${e.message}`); }
                } else { out('  (unknown — choose indeed/glassdoor/techfetch/done)'); }
            }
            answers.headless = (await ask1('Run the browser HEADLESS? (LinkedIn default is headed) [y/N]:')).toLowerCase().startsWith('y');
            answers.strictEmpty = (await ask1('Enable loud block-detection now (SCRAPER_STRICT_EMPTY)? [y/N]:')).toLowerCase().startsWith('y');
            answers.scraperMode = (await ask1('SCRAPER_MODE [interactive/daemon] (default interactive):')) || 'interactive';
            answers.port = (await ask1('PORT (default 3001):')) || '3001';
        } else {
            answers.blacklight = { apiUrl: await askUrl('blacklight'), apiKey: await askSecret('blacklight apiKey:') };
            answers.scraperCredentials = { apiUrl: await askUrl('scraperCredentials'), apiKey: await askSecret('scraperCredentials apiKey:') };
            answers.scraperMode = (await ask1('SCRAPER_MODE [interactive/daemon] (default daemon):')) || 'daemon';
            answers.headless = (await ask1('Run the browser HEADLESS? [y/N]:')).toLowerCase().startsWith('y');
            answers.strictEmpty = (await ask1('Enable SCRAPER_STRICT_EMPTY now? [y/N]:')).toLowerCase().startsWith('y');
            answers.port = (await ask1('PORT (default 3001):')) || '3001';
        }

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
        writeSecret(credPath, JSON.stringify(credObj, null, 2) + '\n');
        writeSecret(envPath, envText);
        out(`✓ Wrote ${credPath}`);
        out(`✓ Wrote ${envPath}`);

        // Verify
        let result;
        if (runMode === 'local' && answers.platforms?.linkedin?.credentials) {
            out('Verifying LinkedIn cookies…');
            result = await verifyLocal({ launch: launchFn, cookies: answers.platforms.linkedin.credentials, headless: !!answers.headless });
        } else if (runMode === 'remote') {
            out('Verifying APIs…');
            result = await verifyRemote({ fetchFn, blacklight: answers.blacklight, scraperCredentials: answers.scraperCredentials });
        } else {
            result = {
                status: 'warn',
                message: liFailed
                    ? '⚠️ LinkedIn cookies failed validation; wrote config WITHOUT them — re-run `npm run setup` with a fresh export.'
                    : '⚠️ No LinkedIn cookies provided; skipped verify. Config written.',
            };
        }
        out(result.message);
        out(runMode === 'remote'
            ? 'Setup complete. Start with: npm start  — to run it as a managed service, see docs/MAC_SETUP.md or docs/WINDOWS_SETUP.md'
            : 'Setup complete. Start with: npm start');
        return 0;
    } catch (e) {
        if (e === CANCEL) return 1;
        throw e;
    } finally {
        if (typeof ask.close === 'function') ask.close();
    }
}
