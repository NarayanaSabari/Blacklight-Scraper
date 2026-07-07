#!/usr/bin/env node
// Reset (delete) LinkedIn persistent-profile directories so the next
// `npm run linkedin:login` starts from a clean login page instead of reusing a
// stale/wrong logged-in session.
//
// Interactive: run `npm run linkedin:reset`, pick which profile to wipe:
//   • a profile key (e.g. `li-acct-1`) — deletes that account's profile
//   • `default`                        — deletes the base (no-key) profile
//   • `all`                            — deletes every LinkedIn profile found
//
// Safety: refuses to run while the scraper is up (a profile dir held open by a
// live Chromium can't be deleted on Windows — you'd get a half-deleted dir).
// Stop it first: `nssm stop qp-scraper` (or close `npm start`).
//
// Dependency-light on purpose (node builtins + the shared prompt only) so it
// still works when the scraper stack itself is broken.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultAsk } from '../src/setup/io.js';

// Mirror of scrapers/linkedin.js::linkedInProfileDir — kept trivial and local
// so this maintenance tool has no heavy imports. The base-dir convention is
// stable; if it ever changes in linkedin.js, change it here too.
export function profileBaseDir(env = process.env, homedir = os.homedir()) {
    return env.LINKEDIN_PROFILE_DIR || path.join(homedir, '.blacklight-linkedin-profile');
}

// Same key-sanitization linkedin.js::profileDirFor applies when it CREATES a
// per-account dir, so a key the operator types matches the on-disk suffix.
function sanitizeKey(key) {
    return String(key).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '__');
}

// Pure: given the base profile dir and the entries present in its parent,
// return the existing LinkedIn profile dirs. The base dir is key '(default)';
// `<base>-<suffix>` dirs are key `<suffix>`. No I/O.
export function findProfiles(baseDir, siblingNames) {
    const baseName = path.basename(baseDir);
    const parent = path.dirname(baseDir);
    const out = [];
    for (const name of siblingNames) {
        if (name === baseName) out.push({ key: '(default)', dir: path.join(parent, name) });
        else if (name.startsWith(`${baseName}-`)) {
            out.push({ key: name.slice(baseName.length + 1), dir: path.join(parent, name) });
        }
    }
    return out;
}

// Pure: resolve which discovered profiles a selection targets.
//   ''            → [] (cancel)
//   'all'         → every profile
//   'default'     → the base (no-key) profile
//   '<key>'       → the profile whose sanitized key matches
export function selectProfiles(profiles, selection) {
    const s = String(selection ?? '').trim().toLowerCase();
    if (!s) return [];
    if (s === 'all') return profiles;
    if (s === 'default' || s === '(default)') return profiles.filter((p) => p.key === '(default)');
    const wanted = sanitizeKey(s).toLowerCase();
    return profiles.filter((p) => p.key.toLowerCase() === wanted);
}

// Is a scraper process already listening on the health port? Any response (even
// an error status) means something is up; a connection error means it's down.
export async function isScraperRunning(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
        return res.status > 0;
    } catch {
        return false;
    }
}

// The whole reset flow, with every side-effecting dependency injectable so it
// is testable end-to-end (fake `ask`, temp `env`, forced `checkRunning`) —
// mirrors how the setup wizard / ensure-api-key are structured. main() wires
// the real ones. Returns a process exit code.
export async function runReset(deps = {}) {
    const env = deps.env ?? process.env;
    const homedir = deps.homedir ?? os.homedir();
    const ask = deps.ask ?? defaultAsk();
    const checkRunning = deps.checkRunning ?? isScraperRunning;
    const out = deps.out ?? ((s) => console.log(s));
    const err = deps.err ?? ((s) => console.error(s));
    const rm = deps.rm ?? ((p) => fs.rmSync(p, { recursive: true, force: true }));

    try {
        const port = env.PORT || 3001;
        if (await checkRunning(port)) {
            err(
                `✗ The scraper is running (responded on :${port}). Stop it first — ` +
                `\`nssm stop qp-scraper\` or close \`npm start\` — then re-run. ` +
                `Deleting a profile that Chromium still has open fails on Windows.`,
            );
            return 2;
        }

        const base = profileBaseDir(env, homedir);
        const parent = path.dirname(base);
        let siblings = [];
        try {
            siblings = fs.readdirSync(parent);
        } catch {
            out(`No profile parent dir (${parent}). Nothing to reset.`);
            return 0;
        }

        const profiles = findProfiles(base, siblings);
        if (profiles.length === 0) {
            out(`No LinkedIn profiles found under ${parent}. Nothing to reset.`);
            return 0;
        }

        out('LinkedIn profiles found:');
        for (const p of profiles) out(`  ${p.key.padEnd(16)} ${p.dir}`);

        const sel = await ask('\nReset which? (profile key, "default", "all", blank = cancel):');
        const targets = selectProfiles(profiles, sel);
        if (targets.length === 0) {
            out('Nothing matched — cancelled. Nothing deleted.');
            return 0;
        }

        out('\nWill DELETE:');
        for (const t of targets) out(`  ${t.dir}`);
        const confirm = await ask('Proceed? [y/N]:');
        if (!confirm || String(confirm).trim().toLowerCase() !== 'y') {
            out('Cancelled — nothing deleted.');
            return 0;
        }

        for (const t of targets) {
            rm(t.dir);
            out(`✓ deleted ${t.dir}`);
        }
        out('\nDone. Run `npm run linkedin:login` to log in fresh.');
        return 0;
    } finally {
        if (typeof ask.close === 'function') ask.close();
    }
}

// Only run when invoked directly (not when imported by tests).
const _isMain = process.argv[1] &&
    (await import('url')).fileURLToPath(import.meta.url) === process.argv[1];
if (_isMain) {
    runReset()
        .then((code) => process.exit(code ?? 0))
        .catch((err) => { console.error('linkedin:reset failed:', err); process.exit(1); });
}
