// CloakBrowser concurrent-session seats, one per licence key.
//
// CloakBrowser enforces its session limit PER LICENCE KEY, globally — not per
// process. Verified 2026-07-28: launching 2 browsers on one key leaves 1 alive
// and kills the other with "Target page, context or browser has been closed";
// 3 leaves 1. Two separate OS processes collide the same way, so process
// isolation is no escape. cloakbrowser's own error 76 says it plainly: "session
// limit reached for your plan."
//
// That matters because the orchestrator scrapes every platform of a role in
// parallel (src/queue/orchestrator.js), so a host whose allowlist holds four
// browser platforms was launching four browsers and losing three of them on
// every assignment.
//
// Passing a DIFFERENT `licenseKey` per launch gives each browser its own seat
// (verified: 2 keys → 2 concurrent browsers, both fine). This pool hands out
// those keys as leases, one at a time, and queues callers when every seat is
// taken — so parallel scraping is bounded instead of self-destructive.
//
// Config (keys NEVER committed): a git-ignored `config/cloakbrowser-keys.txt`,
// one key per line, or env CLOAKBROWSER_LICENSE_KEYS (comma/newline separated).
// No config → ONE seat carrying a null key, which lets cloakbrowser fall back to
// its own env/file resolution while still serialising launches.

import fs from 'node:fs';
import { createLogger } from '../logger/index.js';

const log = createLogger('license-pool');

const DEFAULT_FILE = 'config/cloakbrowser-keys.txt';

// One key per line; blanks and `#` comments ignored.
export function parseKeyLine(line) {
    const s = String(line ?? '').trim();
    if (!s || s.startsWith('#')) return null;
    return s;
}

export function loadLicenseKeys(env = process.env, deps = {}) {
    const readFileSync = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'));
    const existsSync = deps.existsSync ?? ((p) => fs.existsSync(p));
    let raw = '';
    if (env.CLOAKBROWSER_LICENSE_KEYS && String(env.CLOAKBROWSER_LICENSE_KEYS).trim()) {
        raw = String(env.CLOAKBROWSER_LICENSE_KEYS).replace(/,/g, '\n');
    } else {
        const file = env.CLOAKBROWSER_LICENSE_KEYS_FILE || DEFAULT_FILE;
        if (existsSync(file)) {
            try { raw = readFileSync(file); } catch { raw = ''; }
        }
    }
    const seen = new Set();
    const out = [];
    for (const key of raw.split('\n').map(parseKeyLine)) {
        if (key && !seen.has(key)) { seen.add(key); out.push(key); }
    }
    return out;
}

export class LicensePool {
    constructor(keys = []) {
        // No keys configured still means ONE seat: cloakbrowser resolves the key
        // itself from env or ~/.cloakbrowser/license.key, and serialising on a
        // single seat is what stops concurrent launches killing each other.
        this._seats = (keys.length ? keys : [null]).map((key) => ({ key, busy: false }));
        this._waiters = [];
    }

    get size() { return this._seats.length; }

    // Resolves with a lease as soon as a seat is free; queues FIFO otherwise.
    // Never rejects, and never hands out more leases than there are seats.
    async acquire() {
        const free = this._seats.find((s) => !s.busy);
        if (free) return this._lease(free);
        return new Promise((resolve) => { this._waiters.push(resolve); });
    }

    _lease(seat) {
        seat.busy = true;
        let released = false;
        return {
            key: seat.key,
            release: () => {
                if (released) return;   // idempotent: a double release must not free a seat twice
                released = true;
                this._free(seat);
            },
        };
    }

    _free(seat) {
        const next = this._waiters.shift();
        // Hand the seat straight to whoever is waiting rather than freeing and
        // re-taking it, so a queued caller can't lose the race to a new one.
        if (next) { next(this._lease(seat)); return; }
        seat.busy = false;
    }

    stats() {
        return {
            seats: this._seats.length,
            inUse: this._seats.filter((s) => s.busy).length,
            waiting: this._waiters.length,
        };
    }
}

let _singleton = null;
export function getLicensePool() {
    if (!_singleton) {
        const keys = loadLicenseKeys();
        _singleton = new LicensePool(keys);
        log.info('CloakBrowser session seats', {
            seats: _singleton.size,
            source: keys.length ? 'licence keys' : 'implicit (no keys configured)',
        });
    }
    return _singleton;
}
export function __resetLicensePoolForTest() { _singleton = null; }
