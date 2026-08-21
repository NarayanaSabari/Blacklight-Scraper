// Platform-wide search-quota back-off for LinkedIn.
//
// WHAT THIS SOLVES
// LinkedIn meters CONTENT SEARCH separately from the rest of the site. Past
// some volume it stops serving search results while leaving the account
// otherwise completely functional: the profile is logged in, the feed and
// notifications render, and search returns a well-formed "No results found"
// for every query including deliberately broad ones. After a few hours it
// starts serving again on its own.
//
// Measured in production, 2026-08-18/19 (scrapes per hour -> posts returned):
//
//   19:00   135 -> 1224     serving
//   20:00   231 ->  781     serving
//   21:00   285 ->    0     refusing
//   22:00   285 ->    0     refusing
//   23:00   286 ->    0     refusing
//   00:00   208 -> 5689     serving      <- recovered by itself
//   01:00   279 -> 1106     serving
//   02:00   248 -> 2457     serving
//   03:00   288 ->    0     refusing
//   04:00   131 ->    0     refusing
//
// Two things stand out. It recovers unprompted, so it is a rolling quota
// rather than a ban. And we kept issuing ~285 scrapes an hour straight into
// the wall, which gains nothing and plausibly extends the window.
//
// WHY THE EXISTING DEFENCES DO NOT COVER THIS
//   • The pacer (pacer.js) spaces requests within ONE credential. This quota is
//     platform-wide: both accounts lost search within the same minute.
//   • The shadow-ban canary judges ONE credential and cools it for hours. It
//     cannot express "the platform is refusing everyone right now", and cooling
//     individual accounts for 4h is far too blunt for something that clears on
//     its own in ~2.
//   • The template-freshness check (template-health.js) correctly reports the
//     request is fine, which is true and, on its own, unhelpful.
//
// THE MODEL
// Watch consecutive zero-yield scrapes ACROSS all credentials. Past a
// threshold, write the existing LinkedIn platform cooldown marker, which the
// orchestrator already honours at claim time (platform-cooldowns.js) — so this
// reuses a proven stop mechanism rather than inventing a parallel one.
//
// The pause escalates on repeat, because a quota we hit twice in a row means
// the first back-off was not long enough, and decays after a clean recovery so
// one bad night does not permanently slow a healthy host.
//
// DELIBERATELY NOT DOING
// Reporting credentials as failed. They are not: the browser proves the
// accounts work. Cooling them would repeat exactly the misdiagnosis that cost
// five hours on 2026-08-18.

import { createLogger } from '../../logger/index.js';

const log = createLogger('linkedin-rsc:quota');

// Consecutive zero-yield scrapes, across ALL credentials, before we conclude
// the platform has stopped serving search.
//
// Must sit above ordinary thin-query noise. A sweep genuinely finds nothing for
// plenty of narrow boolean queries, and production shows runs of 10-15 empties
// during healthy hours. It must also stay well below the canary's own threshold
// path so the platform stops BEFORE individual accounts start being suspected:
// during a quota window every account looks banned, and that inference is what
// must never fire.
export const DEFAULT_EMPTY_THRESHOLD = 25;

// First back-off. Production windows lasted ~2-3h, but starting there would
// idle a host that tripped the detector on a false positive. 30 minutes is long
// enough to stop the churn and short enough to re-probe cheaply; escalation
// handles a genuinely long window.
export const DEFAULT_BASE_PAUSE_MS = 30 * 60 * 1000;

// Ceiling. Past this we are no longer backing off, we are offline, and an
// operator should be looking at it instead.
export const DEFAULT_MAX_PAUSE_MS = 4 * 60 * 60 * 1000;

// Consecutive trips before the pause stops doubling. Each trip means the
// previous pause was too short.
export const DEFAULT_ESCALATION_FACTOR = 2;

// A clean run this long retires the escalation when NOTHING has been served in
// the meantime — a quiet host that simply stopped tripping.
//
// ⚠️ This is the SECONDARY decay path. The primary one is a served scrape (see
// recordServed), because this timer alone cannot retire an escalation that has
// reached the ceiling:
//
//     escalated pause  ->  4h   (DEFAULT_MAX_PAUSE_MS)
//     decay window     ->  6h   measured from the LAST TRIP
//
// The gap between them is only 2h, and every trip restarts the 6h clock. A host
// tripping even once per recovery window therefore never reaches decay, so
// `consecutiveTrips` only ever climbs. Production 2026-08-21 rode this to 7
// trips and a permanent 4h pause WHILE SCRAPING NORMALLY — 6,242 posts
// overnight, a served scrape at 05:16, and a fresh 4h pause applied at 05:26
// ten minutes later.
export const DEFAULT_ESCALATION_DECAY_MS = 6 * 60 * 60 * 1000;

export function emptyThreshold(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_QUOTA_EMPTY_THRESHOLD ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMPTY_THRESHOLD;
}

export function basePauseMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_QUOTA_PAUSE_MIN ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n * 60 * 1000 : DEFAULT_BASE_PAUSE_MS;
}

export function maxPauseMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_QUOTA_MAX_PAUSE_MIN ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n * 60 * 1000 : DEFAULT_MAX_PAUSE_MS;
}

/**
 * Tracks platform-wide search availability.
 *
 * One instance per process, deliberately NOT per credential: the signal being
 * measured is a property of the platform, and splitting it per account would
 * need every account to independently reach the threshold before anything
 * happened — which is the slow, expensive path this exists to avoid.
 */
export class SearchQuotaTracker {
    constructor({
        threshold = emptyThreshold(),
        basePause = basePauseMs(),
        maxPause = maxPauseMs(),
        escalationFactor = DEFAULT_ESCALATION_FACTOR,
        escalationDecayMs = DEFAULT_ESCALATION_DECAY_MS,
        now = () => Date.now(),
    } = {}) {
        this._threshold = threshold;
        this._basePause = basePause;
        this._maxPause = maxPause;
        this._escalationFactor = escalationFactor;
        this._escalationDecayMs = escalationDecayMs;
        this._now = now;

        this._consecutiveEmpty = 0;
        this._consecutiveTrips = 0;
        this._lastTripAt = null;
        this._lastServedAt = null;
        // When the back-off we applied runs out. Held here so the tracker can
        // re-arm ITSELF rather than depending on the orchestrator to tell it a
        // pause expired: the marker is read at claim time by a different
        // module, and coupling two components to agree on that timing is how
        // they end up disagreeing.
        this._pausedUntil = null;
    }

    /**
     * A scrape that produced posts, or positively reached known ground.
     *
     * Proof the platform is serving us, so the empty run resets AND the
     * escalation is retired.
     *
     * Retiring escalation here was previously gated behind
     * `escalationDecayMs` elapsing since the last trip, on the reasoning that
     * one success right after a pause expires does not prove the window has
     * closed. That reasoning was wrong in the direction that matters, because
     * the gate is unreachable once the pause reaches its ceiling: a 4h pause
     * inside a 6h decay window means any host that keeps tripping never decays
     * at all. Production 2026-08-21 sat at 7 consecutive trips and a permanent
     * 4h pause while scraping 6,242 posts a night — served at 05:16, paused 4h
     * at 05:26.
     *
     * A served scrape is the strongest evidence available that the platform is
     * not metering us, and it is the same signal `_consecutiveEmpty = 0`
     * already trusts unconditionally two lines up. Trusting it for the streak
     * but not the trip count was the inconsistency.
     *
     * The cost of being wrong is bounded and self-correcting: if the quota IS
     * still in force, the next 25 empties trip again, merely starting from the
     * 30-minute base instead of 4h. The cost of the old behaviour was
     * unbounded — a healthy host pinned at the ceiling indefinitely.
     */
    recordServed() {
        this._consecutiveEmpty = 0;
        const now = this._now();
        this._lastServedAt = now;
        // Search is flowing, so whatever pause was in force is over.
        this._pausedUntil = null;
        this._consecutiveTrips = 0;
    }

    /**
     * A zero-yield scrape.
     *
     * @returns {{tripped: boolean, pauseMs: number, streak: number}}
     *   `tripped` is true exactly once per crossing, so the caller writes one
     *   cooldown marker rather than one per subsequent empty scrape.
     */
    recordEmpty() {
        const now = this._now();

        // A pause we applied has run out and scrapes are flowing again. Clear
        // the streak before counting this one.
        //
        // Without this the first scrape after the pause would arrive with the
        // counter still sitting AT the threshold, trip instantly, and pause
        // again — turning a bounded back-off into a permanent stop that
        // escalates to the 4h ceiling and never recovers. The trip COUNT is
        // deliberately kept: if the quota is still in force, the next pause
        // should be longer, and that is exactly what escalation is for.
        if (this._pausedUntil !== null && now >= this._pausedUntil) {
            this._pausedUntil = null;
            this._consecutiveEmpty = 0;
        }

        this._consecutiveEmpty += 1;
        const streak = this._consecutiveEmpty;

        if (streak !== this._threshold) {
            return { tripped: false, pauseMs: 0, streak };
        }

        // Crossed. Escalate from however many times we have tripped recently.
        this._consecutiveTrips += 1;
        this._lastTripAt = now;
        const pauseMs = Math.min(
            this._basePause * (this._escalationFactor ** (this._consecutiveTrips - 1)),
            this._maxPause,
        );
        this._pausedUntil = now + pauseMs;
        return { tripped: true, pauseMs, streak };
    }

    /**
     * Re-arm after a pause expires.
     *
     * Normally automatic (see recordEmpty). Exposed for the operator path where
     * a pause is cleared by hand and scraping should resume from a clean slate.
     */
    rearm() {
        this._consecutiveEmpty = 0;
        this._pausedUntil = null;
    }

    snapshot() {
        const now = this._now();
        const pausedNow = this._pausedUntil !== null && now < this._pausedUntil;
        return {
            consecutiveEmpty: this._consecutiveEmpty,
            consecutiveTrips: this._consecutiveTrips,
            threshold: this._threshold,
            paused: pausedNow,
            pausedUntil: this._pausedUntil === null ? null : new Date(this._pausedUntil).toISOString(),
            lastTripAt: this._lastTripAt === null ? null : new Date(this._lastTripAt).toISOString(),
            lastServedAt: this._lastServedAt === null ? null : new Date(this._lastServedAt).toISOString(),
            nextPauseMs: Math.min(
                this._basePause * (this._escalationFactor ** this._consecutiveTrips),
                this._maxPause,
            ),
        };
    }
}

/**
 * Apply a quota back-off by writing the LinkedIn platform cooldown marker.
 *
 * Reuses the marker the orchestrator ALREADY consults at claim time
 * (core/platform-cooldowns.js), so a paused platform simply stops being
 * claimed. Inventing a second stop mechanism would mean two things that can
 * disagree about whether LinkedIn is running.
 *
 * Best-effort: failing to write the marker must not fail the scrape that
 * detected the problem. The cost of a missed marker is that we keep scraping,
 * which is the status quo this improves on, not a regression.
 *
 * @returns {boolean} whether the marker was written
 */
export function applyQuotaPause({ cooldown, pauseMs, now = new Date() }) {
    try {
        cooldown.writeCooldownMarker({
            writeFile: cooldown.defaultWriteFile(),
            rename: cooldown.defaultRename(),
            // Lets the marker extend rather than truncate a longer claim
            // already written by the auth-cooldown path. See
            // core/linkedin-cooldown.js for why these two collided.
            readFile: cooldown.defaultReadFile(),
            now,
            cooldownMs: pauseMs,
            path: cooldown.cooldownPath(),
        });
        return true;
    } catch (err) {
        log.error('Failed to write LinkedIn quota cooldown marker — scraping will continue into the block', {
            err: err?.message,
        });
        return false;
    }
}

export { log as quotaLog };
