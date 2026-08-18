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
import { getMetrics } from '../../metrics/registry.js';

const log = createLogger('linkedin-rsc:canary');

// Consecutive zero-yield scrapes on one credential before the canary runs.
// Low enough to catch a ban within minutes of a sweep, high enough that a
// run of genuinely thin niche queries doesn't trigger a probe every sweep.
export const DEFAULT_EMPTY_THRESHOLD = 10;

// Control queries. Broad on purpose: each must be a query for which "no results
// in the last 24h" is not a believable answer. Plain keywords — a boolean here
// would just narrow them for no reason.
//
// A ROTATING SET, not one constant. A fixed probe word is self-defeating: the
// thing this canary is trying to distinguish is LinkedIn refusing a REPEATED
// identical search, and a probe that sends the same keyword every time is by
// construction the most repeated query the account issues. Its empty answer
// then gets read as proof of a ban — the detector manufacturing its own
// verdict. Picking a different word per probe keeps each one a fresh search.
export const CANARY_QUERIES = Object.freeze([
    'hiring',
    'we are hiring',
    'job opening',
    'now hiring',
    'recruiting',
    'open role',
]);

// Back-compat for callers/tests that referenced the old single constant.
export const CANARY_QUERY = CANARY_QUERIES[0];

/** Pick a control query at random so consecutive probes differ. */
export function pickCanaryQuery(rng = Math.random) {
    const i = Math.floor(rng() * CANARY_QUERIES.length);
    return CANARY_QUERIES[Math.min(i, CANARY_QUERIES.length - 1)];
}

// How long a confirmed shadow-banned credential is cooled. Hours, not
// minutes: recovery tracks LinkedIn's daily budget reset, and re-leasing a
// banned account sooner only feeds the signal that got it banned.
export const DEFAULT_BAN_COOLDOWN_MINUTES = 240;

// Floor between canary probes for the same credential, so a credential that
// somehow keeps getting leased while banned (e.g. the failure report didn't
// land) doesn't buy a canary request on every subsequent scrape.
export const DEFAULT_PROBE_INTERVAL_MS = 30 * 60 * 1000;

// Floor between the FIRST (suspicious) probe and its corroborating follow-up.
//
// Requiring two strikes fixed the false-positive that cooled both production
// accounts, but it doubled the wait for a GENUINE ban — and at the 30-minute
// floor that is not a small cost. Measured on a simulated banned account paced
// at 25s:
//
//   one strike               10 scrapes,  4.2 min
//   two strikes @ 30min      82 scrapes, 34.2 min   <- 72 extra scrapes
//   two strikes @  5min      22 scrapes,  9.2 min
//
// Every one of those extra scrapes is a request from an account LinkedIn is
// already refusing, which is exactly the behaviour that deepens a ban.
//
// The long floor exists to stop probe storms on an account that keeps getting
// leased while banned. That concern applies to the steady state, not to a
// credential already carrying an unresolved strike: there, one more probe
// settles the question and ends the leasing entirely. So corroboration gets a
// short floor and everything else keeps the long one.
export const DEFAULT_CORROBORATION_INTERVAL_MS = 5 * 60 * 1000;

// First retry gap after an INCONCLUSIVE probe (one that never reached a
// verdict). Doubles per consecutive inconclusive result, capped at the normal
// probe floor — see noteInconclusive().
export const DEFAULT_INCONCLUSIVE_RETRY_MS = 30 * 1000;

export function emptyThreshold(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_CANARY_EMPTY_THRESHOLD ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMPTY_THRESHOLD;
}

export function banCooldownMinutes(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_CANARY_BAN_COOLDOWN_MIN ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BAN_COOLDOWN_MINUTES;
}

// Identity of the credential this evidence belongs to.
//
// `id` FIRST, because it is the only field the backend guarantees is unique:
// scraper_credentials has no unique index on `name` and profile_key is
// nullable (production's Link1 has none). Two credentials that both lack a
// profile_key and a name collapsed onto the literal string 'default', so they
// shared one streak and one strike counter — a healthy account could then be
// convicted on a banned sibling's evidence, and clearing one would clear both.
//
// The tail is kept for leases that predate `id` in the payload and for tests
// that build leases by hand.
function keyFor(lease) {
    const c = lease?.credential;
    if (c?.id !== undefined && c?.id !== null) return `id:${c.id}`;
    return c?.profile_key || c?.name || 'default';
}

export class CanaryTracker {
    constructor({
        threshold = emptyThreshold(),
        probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
        corroborationIntervalMs = DEFAULT_CORROBORATION_INTERVAL_MS,
        inconclusiveRetryMs = DEFAULT_INCONCLUSIVE_RETRY_MS,
        now = () => Date.now(),
    } = {}) {
        this._threshold = threshold;
        this._probeIntervalMs = probeIntervalMs;
        // Never longer than the general floor. A caller that lowers
        // probeIntervalMs — including to 0, which means "no floor at all" —
        // must not find corroboration silently held back by a default it never
        // asked for. Caught by an existing end-to-end test that set
        // probeIntervalMs: 0 and then never got its verdict.
        this._corroborationIntervalMs = Math.min(corroborationIntervalMs, probeIntervalMs);
        this._inconclusiveRetryMs = Math.min(inconclusiveRetryMs, probeIntervalMs);
        this._now = now;
        this._streaks = new Map();   // key -> consecutive zero-yield scrapes
        this._probedAt = new Map();  // key -> last canary attempt (ms)
        this._suspicions = new Map(); // key -> consecutive empty canary probes
        this._inconclusive = new Map(); // key -> consecutive inconclusive probes
    }

    /** A scrape that yielded posts — or reached known ground (`upToDate`,
     *  which means LinkedIn positively served posts we already hold) — is
     *  proof of account health and clears the streak. */
    recordHealthy(lease) {
        this._streaks.delete(keyFor(lease));
        this._suspicions.delete(keyFor(lease));
        this._inconclusive.delete(keyFor(lease));
    }

    /** Count one empty canary probe. @returns {number} consecutive empties */
    recordSuspicion(lease) {
        const key = keyFor(lease);
        const n = (this._suspicions.get(key) ?? 0) + 1;
        this._suspicions.set(key, n);
        return n;
    }

    suspicion(lease) {
        return this._suspicions.get(keyFor(lease)) ?? 0;
    }

    /** Count one zero-yield scrape. @returns {boolean} probe due now */
    recordEmpty(lease) {
        const key = keyFor(lease);
        const n = (this._streaks.get(key) ?? 0) + 1;
        this._streaks.set(key, n);
        // `!== undefined`, not truthiness: a probe recorded at timestamp 0 is
        // still a probe (bites with injected clocks in tests).
        const last = this._probedAt.get(key);
        // A credential already carrying a strike is one probe from a verdict,
        // so it waits the short corroboration floor rather than the full one.
        const floor = (this._suspicions.get(key) ?? 0) > 0
            ? this._corroborationIntervalMs
            : this._probeIntervalMs;
        const probeDue = n >= this._threshold
            && !(last !== undefined && this._now() - last < floor);
        // Streak telemetry. Sparse on purpose (approach + every 10th) so a
        // banned account cycling fast doesn't flood the log — but never
        // silent: production 2026-08-17 hit 51 consecutive zeros with no
        // canary and no way to tell from the log which link of the chain
        // (call, key, threshold, probe floor) had broken.
        if (probeDue || n === this._threshold - 1 || n % 10 === 0) {
            log.info('Zero-yield streak', {
                key, streak: n, threshold: this._threshold, probeDue,
                lastProbeAgoMs: last === undefined ? null : this._now() - last,
            });
        }
        return probeDue;
    }

    noteProbe(lease) {
        this._probedAt.set(keyFor(lease), this._now());
    }

    /** A probe that DID reach a verdict ends any inconclusive backoff run. */
    noteConclusive(lease) {
        this._inconclusive.delete(keyFor(lease));
    }

    /**
     * Rebate the probe budget after a verdict that learned nothing.
     *
     * An inconclusive probe (network blip, socket reset) gained no evidence,
     * and charging it the full floor makes a flaky link look like a healthy
     * account: measured with every second probe erroring, a genuinely banned
     * credential took 106 scrapes / 44.2 min to cool instead of 22 / 9.2 min,
     * because each blip bought a fresh 30-minute wait.
     *
     * But a full rebate is worse. With EVERY probe erroring, clearing the stamp
     * outright produced 1,991 probes in 13.9h — 143/hour, one per scrape. A
     * misconfigured template or a dead proxy would hammer LinkedIn from an
     * account already under suspicion.
     *
     * So: retry soon, then back off. The stamp is rewound to leave only a short
     * retry gap, and each consecutive inconclusive verdict doubles it up to the
     * normal floor. One blip costs seconds; a broken probe path settles at the
     * same 30 minutes it would have had anyway.
     */
    noteInconclusive(lease) {
        const key = keyFor(lease);
        const n = (this._inconclusive.get(key) ?? 0) + 1;
        this._inconclusive.set(key, n);
        const retryMs = Math.min(
            this._inconclusiveRetryMs * (2 ** (n - 1)),
            this._probeIntervalMs,
        );
        // Pretend the probe happened `floor - retry` ago, so only `retry`
        // remains on the clock.
        this._probedAt.set(key, this._now() - Math.max(0, this._probeIntervalMs - retryMs));
        return retryMs;
    }

    reset(lease) {
        const key = keyFor(lease);
        this._streaks.delete(key);
        this._probedAt.delete(key);
        this._suspicions.delete(key);
        this._inconclusive.delete(key);
    }

    streak(lease) {
        return this._streaks.get(keyFor(lease)) ?? 0;
    }
}

// Consecutive EMPTY probes, each with a different control query, before a ban
// is reported. One empty probe is not proof: the 2026-08-18 incident cooled
// both accounts (pipeline to zero, 550 rows backed up) off single probes, and
// Link2's came 4.2s after a successful scrape. Requiring a second, separately
// scheduled probe — the interval floor guarantees the gap — costs one extra
// request on a genuinely banned account and prevents a total outage on a false
// positive. Cheap insurance in the direction that cannot take the pipeline down.
export const DEFAULT_SUSPICION_STRIKES = 2;

export function suspicionStrikes(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_CANARY_STRIKES ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SUSPICION_STRIKES;
}

/**
 * Run the canary against an already-held lease/cookie pair and act on the
 * verdict. Never throws: a canary that errors is inconclusive — the scrape
 * that triggered it already succeeded on the wire, and a probe failure must
 * not turn a healthy zero into a failed session.
 *
 * @returns {Promise<'healthy'|'shadow_banned'|'suspected'|'inconclusive'|'request_refused'>}
 */
export async function runCanary({
    tracker, lease, template, cookies, paginateImpl,
    count = 10,
    cooldownMinutes = banCooldownMinutes(),
    rng = Math.random,
    strikes = suspicionStrikes(),
    // The probe MUST leave from the same IP as the scrapes it is judging.
    // Egressing the control query on the host IP while the account's searches
    // go through its proxy would compare two different network identities and
    // could convict a healthy account on the strength of a request it never
    // would have made itself.
    fetchImpl = undefined,
    // Asks "is our REQUEST the problem?" before blaming the account. See the
    // block below for why this gate exists. Injected so tests can drive either
    // answer, and so a caller with no template context can pass null to keep
    // the previous behaviour.
    verifyRequestHealth = null,
}) {
    tracker.noteProbe(lease);
    const streak = tracker.streak(lease);
    const canaryQuery = pickCanaryQuery(rng);
    let posts;
    try {
        ({ posts } = await paginateImpl({
            template,
            cookies,
            keywords: canaryQuery,
            datePosted: 'past-24h',
            maxPosts: count,
            count,
            maxPages: 1,
            ...(fetchImpl ? { fetchImpl } : {}),
        }));
    } catch (error) {
        log.warn('Canary probe errored — verdict inconclusive', {
            streak, err: error?.message,
        });
        // Nothing was learned, so refund most of the budget — but back off if
        // this keeps happening (see noteInconclusive).
        const retryMs = tracker.noteInconclusive(lease);
        log.warn('Canary retry scheduled after inconclusive probe', { retryMs });
        return 'inconclusive';
    }

    tracker.noteConclusive(lease);

    if (posts.length > 0) {
        // The account can see results; the empty streak was honest thin
        // queries. Full reset so the next probe needs a fresh streak.
        log.info('Canary found posts — account healthy, streak was genuine empties', {
            streak, canaryPosts: posts.length, canaryQuery,
        });
        tracker.reset(lease);
        return 'healthy';
    }

    // Zero posts on a query that always has posts. Suspicious — but a single
    // empty probe is not enough to take a credential offline for hours.
    const strike = tracker.recordSuspicion(lease);
    if (strike < strikes) {
        log.warn('Canary probe empty — suspected, awaiting corroboration', {
            streak, canaryQuery, strike, strikesNeeded: strikes,
            scraper_alert: 'linkedin_shadow_ban_suspected',
        });
        return 'suspected';
    }

    // LAST GATE BEFORE CONVICTING THE ACCOUNT.
    //
    // Everything above measures the account through OUR request. If the request
    // itself is being refused, every observation feeding this verdict is
    // worthless — and the two causes are indistinguishable from here, because
    // LinkedIn answers both with a well-formed "no results".
    //
    // Production 2026-08-18 is the case in point. The captured template had
    // fallen 269 client builds behind, so LinkedIn stopped honouring the
    // request and returned confirmed empties for EVERY query. A browser on the
    // same profile, at the same moment, saw live posts. The canary did exactly
    // what it was designed to do and reached exactly the wrong conclusion:
    // both healthy credentials cooled for four hours, the pipeline at zero for
    // five, and the recorded cause ("shadow-banned") pointed every remedy in
    // the wrong direction.
    //
    // So before reporting a ban, ask whether our request is even valid. A
    // stale-template verdict is CHEAP to check (one page fetch, no search
    // budget) and its remedy is automatic, whereas a wrong ban verdict is
    // expensive and self-inflicted. Only convict the account when the request
    // is known-good.
    if (verifyRequestHealth) {
        let requestHealthy = true;
        try {
            requestHealthy = await verifyRequestHealth();
        } catch (err) {
            // Could not tell. Treat as inconclusive rather than guessing:
            // failing toward "do not ban" is the recoverable direction, since
            // a genuinely banned account simply gets convicted on the next
            // probe instead.
            log.warn('Could not verify request health — deferring the ban verdict', {
                err: err?.message,
            });
            requestHealthy = false;
        }
        if (!requestHealthy) {
            log.error(
                'Canary empty BUT our request looks stale/refused — NOT banning the account',
                {
                    streak,
                    canaryQuery,
                    strike,
                    scraper_alert: 'linkedin_request_refused_not_ban',
                },
            );
            // Each increment is one false shadow-ban prevented, which is the
            // clearest measure of whether this gate is earning its keep.
            try { getMetrics()?.recordLinkedInRequestRefused?.(); } catch { /* never break a scrape */ }
            // Clear the evidence. It was gathered through a request LinkedIn
            // was refusing, so it says nothing about this credential, and
            // keeping it would convict the account the moment the template is
            // fixed and a thin query happens to land first.
            tracker.reset(lease);
            return 'request_refused';
        }
    }

    // Corroborated across independent probes with different control queries,
    // and our request is known-good: shadow-ban confirmed.
    log.error('Canary returned empty — LinkedIn account is shadow-banned', {
        streak,
        canaryQuery,
        strike,
        cooldownMinutes,
        scraper_alert: 'linkedin_shadow_ban',
    });
    try {
        await lease?.reportFailure?.(
            `Shadow-ban canary: "${canaryQuery}" returned 0 posts after `
            + `${streak} consecutive zero-yield scrapes (${strike} corroborating probes)`,
            cooldownMinutes,
        );
    } catch (error) {
        log.error('Failed to report shadow-banned credential to the pool', {
            err: error?.message,
        });
    }

    // Spend the evidence. The verdict has been delivered and the credential is
    // cooled for hours; the streak that produced it describes a period the
    // account has already been punished for.
    //
    // Leaving it in place made recovery a coin toss. Production 2026-08-18,
    // two credentials returning into the SAME unrestarted process:
    //
    //   Link1 08:40  first scrape 0 jobs   -> re-banned 4s later, "after 15
    //                                         consecutive zero-yield scrapes"
    //                                         having run exactly one
    //   Link2 10:30  first scrape 17 jobs  -> recordHealthy() cleared the
    //                                         stale streak, survived
    //
    // So the trap is probabilistic, not certain: a returning credential is
    // convicted on pre-cooldown evidence only if its first query happens to be
    // thin. Link1 lost that draw and its failure_count climbed while it did
    // nothing wrong. A healthy account's fate should not depend on which role
    // it is handed first.
    //
    // After a cooldown the account must re-earn its verdict from zero: a fresh
    // streak to the threshold, then a fresh set of corroborating probes.
    tracker.reset(lease);
    return 'shadow_banned';
}
