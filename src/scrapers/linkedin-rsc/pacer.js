// Per-account request pacing for LinkedIn.
//
// WHY
// The 15-minute re-scrape floor from #493 is enforced PER QUEUE ROW, in the
// backend claim SQL. It bounds how often one search repeats; it says nothing
// about how close together DIFFERENT searches run on the SAME account. With
// ~154 LinkedIn queue rows all coming due at once, prod on 2026-08-18 fired
// 12 sessions between 06:29:05 and 06:29:32 — gaps of 1.6-4.6 seconds — each
// one a fresh content search on a single credential.
//
// That burst is the behavioural tell. `paginate()` already jitters 2.5-6s
// BETWEEN PAGES of one search, so the intent existed; nothing carried it
// ACROSS searches, because each scrape builds its own paginate() call and the
// orchestrator polls again the moment a platform settles (`#schedulePoll` is
// explicitly "no added delay").
//
// MODEL
// One clock per credential. Before a scrape issues its first request, wait
// until at least MIN_SPACING_MS has passed since the previous scrape on that
// same credential, plus jitter so the spacing itself is not a constant. State
// is in-memory and per-process, which matches the CanaryTracker's model: a
// restart re-paces from zero, which errs toward waiting rather than bursting.
//
// Deliberately NOT a token bucket: a bucket permits a burst by design, and
// the burst is the exact thing being prevented.

import { createLogger } from '../../logger/index.js';

const log = createLogger('linkedin-rsc:pacer');

// Floor between the START of two scrapes on one credential. LinkedIn's own UI
// cannot produce a new content search every 2 seconds for minutes on end, so
// neither should we. 20s against the observed ~135 roles/hour sweep is not a
// throughput constraint: a sweep of 154 rows paced at 20s is ~51 minutes,
// comfortably inside the hourly cadence those sweeps target.
export const DEFAULT_MIN_SPACING_MS = 20_000;

// Extra random padding on top of the floor, so the gap is never a fixed value.
export const DEFAULT_JITTER_MS = 10_000;

export function minSpacingMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_MIN_REQUEST_SPACING_MS ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_SPACING_MS;
}

export function jitterMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_REQUEST_SPACING_JITTER_MS ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_JITTER_MS;
}

// Identity of the credential being paced. Same rule as canary.js keyFor, and
// same reason: `id` is the only field the backend guarantees unique, since
// scraper_credentials has no unique index on `name` and profile_key is
// nullable. A collision here is the more dangerous of the two — two accounts
// sharing one clock would pace each other, halving throughput for no safety
// gain, and the whole point of a pool is that accounts run independently.
function keyFor(lease) {
    const c = lease?.credential;
    if (c?.id !== undefined && c?.id !== null) return `id:${c.id}`;
    return c?.profile_key || c?.name || 'default';
}

export class RequestPacer {
    /**
     * @param {object} [deps]
     * @param {number} [deps.spacingMs] floor between scrapes on one credential
     * @param {number} [deps.jitterMs]  random padding added to the floor
     * @param {() => number} [deps.now]   injectable clock (ms)
     * @param {(ms:number)=>Promise<void>} [deps.sleep] injectable sleep
     * @param {() => number} [deps.rng]   injectable randomness
     */
    constructor({
        spacingMs = minSpacingMs(),
        jitter = jitterMs(),
        now = () => Date.now(),
        sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
        rng = Math.random,
    } = {}) {
        this._spacingMs = spacingMs;
        this._jitter = jitter;
        this._now = now;
        this._sleep = sleep;
        this._rng = rng;
        this._lastAt = new Map();
    }

    /** Milliseconds to wait before this credential may issue its next scrape. */
    waitFor(lease, at = this._now()) {
        if (this._spacingMs <= 0) return 0;
        const last = this._lastAt.get(keyFor(lease));
        if (last === undefined) return 0;          // first scrape: no wait
        const target = last + this._spacingMs + Math.floor(this._rng() * this._jitter);
        return Math.max(0, target - at);
    }

    /**
     * Block until this credential is allowed to scrape again, then stamp the
     * clock. Stamping AFTER the wait (not before) means the spacing is measured
     * between consecutive scrape STARTS, so a slow scrape does not earn its
     * successor an immediate start.
     */
    async pace(lease) {
        // RESERVE THE SLOT BEFORE SLEEPING.
        //
        // scraper_platforms.max_inflight is 2 for linkedin in production, and
        // the orchestrator runs platform tasks under Promise.allSettled, so two
        // scrapes on ONE credential can be in flight together. Reading waitFor()
        // and only stamping after the sleep let both observe the same `last`:
        // the first waited its 20s, the second computed 0 and fired
        // immediately — reproducing the exact back-to-back burst this class
        // exists to prevent, precisely when load is highest.
        //
        // Claiming the next slot up front serialises concurrent callers: each
        // one reserves a later slot than the one before, and then waits for it.
        const key = keyFor(lease);
        const now = this._now();
        const ms = this.waitFor(lease, now);
        // The slot this scrape occupies. Recorded synchronously, before any
        // await, so a concurrent caller cannot interleave between read and
        // write (single-threaded JS makes that sufficient — no lock needed).
        this._lastAt.set(key, now + ms);
        if (ms > 0) {
            log.info('Pacing LinkedIn scrape', { key, waitMs: ms });
            await this._sleep(ms);
        }
        return ms;
    }

    /** Test/ops seam: forget a credential's clock. */
    reset(lease) {
        this._lastAt.delete(keyFor(lease));
    }
}

let singleton = null;
export function getRequestPacer(opts) {
    if (!singleton) singleton = new RequestPacer(opts);
    return singleton;
}
export function __resetRequestPacerForTest() {
    singleton = null;
}
