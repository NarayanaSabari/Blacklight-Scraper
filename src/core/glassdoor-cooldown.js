// Cross-run cooldown for Glassdoor. When scrapeGlassdoor hits a Cloudflare
// soft-block, it writes an ISO-8601 expiry timestamp into
// ~/.blacklight-glassdoor-cooldown. Subsequent scrapeGlassdoor calls read the
// marker at entry and short-circuit with BlockedError if it's still in the
// future — no browser launch, no wasted timeout budget. Prod (2026-06-14)
// showed Glassdoor getting Cloudflare-blocked every ~60s cycle and retrying
// immediately, which hammers the IP; this backs it off after a block.
//
// Mirror of src/core/{monster,indeed}-cooldown.js with Glassdoor-specific path
// + env. Intentional duplication — the three could fold into a shared
// parameterized module in a follow-up cleanup.

import os from 'node:os';
import path from 'node:path';
import nodeFs from 'node:fs';

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;  // 60 min — matches Monster/Indeed
const MARKER_FILENAME = '.blacklight-glassdoor-cooldown';

export function cooldownPath() {
    return path.join(os.homedir(), MARKER_FILENAME);
}

export function cooldownMs(env = process.env) {
    const raw = env?.GLASSDOOR_BLOCK_COOLDOWN_MIN;
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
