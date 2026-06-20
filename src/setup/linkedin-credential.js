// Persist a LinkedIn credential to config/credentials.json from the cookies of
// a freshly logged-in browser profile.
//
// `npm run linkedin:login` logs the operator into the on-disk CloakBrowser
// profile, but the scraper ALSO needs a `linkedin` entry in credentials.json:
// the orchestrator leases a credential per (role, platform) for coordination
// before each scrape (linkedin-session.js #acquireLease), and in local mode
// that lease comes from credentials.json. Without it, every LinkedIn scrape
// fails with "No LinkedIn credential available from API" even though the
// profile is logged in. So after login we pull the session cookies, verify
// they prove a logged-in session (the `li_at` auth cookie), and write them.
//
// The stored cookies are NOT used for runtime auth (the on-disk profile is) —
// they exist to satisfy the lease and record which account is configured.
//
// All I/O is injectable so this is unit-testable without a browser/git/fs.
import fs from 'node:fs';
import path from 'node:path';
import { validateLinkedinCookies } from './cookie-input.js';
import { mergeCredentials } from './config-writer.js';
import { realIsIgnored, writeSecret as realWriteSecret } from './io.js';

const isLinkedinCookie = (c) =>
    c && typeof c.domain === 'string' && c.domain.toLowerCase().includes('linkedin');

export function saveLinkedinCredential(deps = {}) {
    const cwd = deps.cwd || process.cwd();
    const cookies = Array.isArray(deps.cookies) ? deps.cookies : [];
    const out = deps.out || ((s) => process.stdout.write(s + '\n'));
    const isIgnored = deps.isIgnored || realIsIgnored;
    const writeSecret = deps.writeSecret || realWriteSecret;

    const credPath = path.join(cwd, 'config', 'credentials.json');

    // Keep only LinkedIn cookies, then confirm a logged-in session.
    const liCookies = cookies.filter(isLinkedinCookie);
    const check = validateLinkedinCookies(liCookies);
    if (!check.ok) {
        out(`✗ Not logged in to LinkedIn (${check.reason}) — nothing saved. Log in fully (reach your feed), then re-run \`npm run linkedin:login\`.`);
        return { saved: false, reason: check.reason };
    }

    // Load existing config. An UNPARSEABLE file is left untouched — overwriting
    // it would destroy operator data we can't safely merge (e.g. the API key).
    let existing = {};
    if (fs.existsSync(credPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        } catch {
            out(`✗ ${credPath} is present but unparseable — not modifying it. Fix it or run \`npm run setup\`. Nothing saved.`);
            return { saved: false, reason: 'unparseable' };
        }
    }

    // git-ignore guard. false = confirmed tracked → refuse (real commit risk).
    // null = no git / can't tell → warn but proceed (the file is the intended
    // secret store; on a standalone host there's no repo to leak into).
    const ig = isIgnored(credPath);
    if (ig === false) {
        out(`✗ ${credPath} is NOT git-ignored — refusing to write a secret. Fix .gitignore first. Nothing saved.`);
        return { saved: false, reason: 'not_ignored' };
    }
    if (ig === null) {
        out(`⚠️ Could not confirm ${credPath} is git-ignored (no git / not a repo). Saving anyway.`);
    }

    const merged = mergeCredentials(existing, { linkedin: { credentials: liCookies } });
    try {
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        writeSecret(credPath, JSON.stringify(merged, null, 2) + '\n', out);
    } catch (e) {
        out(`✗ Failed to write ${credPath}: ${e.message} — nothing saved.`);
        return { saved: false, reason: 'write_failed' };
    }

    out(`✓ LinkedIn login verified and credential saved to ${credPath} (${liCookies.length} cookies). Run \`npm start\`.`);
    return { saved: true, count: liCookies.length };
}
