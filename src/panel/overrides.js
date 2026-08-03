// Local, per-host platform overrides for the control panel: pause/resume, and
// scrape cadence (how often a platform may start a fresh sweep).
//
// An operator pausing a platform here is a HOST-local decision — "this
// host's proxy/credential for glassdoor is burnt, stop claiming it until I
// fix it" — distinct from the backend's own platform_allowlist (which scopes
// what a scraper API key is entitled to at all). Persisted to
// config/platform-overrides.json (git-ignored — this is host state, not
// config to ship) so a pause survives a restart.

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger/index.js';
import { PLATFORM_NAMES } from '../scrapers/registry.js';

const log = createLogger('panel:overrides');

// Built-in sweep cadences, in minutes. Only Indeed is slowed by default:
// measured 2026-08-03 it re-scraped every role every ~5.1 min for a 0.29%
// import rate (344 scraped records per import, vs Dice's 4), because 69.4% of
// what came back was `duplicate_platform_id`. Import volume tracks how fast
// Indeed publishes, not how often we ask. Every other platform keeps its
// historical every-cycle behaviour.
//
// Precedence: an explicit value in platform-overrides.json (set from the
// control panel) > env SCRAPE_INTERVAL_<PLATFORM>_MINUTES > this default.
// A stored 0 means "the operator deliberately turned the cadence OFF" and is
// NOT re-defaulted.
export const DEFAULT_SWEEP_INTERVAL_MINUTES = Object.freeze({ indeed: 60 });

function envInterval(platform, env = process.env) {
    const raw = env?.[`SCRAPE_INTERVAL_${platform.toUpperCase()}_MINUTES`];
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function overridesPath(env = process.env) {
    return env?.PLATFORM_OVERRIDES_FILE || path.join('config', 'platform-overrides.json');
}

export class UnknownPlatformError extends Error {
    constructor(name) {
        super(`Unknown platform: ${name}`);
        this.name = 'UnknownPlatformError';
    }
}

export class PlatformOverrides {
    constructor({ filePath, fs: fsImpl = fs, knownPlatforms = PLATFORM_NAMES, env = process.env } = {}) {
        this._env = env;
        this._filePath = filePath ?? overridesPath();
        this._fs = fsImpl;
        this._known = new Set(knownPlatforms);
        const loaded = this.#load();
        this._paused = new Set(loaded.paused);
        // platform -> minutes between sweeps. Absent/0 = claim every cycle
        // (the historical behaviour), so this is purely additive.
        this._intervals = new Map(Object.entries(loaded.intervals));
    }

    #load() {
        const empty = { paused: [], intervals: {} };
        let raw;
        try {
            raw = this._fs.readFileSync(this._filePath, 'utf8');
        } catch {
            return empty; // no file yet — nothing overridden, the common case
        }
        try {
            const parsed = JSON.parse(raw);
            const paused = Array.isArray(parsed?.paused)
                ? parsed.paused.map((p) => String(p ?? '').toLowerCase()).filter((p) => this._known.has(p))
                : [];
            const intervals = {};
            for (const [name, value] of Object.entries(parsed?.intervals ?? {})) {
                const platform = String(name ?? '').toLowerCase();
                const minutes = Number(value);
                if (this._known.has(platform) && Number.isFinite(minutes) && minutes >= 0) {
                    intervals[platform] = minutes;
                }
            }
            return { paused, intervals };
        } catch (error) {
            log.warn('Ignoring unreadable platform-overrides file', {
                path: this._filePath, err: error.message,
            });
            return empty;
        }
    }

    #persist() {
        try {
            this._fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
            this._fs.writeFileSync(
                this._filePath,
                JSON.stringify({
                    paused: [...this._paused].sort(),
                    intervals: Object.fromEntries([...this._intervals.entries()].sort()),
                }, null, 2),
            );
        } catch (error) {
            // Best-effort: the in-memory pause is still honoured this run —
            // it just won't survive a restart. Loud enough to notice, not
            // loud enough to fail the request.
            log.warn('Failed to persist platform overrides', { err: error.message });
        }
    }

    isKnown(platform) {
        return this._known.has(String(platform ?? '').toLowerCase());
    }

    isPaused(platform) {
        return this._paused.has(String(platform ?? '').toLowerCase());
    }

    pausedList() {
        return [...this._paused].sort();
    }

    pause(platform) {
        const name = String(platform ?? '').toLowerCase();
        if (!this.isKnown(name)) throw new UnknownPlatformError(name);
        const changed = !this._paused.has(name);
        this._paused.add(name);
        if (changed) this.#persist();
        return this.pausedList();
    }

    resume(platform) {
        const name = String(platform ?? '').toLowerCase();
        if (!this.isKnown(name)) throw new UnknownPlatformError(name);
        const changed = this._paused.delete(name);
        if (changed) this.#persist();
        return this.pausedList();
    }

    /**
     * Minutes between sweeps for a platform, or null for "every cycle".
     * Read live on each queue cycle, so a panel change needs no restart.
     */
    intervalMinutes(platform) {
        const name = String(platform ?? '').toLowerCase();
        // An explicit entry wins, including a deliberate 0 ("every cycle").
        if (this._intervals.has(name)) {
            const stored = this._intervals.get(name);
            return stored > 0 ? stored : null;
        }
        const fromEnv = envInterval(name, this._env);
        if (fromEnv !== undefined) return fromEnv > 0 ? fromEnv : null;
        return DEFAULT_SWEEP_INTERVAL_MINUTES[name] ?? null;
    }

    intervalsMap() {
        return Object.fromEntries([...this._intervals.entries()].sort());
    }

    /** Set (minutes > 0) or clear (null/0) a platform's sweep cadence. */
    setInterval(platform, minutes) {
        const name = String(platform ?? '').toLowerCase();
        if (!this.isKnown(name)) throw new UnknownPlatformError(name);
        const value = Number(minutes);
        if (!Number.isFinite(value) || value <= 0) {
            // Store 0 rather than deleting: an operator turning the cadence off
            // must not silently fall back to the built-in default.
            const changed = this._intervals.get(name) !== 0;
            this._intervals.set(name, 0);
            if (changed) this.#persist();
            return this.intervalsMap();
        }
        const changed = this._intervals.get(name) !== value;
        this._intervals.set(name, value);
        if (changed) this.#persist();
        return this.intervalsMap();
    }

    // Drop locally-paused platforms from a candidate list. Anything that
    // isn't a recognized platform name passes through untouched — this is a
    // pure filter, not a validator.
    filterAllowed(platforms) {
        if (!Array.isArray(platforms)) return platforms;
        return platforms.filter((p) => !this.isPaused(p));
    }
}

let _singleton = null;
export function getPlatformOverrides() {
    if (!_singleton) _singleton = new PlatformOverrides();
    return _singleton;
}
export function __resetPlatformOverridesForTest() {
    _singleton = null;
}
