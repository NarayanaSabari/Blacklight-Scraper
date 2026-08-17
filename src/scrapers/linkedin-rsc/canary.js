// Shadow-ban canary for the LinkedIn RSC transport.
//
// THE BLIND SPOT THIS CLOSES
// A shadow-banned account fails politely: HTTP 200, a valid session, and a
// well-formed "no results" page for queries that visibly have results. Every
// existing detector keys on loud failure — 403 (dead session), 429 (rate
// limit), crash streaks — so a shadow-banned credential reports SUCCESS on
// every scrape and stays `available` in the pool indefinitely. Measured on
// production 2026-08-13→17: the Link1 account served ~50,000 zero-result
// sessions over four days while its success_count climbed. With a credential
// pool, rotation would keep handing a shadow-banned account half the work
// and silently discarding those searches.
//
// THE DETECTOR
// A broad control query ("hiring", past-24h) always has results for a healthy
// account — verified live: a healthy account returned a post 28 minutes old
// while the flagged account got the no-results page for the same request.
// So: after N consecutive zero-yield scrapes on one credential, spend ONE
// extra request on the canary with that same credential.
//
//   canary has posts  → the account is fine, the roles' queries were genuinely
//                       thin. Reset the streak.
//   canary is empty   → shadow-ban by definition. Report the credential failed
//                       with an hours-long cooldown so the pool stops leasing
//                       it and rotates to a healthy account.
//
// Deliberately NOT here: automatic re-login (proven not to clear a shadow-ban
// — only quiet time does) and cross-account comparison (needs synchronized
// duplicate scraping; the canary gives the same certainty for one request).
//
// Streaks are in-memory, keyed per credential profile. A process restart
// resets them, which errs toward re-accumulating evidence — never toward a
// false ban report.

import { createLogger } from '../../logger/index.js';

const log = createLogger('linkedin-rsc:canary');

// Consecutive zero-yield scrapes on one credential before the canary runs.
// Low enough to catch a ban within minutes of a sweep, high enough that a
// run of genuinely thin niche queries doesn't trigger a probe every sweep.
export const DEFAULT_EMPTY_THRESHOLD = 10;

// The control query. Broad on purpose: it must be a query for which "no
// results in the last 24h" is not a believable answer. Keep it a plain
// keyword — a boolean here would just narrow it for no reason.
export const CANARY_QUERY = 'hiring';

// How long a confirmed shadow-banned credential is cooled. Hours, not
// minutes: recovery tracks LinkedIn's daily budget reset, and re-leasing a
// banned account sooner only feeds the signal that got it banned.
export const DEFAULT_BAN_COOLDOWN_MINUTES = 240;

// Floor between canary probes for the same credential, so a credential that
// somehow keeps getting leased while banned (e.g. the failure report didn't
// land) doesn't buy a canary request on every subsequent scrape.
export const DEFAULT_PROBE_INTERVAL_MS = 30 * 60 * 1000;

export function emptyThreshold(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_CANARY_EMPTY_THRESHOLD ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMPTY_THRESHOLD;
}

export function banCooldownMinutes(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_CANARY_BAN_COOLDOWN_MIN ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BAN_COOLDOWN_MINUTES;
}

function keyFor(lease) {
    return lease?.credential?.profile_key || lease?.credential?.name || 'default';
}

export class CanaryTracker {
    constructor({
        threshold = emptyThreshold(),
        probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
        now = () => Date.now(),
    } = {}) {
        this._threshold = threshold;
        this._probeIntervalMs = probeIntervalMs;
        this._now = now;
        this._streaks = new Map();   // key -> consecutive zero-yield scrapes
        this._probedAt = new Map();  // key -> last canary attempt (ms)
    }

    /** A scrape that yielded posts — or reached known ground (`upToDate`,
     *  which means LinkedIn positively served posts we already hold) — is
     *  proof of account health and clears the streak. */
    recordHealthy(lease) {
        this._streaks.delete(keyFor(lease));
    }

    /** Count one zero-yield scrape. @returns {boolean} probe due now */
    recordEmpty(lease) {
        const key = keyFor(lease);
        const n = (this._streaks.get(key) ?? 0) + 1;
        this._streaks.set(key, n);
        if (n < this._threshold) return false;
        // `!== undefined`, not truthiness: a probe recorded at timestamp 0 is
        // still a probe (bites with injected clocks in tests).
        const last = this._probedAt.get(key);
        return !(last !== undefined && this._now() - last < this._probeIntervalMs);
    }

    noteProbe(lease) {
        this._probedAt.set(keyFor(lease), this._now());
    }

    reset(lease) {
        const key = keyFor(lease);
        this._streaks.delete(key);
        this._probedAt.delete(key);
    }

    streak(lease) {
        return this._streaks.get(keyFor(lease)) ?? 0;
    }
}

/**
 * Run the canary against an already-held lease/cookie pair and act on the
 * verdict. Never throws: a canary that errors is inconclusive — the scrape
 * that triggered it already succeeded on the wire, and a probe failure must
 * not turn a healthy zero into a failed session.
 *
 * @returns {Promise<'healthy'|'shadow_banned'|'inconclusive'>}
 */
export async function runCanary({
    tracker, lease, template, cookies, paginateImpl,
    count = 10,
    cooldownMinutes = banCooldownMinutes(),
}) {
    tracker.noteProbe(lease);
    const streak = tracker.streak(lease);
    let posts;
    try {
        ({ posts } = await paginateImpl({
            template,
            cookies,
            keywords: CANARY_QUERY,
            datePosted: 'past-24h',
            maxPosts: count,
            count,
            maxPages: 1,
        }));
    } catch (error) {
        log.warn('Canary probe errored — verdict inconclusive', {
            streak, err: error?.message,
        });
        return 'inconclusive';
    }

    if (posts.length > 0) {
        // The account can see results; the empty streak was honest thin
        // queries. Full reset so the next probe needs a fresh streak.
        log.info('Canary found posts — account healthy, streak was genuine empties', {
            streak, canaryPosts: posts.length,
        });
        tracker.reset(lease);
        return 'healthy';
    }

    // Zero posts on a query that always has posts: shadow-ban confirmed.
    log.error('Canary returned empty — LinkedIn account is shadow-banned', {
        streak,
        canaryQuery: CANARY_QUERY,
        cooldownMinutes,
        scraper_alert: 'linkedin_shadow_ban',
    });
    try {
        await lease?.reportFailure?.(
            `Shadow-ban canary: "${CANARY_QUERY}" returned 0 posts after `
            + `${streak} consecutive zero-yield scrapes`,
            cooldownMinutes,
        );
    } catch (error) {
        log.error('Failed to report shadow-banned credential to the pool', {
            err: error?.message,
        });
    }
    return 'shadow_banned';
}
