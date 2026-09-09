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

// Extend-only. NEVER moves an expiry backward.
//
// ⚠️ TWO INDEPENDENT WRITERS SHARE THIS ONE MARKER FILE:
//   • scrapers/linkedin-rsc/session.js  — the session is dead, needs a re-login
//   • scrapers/linkedin-rsc/search-quota.js — LinkedIn is metering search
//
// Neither can see the other, and a plain `now + ms` write is last-one-wins, so
// they silently truncated each other. Production 2026-08-19/20 hit both
// directions: a 4h quota pause shortened to 30 minutes by an auth write (the
// host resumed scraping straight back into the wall the pause existed to
// avoid), and an auth marker overwritten by a quota pause, which took the
// `linkedin_auth_cooldown` alert with it — so the host sat idle with a dead
// session and no instruction to run `npm run linkedin:login`.
//
// Taking the LATER of the two expiries is the safe resolution: both writers are
// saying "do not scrape until at least T", and honouring the longer claim
// satisfies both. The cost of over-waiting is bounded and visible on the panel;
// the cost of under-waiting is scraping into a live block.
//
// This mirrors high-water.js, which refuses to move its mark backward for the
// same class of bug.
//
// Best-effort read: an unreadable or malformed existing marker resolves to "no
// existing claim" and the new expiry is written as-is, because failing to write
// a cooldown at all is worse than failing to extend one.
export function writeCooldownMarker({ writeFile, rename, now, cooldownMs: ms, path: markerPath, readFile }) {
    const requested = new Date(now.getTime() + ms);

    let expiry = requested;
    if (typeof readFile === 'function') {
        try {
            const existing = readCooldownMarker({ readFile, now, path: markerPath });
            if (existing.blockedUntil instanceof Date && existing.blockedUntil > requested) {
                expiry = existing.blockedUntil;
            }
        } catch { /* unreadable existing marker — write the new expiry as-is */ }
    }

    const tmp = `${markerPath}.tmp`;
    writeFile(tmp, expiry.toISOString());
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
