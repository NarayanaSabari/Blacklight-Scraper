// Per-platform scrape cadence: how OFTEN a platform is allowed to start a
// fresh pass over the queue.
//
// WHY
// ---
// Measured 2026-08-03: Indeed ran 39,539 sessions across 141 roles in 24h —
// one re-scrape per role every ~5.1 minutes — and imported 4,374 jobs. That is
// 344 scraped records per import (0.29%), against Dice's 4 (24.9%). 69.4% of
// Indeed's skips were `duplicate_platform_id`: we were asking the same queries
// over and over and being handed the same postings back. Import volume tracks
// how fast Indeed publishes new jobs, not how often we ask.
//
// MODEL
// -----
// A platform with no configured interval behaves exactly as before — claimable
// on every cycle. A platform WITH an interval runs in sweeps:
//
//   due  →  begin()  →  [claim ... claim ... claim]  →  end()  →  sleeps
//
// `end()` is called when the backend stops handing out work for that platform,
// so one sweep drains every role currently queued and then waits out the
// interval. The interval is measured from sweep START, so a sweep that takes
// 20 minutes still leaves ~40 minutes idle on an hourly cadence.
//
// OVERLAP
// -------
// A sweep that outruns its own interval must not stack. While a sweep is in
// flight the platform stays claimable (so it finishes draining) but a NEW
// sweep is never begun, and the overrun is logged once. Skip, don't queue.

import { createLogger } from '../logger/index.js';

const log = createLogger('sweep-schedule');

const MINUTE_MS = 60_000;

/**
 * Per-platform sweep gate + accounting.
 *
 * Intervals are read through a getter rather than captured once, so a change
 * made in the control panel takes effect on the next cycle with no restart.
 */
export class SweepSchedule {
    /**
     * @param {object} [deps]
     * @param {(platform: string) => number|null} [deps.intervalMinutes]
     *   configured cadence for a platform; null/0 → no cadence (legacy behaviour)
     * @param {() => number} [deps.now] injectable clock (ms)
     */
    constructor({ intervalMinutes = () => null, now = () => Date.now() } = {}) {
        this._intervalMinutes = intervalMinutes;
        this._now = now;
        /** @type {Map<string, {lastStartedAt:number|null, inFlight:boolean, startedAt:number|null, overrunLogged:boolean, stats:object}>} */
        this._state = new Map();
    }

    #entry(platform) {
        const key = String(platform ?? '').toLowerCase();
        if (!this._state.has(key)) {
            this._state.set(key, {
                lastStartedAt: null,
                inFlight: false,
                startedAt: null,
                overrunLogged: false,
                stats: null,
            });
        }
        return this._state.get(key);
    }

    #intervalMs(platform) {
        const raw = this._intervalMinutes(String(platform ?? '').toLowerCase());
        const minutes = Number(raw);
        return Number.isFinite(minutes) && minutes > 0 ? minutes * MINUTE_MS : 0;
    }

    /** True when this platform has a cadence configured at all. */
    isScheduled(platform) {
        return this.#intervalMs(platform) > 0;
    }

    /** True when a new sweep is allowed to start right now. */
    isDue(platform, at = this._now()) {
        const intervalMs = this.#intervalMs(platform);
        if (intervalMs === 0) return true;              // no cadence → always due
        const entry = this.#entry(platform);
        if (entry.inFlight) return false;               // already sweeping
        if (entry.lastStartedAt === null) return true;  // never swept
        return at - entry.lastStartedAt >= intervalMs;
    }

    /**
     * Whether the platform may be included in this cycle's claim.
     * An in-flight sweep stays claimable so it can finish draining the queue.
     */
    isClaimable(platform, at = this._now()) {
        if (!this.isScheduled(platform)) return true;
        return this.#entry(platform).inFlight || this.isDue(platform, at);
    }

    /**
     * Start a sweep if one is due. Returns true when a sweep was begun.
     * Calling this while a sweep is in flight is a no-op and logs the overrun
     * once — that is the "sweep took longer than its interval" case.
     */
    begin(platform, at = this._now()) {
        if (!this.isScheduled(platform)) return false;
        const entry = this.#entry(platform);

        if (entry.inFlight) {
            const intervalMs = this.#intervalMs(platform);
            const runningMs = at - (entry.startedAt ?? at);
            if (runningMs >= intervalMs && !entry.overrunLogged) {
                entry.overrunLogged = true;
                log.warn('Sweep is still running past its own interval — skipping the next one', {
                    platform, runningMs, intervalMs,
                    scraper_alert: 'sweep_overrun',
                });
            }
            return false;
        }

        if (!this.isDue(platform, at)) return false;

        entry.inFlight = true;
        entry.startedAt = at;
        entry.lastStartedAt = at;   // interval measured from START, not finish
        entry.overrunLogged = false;
        entry.stats = { roles: 0, sessions: 0, jobsSeen: 0, jobsImported: 0 };
        log.info('Sweep started', { platform, intervalMinutes: this.#intervalMs(platform) / MINUTE_MS });
        return true;
    }

    /** Accumulate per-assignment counters into the running sweep. */
    record(platform, { roles = 0, sessions = 0, jobsSeen = 0, jobsImported = 0 } = {}) {
        const entry = this.#entry(platform);
        if (!entry.inFlight || !entry.stats) return;
        entry.stats.roles += roles;
        entry.stats.sessions += sessions;
        entry.stats.jobsSeen += jobsSeen;
        entry.stats.jobsImported += jobsImported;
    }

    /**
     * Finish the in-flight sweep and emit its summary. Returns the summary, or
     * null when no sweep was running.
     *
     * The summary is the whole point of the exercise: it is what makes the
     * predicted "−83% sessions, flat imports" checkable on a dashboard rather
     * than a claim nobody can verify.
     */
    end(platform, at = this._now()) {
        const entry = this.#entry(platform);
        if (!entry.inFlight) return null;
        const summary = {
            platform,
            durationMs: at - (entry.startedAt ?? at),
            ...(entry.stats ?? { roles: 0, sessions: 0, jobsSeen: 0, jobsImported: 0 }),
            nextDueAt: new Date(entry.lastStartedAt + this.#intervalMs(platform)).toISOString(),
        };
        entry.inFlight = false;
        entry.startedAt = null;
        entry.stats = null;
        log.info('Sweep complete', { ...summary, scraper_metric: 'platform_sweep' });
        return summary;
    }

    /** Read-only view for the control panel. */
    snapshot(at = this._now()) {
        const out = {};
        for (const [platform, entry] of this._state.entries()) {
            const intervalMs = this.#intervalMs(platform);
            out[platform] = {
                intervalMinutes: intervalMs ? intervalMs / MINUTE_MS : null,
                inFlight: entry.inFlight,
                lastStartedAt: entry.lastStartedAt ? new Date(entry.lastStartedAt).toISOString() : null,
                nextDueAt: intervalMs && entry.lastStartedAt
                    ? new Date(entry.lastStartedAt + intervalMs).toISOString()
                    : null,
                dueNow: this.isDue(platform, at),
            };
        }
        return out;
    }
}
