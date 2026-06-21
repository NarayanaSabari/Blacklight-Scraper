// Cross-run cooldown for LinkedIn. When scrapeLinkedIn hits an AuthError
// (session not authenticated / cookies expired/rotated), it writes an
// ISO-8601 expiry timestamp into a marker file in the operator's home
// directory. The orchestrator reads this at claim time (via
// platform-cooldowns.js) and EXCLUDES linkedin from the claim until it
// expires — so a dead LinkedIn session backs off instead of the orchestrator
// firing dozens of concurrent scrapes that all instant-fail with
// "session lease unavailable (concurrent re-establish)" (observed
// 2026-06-21: ~5,000 fast-fails over 12h after cookies expired).
//
// Recovery is manual — `npm run linkedin:login` refreshes the on-disk
// profile; a time-based cooldown can't fix expired cookies, it only stops
// the churn until the operator re-logs in. The cooldown re-probes after it
// expires; if still expired it re-cools (a few errors per window, not
// thousands).
//
// All I/O is injectable so the helpers are pure-testable.

import os from 'node:os';
import path from 'node:path';
import nodeFs from 'node:fs';

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min
const MARKER_FILENAME = '.blacklight-linkedin-cooldown';

export function cooldownPath() {
    return path.join(os.homedir(), MARKER_FILENAME);
}

export function cooldownMs(env = process.env) {
    const raw = env?.LINKEDIN_AUTH_COOLDOWN_MIN;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_COOLDOWN_MS;
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOLDOWN_MS;
    return n * 60 * 1000;
}

export function readCooldownMarker({ readFile, now, path: markerPath }) {
    let raw;
    try { raw = readFile(markerPath, 'utf-8'); }
    catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) return { blockedUntil: null };
        throw e;
    }
    if (raw === null || raw === undefined) return { blockedUntil: null };
    const trimmed = String(raw).trim();
    if (!trimmed) return { blockedUntil: null };
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return { blockedUntil: null };
    const blockedUntil = new Date(ms);
    if (blockedUntil <= now) return { blockedUntil: null };
    return { blockedUntil };
}

export function writeCooldownMarker({ writeFile, rename, now, cooldownMs: ms, path: markerPath }) {
    const expiry = new Date(now.getTime() + ms).toISOString();
    const tmp = `${markerPath}.tmp`;
    writeFile(tmp, expiry);
    rename(tmp, markerPath);
}

export function isOnCooldown(marker, now) {
    return !!(marker && marker.blockedUntil instanceof Date && marker.blockedUntil > now);
}

// Convenience accessors using the real node:fs APIs. The orchestrator uses
// these; tests inject their own readFile / writeFile / rename.
export function defaultReadFile() { return (p, e) => nodeFs.readFileSync(p, e); }
export function defaultWriteFile() { return (p, d) => nodeFs.writeFileSync(p, d); }
export function defaultRename() { return (from, to) => nodeFs.renameSync(from, to); }
