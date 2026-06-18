// Cross-run cooldown for TechFetch. When scrapeTechFetch's classifier returns
// network_error (a tiny "no shell" stub page — what techfetch.com serves a
// flagged IP, prod 2026-06-14), it writes an ISO-8601 expiry into
// ~/.blacklight-techfetch-cooldown. Subsequent calls (and the orchestrator's
// claim pre-flight via platform-cooldowns) short-circuit until it expires —
// no browser launch, no churn of doomed stub-page attempts.
//
// Mirror of src/core/{monster,indeed,glassdoor}-cooldown.js with TechFetch
// path + env. Intentional duplication; fold into a shared module if it grows.

import os from 'node:os';
import path from 'node:path';
import nodeFs from 'node:fs';

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;  // 60 min — matches the other platforms
const MARKER_FILENAME = '.blacklight-techfetch-cooldown';

export function cooldownPath() {
    return path.join(os.homedir(), MARKER_FILENAME);
}

export function cooldownMs(env = process.env) {
    const raw = env?.TECHFETCH_BLOCK_COOLDOWN_MIN;
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

// Convenience accessors using the real node:fs APIs.
export function defaultReadFile() { return (p, e) => nodeFs.readFileSync(p, e); }
export function defaultWriteFile() { return (p, d) => nodeFs.writeFileSync(p, d); }
export function defaultRename() { return (from, to) => nodeFs.renameSync(from, to); }
