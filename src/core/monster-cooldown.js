// Cross-run cooldown for Monster. When scrapeMonster detects a DataDome
// soft-block, it writes an ISO-8601 expiry timestamp into a marker file in
// the operator's home directory. Subsequent scrapeMonster calls read the
// marker at entry and short-circuit with BlockedError if it's still in
// the future — no browser launch, no wasted timeout budget.
//
// All I/O is injectable so the helpers are pure-testable.

import os from 'node:os';
import path from 'node:path';
import nodeFs from 'node:fs';

// 60 min default. Empirically, DataDome's IP block on Monster has been
// observed lasting at least 50+ minutes once triggered (see the 60-min
// stress test on 2026-06-10 — 21 consecutive failures over the full
// hour). 30 was too aggressive and burned a ~25-second probe attempt
// every cycle while DataDome was still blocking. Operators who want to
// retry sooner can set MONSTER_BLOCK_COOLDOWN_MIN.
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const MARKER_FILENAME = '.blacklight-monster-cooldown';

export function cooldownPath() {
    return path.join(os.homedir(), MARKER_FILENAME);
}

export function cooldownMs(env = process.env) {
    const raw = env?.MONSTER_BLOCK_COOLDOWN_MIN;
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
