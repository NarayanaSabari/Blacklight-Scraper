// Setup wizard orchestration. ALL I/O is injectable so this is unit-
// testable without a TTY/browser/network. Defaults wire the real ones.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseCookieInput, validateLinkedinCookies } from './cookie-input.js';
import { buildCredentialsJson, buildDotEnv, mergeCredentials, mergeDotEnv } from './config-writer.js';
import { verifyLocal, verifyRemote } from './verify.js';

function defaultAsk() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return Object.assign(async (q) => (await rl.question(q + ' ')).trim(), { close: () => rl.close() });
}
function realIsIgnored(p) {
    try { execFileSync('git', ['check-ignore', '-q', p], { stdio: 'ignore' }); return true; }
    catch (e) { return e.status === 1 ? false : null; } // 1 = not ignored; other/no-git = null (unknown)
}
function mask(v) { const s = String(v ?? ''); return s.length > 4 ? `••••${s.slice(-4)}` : '••••'; }

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
    try {
        out('── Unified Job Scraper — setup ──');
        out('Run via: `npm run setup`  (note: `npm start --setup` swallows the flag; use `npm start -- --setup`).');

        // Idempotency pre-check
        let mode = 'overwrite';
        const credExists = fs.existsSync(credPath);
        const envExists = fs.existsSync(envPath);
        if (credExists || envExists) {
            if (credExists) {
                try {
                    const ex = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
                    out(`Existing config/credentials.json keys: ${Object.keys(ex).map((k) => `${k}(${mask(JSON.stringify(ex[k]))})`).join(', ')}`);
                } catch { out('Existing config/credentials.json present (unparseable).'); }
            }
            if (envExists) out('Existing .env present.');
            mode = (await ask('Existing config found. [merge / overwrite / cancel]?')).toLowerCase();
            if (mode !== 'merge' && mode !== 'overwrite') { out('Cancelled — nothing written.'); return 1; }
        }

        const runMode = (await ask('Run mode? 1) Local single-host  2) Production/queue [1/2]:')) === '2' ? 'remote' : 'local';
        const answers = { mode: runMode };

        if (runMode === 'local') {
            answers.platforms = {};
            // LinkedIn (primary)
            for (let attempt = 1; attempt <= 3; attempt++) {
                const inp = await ask('Paste LinkedIn cookie JSON (one line) OR a file path. For a multi-line paste, finish with a lone "." on its own line:');
                let blob = inp;
                const looksJson = inp.trimStart().startsWith('[') || inp.trimStart().startsWith('{');
                if (looksJson) {
                    let complete = true;
                    try { JSON.parse(inp); } catch { complete = false; }
                    if (!complete) {
                        const more = [];
                        let line;
                        while ((line = await ask('')) !== '.') {
                            if (line == null) break; // stdin EOF — stop accumulating
                            more.push(line);
                        }
                        blob = [inp, ...more].join('\n');
                    }
                }
                try {
                    const cookies = parseCookieInput(blob, { readFile });
                    const v = validateLinkedinCookies(cookies);
                    if (!v.ok) { out(`  ✗ ${v.reason}`); if (attempt === 3) out('  (continuing; verify will likely fail)'); continue; }
                    answers.platforms.linkedin = { credentials: cookies };
                    break;
                } catch (e) { out(`  ✗ ${e.message}`); if (attempt === 3) out('  (continuing; verify will likely fail)'); }
            }
            // Optional extra platforms
            let more;
            while ((more = (await ask('Add another platform? [indeed/glassdoor/techfetch/done]:')).toLowerCase()) !== 'done' && more) {
                if (more === 'techfetch') {
                    const email = await ask('  techfetch email:');
                    const password = await ask('  techfetch password:');
                    answers.platforms.techfetch = { email, password };
                } else if (more === 'indeed' || more === 'glassdoor') {
                    try { answers.platforms[more] = { credentials: parseCookieInput(await ask(`  paste ${more} cookie JSON or path:`), { readFile }) }; }
                    catch (e) { out(`  ✗ ${e.message}`); }
                } else { out('  (unknown — choose indeed/glassdoor/techfetch/done)'); }
            }
            answers.headless = (await ask('Run the browser HEADLESS? (LinkedIn default is headed) [y/N]:')).toLowerCase().startsWith('y');
            answers.strictEmpty = (await ask('Enable loud block-detection now (SCRAPER_STRICT_EMPTY)? [y/N]:')).toLowerCase().startsWith('y');
            answers.scraperMode = (await ask('SCRAPER_MODE [interactive/daemon] (default interactive):')) || 'interactive';
            answers.port = (await ask('PORT (default 3001):')) || '3001';
        } else {
            answers.blacklight = { apiUrl: (await ask('blacklight apiUrl:')).replace(/\/$/, ''), apiKey: await ask('blacklight apiKey:') };
            answers.scraperCredentials = { apiUrl: (await ask('scraperCredentials apiUrl:')).replace(/\/$/, ''), apiKey: await ask('scraperCredentials apiKey:') };
            answers.scraperMode = (await ask('SCRAPER_MODE [interactive/daemon] (default daemon):')) || 'daemon';
            answers.headless = (await ask('Run the browser HEADLESS? [y/N]:')).toLowerCase().startsWith('y');
            answers.strictEmpty = (await ask('Enable SCRAPER_STRICT_EMPTY now? [y/N]:')).toLowerCase().startsWith('y');
            answers.port = (await ask('PORT (default 3001):')) || '3001';
        }

        // git-ignore guard
        for (const p of [credPath, envPath]) {
            if (isIgnored(p) === false) { out(`✗ ${p} is NOT git-ignored — refusing to write secrets. Fix .gitignore first.`); return 1; }
        }

        // Build + (optionally) merge + write
        let credObj = buildCredentialsJson(answers);
        let envText = buildDotEnv(answers);
        if (mode === 'merge' && credExists) {
            try { credObj = mergeCredentials(JSON.parse(fs.readFileSync(credPath, 'utf-8')), credObj); } catch { /* keep new */ }
        }
        if (mode === 'merge' && envExists) {
            try { envText = mergeDotEnv(fs.readFileSync(envPath, 'utf-8'), envText); } catch { /* keep new */ }
        }
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        const writeOpts = { mode: 0o600 };
        try { fs.writeFileSync(credPath, JSON.stringify(credObj, null, 2) + '\n', writeOpts); } catch { fs.writeFileSync(credPath, JSON.stringify(credObj, null, 2) + '\n'); }
        try { fs.writeFileSync(envPath, envText, writeOpts); } catch { fs.writeFileSync(envPath, envText); }
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
            result = { status: 'warn', message: '⚠️ No LinkedIn cookies provided; skipped verify. Config written.' };
        }
        out(result.message);
        out('Setup complete. Start with: npm start');
        return 0;
    } finally {
        if (typeof ask.close === 'function') ask.close();
    }
}
