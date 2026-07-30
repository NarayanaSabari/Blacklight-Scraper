// Preflight run before a headed LinkedIn login: make sure CloakBrowser is
// current and licensed before the browser window opens.
//
// Why this exists. LinkedIn's login served an unsolvable reCAPTCHA loop on
// 2026-07-30. The cause is the stealth browser being visibly out of date:
// CloakBrowser's UNLICENSED binary is Chromium **v146** while the current
// release is **v150**, and its own startup banner says so:
//
//     Running the free binary (v146). The latest binary (v150) is free too,
//     with 1 concurrent session. Get your key: run `cloakbrowser login`
//
// A browser presenting a four-major-versions-stale Chromium to a login page
// that fingerprints browser build is exactly what a CAPTCHA wall is for. The
// newest binary is FREE — it just needs a key — so the single highest-value
// thing this preflight does is notice a missing key and ask for one.
//
// It also updates the npm package itself: a stale CloakBrowser pin has already
// cost this project once (the ^0.3.28 -> ^0.5.2 bump was the fix for Monster
// being blocked), so "is the pin current" is the first question to ask of any
// new block, not the last.
//
// Everything impure is injected so the decision logic is unit-testable without
// a network, an npm install, or a real prompt.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadLicenseKeys } from '../core/license-pool.js';
import { writeSecret, realIsIgnored } from './io.js';

export const KEYS_FILE = 'config/cloakbrowser-keys.txt';
export const SIGNUP_URL = 'https://cloakbrowser.dev/free';

// npm is a .cmd shim on Windows; execFile does not go through a shell.
export function npmBin(platform = process.platform) {
    return platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** "0.5.10" -> [0,5,10]. Non-numeric / missing parts become 0. */
export function parseVersion(v) {
    return String(v ?? '')
        .trim()
        .replace(/^v/, '')
        .split('.')
        .slice(0, 3)
        .map((n) => {
            const i = Number.parseInt(n, 10);
            return Number.isFinite(i) ? i : 0;
        })
        .concat([0, 0, 0])
        .slice(0, 3);
}

/**
 * Is `candidate` a newer version than `current`?
 *
 * Numeric per-component compare, so 0.5.10 > 0.5.9 (a plain string compare
 * gets that backwards, which is how a stale pin hides).
 */
export function isNewerVersion(candidate, current) {
    if (!candidate || !current) return false;
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
    }
    return false;
}

/**
 * Shape check for a pasted licence key. Deliberately loose — CloakBrowser owns
 * the real validation and we must not reject a format they change later. This
 * only catches obvious paste accidents (empty, a URL, a shell prompt, spaces).
 */
export function looksLikeLicenseKey(value) {
    const s = String(value ?? '').trim();
    if (s.length < 8 || s.length > 200) return false;
    if (/\s/.test(s)) return false;                 // keys are one token
    if (/^https?:\/\//i.test(s)) return false;      // pasted the signup URL
    if (!/^[A-Za-z0-9._:-]+$/.test(s)) return false;
    return true;
}

/**
 * The key CloakBrowser writes itself via `cloakbrowser login`. Checked so an
 * already-licensed host is not asked for a key it does not need.
 */
export function readHomeLicenseKey(deps = {}) {
    const readFileSync = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'));
    const homedir = deps.homedir ?? (() => os.homedir());
    try {
        const v = String(readFileSync(path.join(homedir(), '.cloakbrowser', 'license.key'))).trim();
        return v || null;
    } catch {
        return null;
    }
}

export function readInstalledVersion(deps = {}) {
    const readFileSync = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'));
    const cwd = deps.cwd ?? process.cwd();
    try {
        const p = path.join(cwd, 'node_modules', 'cloakbrowser', 'package.json');
        return JSON.parse(readFileSync(p)).version ?? null;
    } catch {
        return null;
    }
}

export function readLatestVersion(deps = {}) {
    const exec = deps.exec ?? ((cmd, args) =>
        execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }));
    try {
        return String(exec(npmBin(), ['view', 'cloakbrowser', 'version'])).trim() || null;
    } catch {
        return null;   // offline / registry blocked → skip the update, never fail the login
    }
}

/**
 * Ensure a CloakBrowser licence key is configured, prompting for one if not.
 *
 * Returns {status, keyCount}:
 *   'already'   already configured, nothing asked
 *   'saved'     operator pasted a key; written to KEYS_FILE and exported for
 *               this process so the login launch picks it up without a restart
 *   'declined'  operator pressed Enter / cancelled — free tier, stale binary
 *   'invalid'   pasted something that is clearly not a key
 */
export async function ensureLicenseKey({ ask, env = process.env, cwd = process.cwd(), out = console.log, deps = {} } = {}) {
    const load = deps.loadLicenseKeys ?? loadLicenseKeys;
    const write = deps.writeSecret ?? writeSecret;
    const isIgnored = deps.isIgnored ?? realIsIgnored;

    const existing = load(env);
    if (existing.length > 0) return { status: 'already', keyCount: existing.length };

    // license-pool only reads env / the repo keys file, but CloakBrowser ALSO
    // resolves a key from ~/.cloakbrowser/license.key (written by
    // `cloakbrowser login`). A host licensed that way is already fine, so do not
    // nag for a key it does not need.
    const homeKey = deps.readHomeLicenseKey ?? readHomeLicenseKey;
    if (homeKey()) {
        out('  CloakBrowser is licensed via ~/.cloakbrowser/license.key.');
        return { status: 'already', keyCount: 1 };
    }

    out('');
    out('  No CloakBrowser licence key is configured.');
    out('  Unlicensed, CloakBrowser runs Chromium v146 while the current build is v150.');
    out('  A login page that fingerprints browser version will challenge that — this is the');
    out('  most likely reason LinkedIn is serving you a reCAPTCHA loop.');
    out(`  A key is FREE (1 concurrent session): ${SIGNUP_URL}`);
    out('');

    const answer = await ask.secret('CloakBrowser licence key (paste, or press Enter to stay on the free binary):');
    if (answer === null || String(answer).trim() === '') {
        out('  Continuing on the unlicensed v146 binary — expect challenges.');
        return { status: 'declined', keyCount: 0 };
    }
    const key = String(answer).trim();
    if (!looksLikeLicenseKey(key)) {
        out('  That does not look like a licence key (expected one token, no spaces). Nothing written.');
        return { status: 'invalid', keyCount: 0 };
    }

    const target = path.join(cwd, KEYS_FILE);
    // The key is a secret: refuse to write it somewhere git would pick it up.
    const ignored = isIgnored(KEYS_FILE);
    if (ignored === false) {
        out(`  ✗ ${KEYS_FILE} is NOT git-ignored — refusing to write a secret there.`);
        return { status: 'invalid', keyCount: 0 };
    }
    const mkdir = deps.mkdirSync ?? ((p) => fs.mkdirSync(p, { recursive: true }));
    try {
        mkdir(path.dirname(target));
        write(target, `${key}\n`, out);
    } catch (e) {
        // Never lose the login to a filesystem problem — the key is still applied
        // in-process below, so this run is licensed even if it did not persist.
        out(`  ⚠️ Could not persist the key to ${KEYS_FILE} (${e?.code ?? e?.message}); applying it to this run only.`);
        env.CLOAKBROWSER_LICENSE_KEYS = key;
        return { status: 'saved-transient', keyCount: 1 };
    }
    // Export for THIS process so the login below is licensed without a restart.
    env.CLOAKBROWSER_LICENSE_KEYS = key;
    out(`  ✓ Key saved to ${KEYS_FILE} (0600) and applied to this session.`);
    return { status: 'saved', keyCount: 1 };
}

/**
 * Update the cloakbrowser npm package to latest when one is available.
 *
 * Returns {status, from, to}: 'current' | 'updated' | 'failed' | 'unknown'
 * (unknown = could not reach the registry; the login still proceeds).
 */
export function updateCloakBrowser({ cwd = process.cwd(), out = console.log, deps = {} } = {}) {
    const installed = (deps.readInstalledVersion ?? readInstalledVersion)({ cwd });
    const latest = (deps.readLatestVersion ?? readLatestVersion)({});

    if (!latest) {
        out(`  CloakBrowser ${installed ?? 'unknown'} — could not reach the npm registry, skipping update check.`);
        return { status: 'unknown', from: installed, to: null };
    }
    if (!isNewerVersion(latest, installed)) {
        out(`  CloakBrowser ${installed} is current.`);
        return { status: 'current', from: installed, to: latest };
    }

    out(`  CloakBrowser ${installed} -> ${latest} available; installing...`);
    const exec = deps.exec ?? ((cmd, args) =>
        execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'inherit', 'inherit'] }));
    try {
        exec(npmBin(), ['install', `cloakbrowser@${latest}`, '--save']);
        out(`  ✓ CloakBrowser updated to ${latest}.`);
        return { status: 'updated', from: installed, to: latest };
    } catch (e) {
        out(`  ⚠️ Update failed (${e?.message ?? e}); continuing on ${installed}.`);
        return { status: 'failed', from: installed, to: latest };
    }
}

/**
 * Download the stealth Chromium now, so a headed login does not sit on a blank
 * window for the length of a ~535 MB download. Never fatal.
 */
export async function prewarmBinary({ out = console.log, deps = {} } = {}) {
    const ensure = deps.ensureBinary ?? (async () => {
        const m = await import('cloakbrowser');
        if (typeof m.ensureBinary === 'function') await m.ensureBinary();
    });
    try {
        out('  Ensuring the stealth Chromium binary is present...');
        await ensure();
        out('  ✓ Binary ready.');
        return { status: 'ready' };
    } catch (e) {
        out(`  ⚠️ Could not pre-warm the binary (${e?.message ?? e}); the login launch will fetch it.`);
        return { status: 'failed' };
    }
}

/**
 * Full preflight. Licence FIRST — an update should be installed and then run
 * licensed, and the key is what unlocks the current binary in the first place.
 */
export async function cloakbrowserPreflight({ ask, env = process.env, cwd = process.cwd(), out = console.log, deps = {} } = {}) {
    out('CloakBrowser preflight');
    const license = await ensureLicenseKey({ ask, env, cwd, out, deps });
    const update = (deps.updateCloakBrowser ?? updateCloakBrowser)({ cwd, out, deps });
    const binary = await (deps.prewarmBinary ?? prewarmBinary)({ out, deps });
    out('');
    return { license, update, binary };
}
