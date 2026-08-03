// Local, per-host platform pause/resume overrides for the control panel.
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
    constructor({ filePath, fs: fsImpl = fs, knownPlatforms = PLATFORM_NAMES } = {}) {
        this._filePath = filePath ?? overridesPath();
        this._fs = fsImpl;
        this._known = new Set(knownPlatforms);
        this._paused = new Set(this.#load());
    }

    #load() {
        let raw;
        try {
            raw = this._fs.readFileSync(this._filePath, 'utf8');
        } catch {
            return []; // no file yet — nothing paused, the common case
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed?.paused)) return [];
            return parsed.paused
                .map((p) => String(p ?? '').toLowerCase())
                .filter((p) => this._known.has(p));
        } catch (error) {
            log.warn('Ignoring unreadable platform-overrides file', {
                path: this._filePath, err: error.message,
            });
            return [];
        }
    }

    #persist() {
        try {
            this._fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
            this._fs.writeFileSync(
                this._filePath,
                JSON.stringify({ paused: [...this._paused].sort() }, null, 2),
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
