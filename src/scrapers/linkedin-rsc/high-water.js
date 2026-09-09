// Per-query high-water marks for the LinkedIn RSC transport.
//
// WHY THIS EXISTS
// LinkedIn's finest date filter is `past-24h`, so every sweep of a role
// re-downloads the same 24 hours of posts. Measured on production over 6 days:
// 0.30–2.85% of everything scraped was actually imported, and the single
// largest skip reason was `duplicate_title_company_location`. We were paying
// ten pages of requests per role to discover one or two new posts.
//
// That cost is what capped freshness. LinkedIn answers a *repeated* identical
// search with a positive "no results" flag, so the way to scrape more often is
// not to ask harder — it is to ask for less each time. Remembering the newest
// post we already have lets a sweep stop as soon as it reaches known ground,
// which turns a ten-page pass into a one-page pass and buys back the request
// budget that higher cadence needs.
//
// Marks are HOST-LOCAL state, like config/platform-overrides.json: they
// describe what this host has already forwarded, not configuration to ship.
// Losing the file is harmless — every query simply runs full once and re-marks.

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../logger/index.js';

const log = createLogger('linkedin-rsc:high-water');

// Marks older than this are dropped on write. A query nobody runs any more
// should not keep a mark alive forever, and a mark far outside LinkedIn's
// 24h search window is useless anyway — the post it names has long since
// fallen out of every result set.
export const MARK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function highWaterPath(env = process.env) {
    return env?.LINKEDIN_HIGHWATER_FILE
        || path.join('config', 'linkedin-highwater.json');
}

/**
 * Stable key for a search. `datePosted` is part of the identity: widening the
 * window is a different search and must not inherit a narrower window's mark,
 * or the extra results would be skipped as already-seen on the first run.
 */
export function markKey(keywords, datePosted) {
    return `${datePosted ?? ''}::${keywords ?? ''}`;
}

/**
 * Compare two LinkedIn activity ids as numbers.
 *
 * Activity ids encode a timestamp in their high bits and are monotonic, so
 * "newer" is just "numerically greater". They exceed Number.MAX_SAFE_INTEGER,
 * so this MUST be BigInt — Number() rounds them and makes distinct recent
 * posts compare equal, which would silently drop new results.
 *
 * @returns {boolean} true when `id` is strictly newer than `mark`
 */
export function isNewerThan(id, mark) {
    if (!mark) return true;           // no mark yet → everything is new
    if (!id) return false;            // unusable id → do not treat as new
    try {
        return BigInt(String(id)) > BigInt(String(mark));
    } catch {
        // A non-numeric id (shouldn't happen) is treated as new so we fail
        // toward scraping too much rather than silently skipping posts.
        return true;
    }
}

/** Newest of a set of activity ids, or null. */
export function newestActivityId(ids) {
    let best = null;
    for (const id of ids) {
        if (isNewerThan(id, best)) best = id;
    }
    return best;
}

export class HighWaterStore {
    constructor({ filePath, fs: fsImpl = fs, now = () => Date.now(), ttlMs = MARK_TTL_MS } = {}) {
        this._filePath = filePath ?? highWaterPath();
        this._fs = fsImpl;
        this._now = now;
        this._ttlMs = ttlMs;
        this._marks = this.#load();
    }

    #load() {
        try {
            const raw = this._fs.readFileSync(this._filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            // Missing file is the normal first-run case. A corrupt file is
            // logged but must not stop scraping — the cost of ignoring it is
            // one full pass, the cost of throwing is no scraping at all.
            if (error?.code !== 'ENOENT') {
                log.warn('Could not read high-water marks — starting empty', {
                    file: this._filePath, err: error?.message,
                });
            }
            return {};
        }
    }

    #persist() {
        const cutoff = this._now() - this._ttlMs;
        for (const [key, entry] of Object.entries(this._marks)) {
            if (!entry?.seenAt || entry.seenAt < cutoff) delete this._marks[key];
        }
        try {
            this._fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
            this._fs.writeFileSync(this._filePath, JSON.stringify(this._marks, null, 2));
        } catch (error) {
            // Non-fatal: a mark we fail to persist just means the next run is a
            // full pass. Never let bookkeeping break the scrape.
            log.warn('Could not persist high-water marks', {
                file: this._filePath, err: error?.message,
            });
        }
    }

    /** @returns {string|null} newest activity id already forwarded for this search */
    get(keywords, datePosted) {
        const entry = this._marks[markKey(keywords, datePosted)];
        if (!entry?.activityId) return null;
        if (entry.seenAt && entry.seenAt < this._now() - this._ttlMs) return null;
        return entry.activityId;
    }

    /**
     * Move a search's mark forward. Never moves it BACKWARD: a partial or
     * out-of-order run must not re-open ground we've already covered, or every
     * later sweep would re-forward the same posts.
     */
    advance(keywords, datePosted, activityId) {
        if (!activityId) return this.get(keywords, datePosted);
        const key = markKey(keywords, datePosted);
        const current = this._marks[key]?.activityId ?? null;
        if (!isNewerThan(activityId, current)) return current;
        this._marks[key] = { activityId: String(activityId), seenAt: this._now() };
        this.#persist();
        return this._marks[key].activityId;
    }

    /** Test/ops seam: how many marks are held. */
    size() {
        return Object.keys(this._marks).length;
    }
}

let singleton = null;

export function getHighWaterStore() {
    if (!singleton) singleton = new HighWaterStore({});
    return singleton;
}

/** Test seam. */
export function resetHighWaterStore(store = null) {
    singleton = store;
}
