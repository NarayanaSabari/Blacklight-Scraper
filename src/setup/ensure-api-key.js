// First-run API-key preflight for `npm start`.
//
// The scraper needs a Blacklight API key (config/credentials.json →
// blacklight.apiKey) to pull the queue and push telemetry. Before this,
// `npm start` with no key just logged a warning and booted with the queue
// disabled — operators had to know to run `npm run setup` first. This
// preflight closes that gap: if the key is missing AND we have an interactive
// terminal, prompt for it (masked), save it, and continue booting.
//
// Design constraints:
//  - Daemon-safe: with no TTY (launchd / systemd / NSSM / CI) it NEVER blocks
//    on a prompt — it returns and the server boots with the queue disabled,
//    exactly as before.
//  - The URL is fixed to the production API; only the key is prompted for.
//    (Need a different URL? Use the full `npm run setup`.)
//  - All I/O is injectable so this is unit-testable without a TTY/git/fs.
import fs from 'node:fs';
import path from 'node:path';
import { mergeCredentials } from './config-writer.js';
import { defaultAsk, realIsIgnored, writeSecret as realWriteSecret } from './io.js';

export const DEFAULT_BLACKLIGHT_API_URL = 'https://api.qpeakhire.com';

// A key is "configured" only if it is a non-empty string that isn't one of the
// `REPLACE_ME…` placeholders shipped in config/credentials.example.json.
function hasRealKey(credentials) {
    const key = credentials?.blacklight?.apiKey;
    return typeof key === 'string' && key.trim() !== '' && !key.startsWith('REPLACE_ME');
}

export async function ensureApiKey(deps = {}) {
    const cwd = deps.cwd || process.cwd();
    const ask = deps.ask || defaultAsk();
    const out = deps.out || ((s) => process.stdout.write(s + '\n'));
    const isIgnored = deps.isIgnored || realIsIgnored;
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
    const writeSecret = deps.writeSecret || realWriteSecret;
    const apiUrl = deps.apiUrl || DEFAULT_BLACKLIGHT_API_URL;

    const credPath = path.join(cwd, 'config', 'credentials.json');

    // Load the existing file (if any). An UNPARSEABLE file is left untouched —
    // overwriting it would destroy operator data we can't safely merge.
    let existing = {};
    if (fs.existsSync(credPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        } catch {
            out(`⚠️ ${credPath} is present but unparseable — not modifying it. Fix it or run \`npm run setup\`. Starting with the queue disabled.`);
            return { configured: false, wrote: false };
        }
    }

    if (hasRealKey(existing)) return { configured: true, wrote: false };

    // No usable key. Without a terminal we must not block — boot with the
    // queue disabled (unchanged behaviour for daemon/CI hosts).
    if (!isTTY) {
        out('Blacklight API key not configured and no interactive terminal — starting with the queue disabled. Run `npm run setup`, or `npm start` from a terminal, to configure it.');
        return { configured: false, wrote: false };
    }

    out('── Blacklight API key not configured ──');
    out(`The scraper needs an API key to pull the queue and push telemetry (target: ${apiUrl}).`);

    const askSecret = (q) => (typeof ask.secret === 'function' ? ask.secret(q) : ask(q));
    let apiKey = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const v = await askSecret('Enter your Blacklight scraper API key:');
        if (v == null) { // EOF / closed stdin
            out('Cancelled (input closed) — starting with the queue disabled.');
            return { configured: false, wrote: false };
        }
        const trimmed = String(v).trim();
        if (trimmed) { apiKey = trimmed; break; }
        out('  ✗ key cannot be empty — try again');
    }
    if (!apiKey) {
        out('No key entered — starting with the queue disabled.');
        return { configured: false, wrote: false };
    }

    // git-ignore guard. false = confirmed tracked → refuse (real commit risk).
    // null = no git / can't tell (a standalone deploy host) → warn but proceed,
    // since credentials.json is the intended secret store and there's no repo
    // to leak into. true = ignored → proceed.
    const ig = isIgnored(credPath);
    if (ig === false) {
        out(`✗ ${credPath} is NOT git-ignored — refusing to write a secret. Fix .gitignore first, then re-run. Starting with the queue disabled.`);
        return { configured: false, wrote: false };
    }
    if (ig === null) {
        out(`⚠️ Could not confirm ${credPath} is git-ignored (no git / not a repo). Saving anyway — if this directory is version-controlled, ensure the file is ignored.`);
    }

    const merged = mergeCredentials(existing, { blacklight: { apiUrl, apiKey } });
    try {
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        writeSecret(credPath, JSON.stringify(merged, null, 2) + '\n', out);
    } catch (e) {
        out(`⚠️ Failed to write ${credPath}: ${e.message} — starting with the queue disabled.`);
        return { configured: false, wrote: false };
    }
    out(`✓ Saved Blacklight API key to ${credPath}`);
    return { configured: true, wrote: true };
}
