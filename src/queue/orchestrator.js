// Queue orchestrator — the end-to-end Blacklight workflow:
//
//   1. Check for an active session (resume if found)
//   2. Pull the next batch of assignments (backend filters platforms by this
//      key's platform_allowlist, if set)
//   3. For each assignment and returned platform: run scraper → format → submit jobs
//   4. Complete each session — backend coordinates with sibling sessions
//      (other scrapers handling different platforms for the same role)
//      before finalizing role status + firing matching.
//
// This used to live inline in server.js. Extracting it leaves server.js as
// a thin HTTP shell and makes the workflow independently testable.

import { createLogger } from '../logger/index.js';
import { BlacklightApiClient } from '../api/blacklight.js';
import { formatJobForBlacklight } from '../core/format.js';
import { getScraper } from '../scrapers/registry.js';
import { Mutex } from './mutex.js';
import { getMetrics } from '../metrics/registry.js';
import { platformsOnCooldown } from '../core/platform-cooldowns.js';
import { NetworkError, TimeoutError } from '../core/errors.js';
import { PLATFORM_NAMES } from '../scrapers/registry.js';
import { getPlatformOverrides } from '../panel/overrides.js';
import { SweepSchedule } from './sweep-schedule.js';
import { createLinkedInGroupScraper } from '../scrapers/linkedin-group/scraper.js';

const log = createLogger('orchestrator');

// A claim can be committed before its HTTP response reaches the scraper.
// Timeout and transport failures are therefore recoverable by asking the
// backend for the matching recent session.  Preserve ordinary 4xx handling:
// those responses identify a rejected request rather than an ambiguous claim.
function isAmbiguousClaimFailure(error) {
    if (error instanceof TimeoutError) return true;
    if (!(error instanceof NetworkError)) return false;
    return error.statusCode === null
        || error.statusCode === undefined
        || error.statusCode === 408
        || error.statusCode >= 500;
}

export class QueueOrchestrator {
    constructor({
        blacklightConfig, queueConfig, defaultLocation,
        client = null, metrics = null, scraperResolver = null, cooldownCheck = null,
        platformOverrides = null, sweepSchedule = null, groupScraper = null,
    }) {
        if (!client && !blacklightConfig) {
            throw new Error('QueueOrchestrator requires blacklightConfig');
        }
        this.client = client ?? new BlacklightApiClient(blacklightConfig.apiUrl, blacklightConfig.apiKey);
        this.queueConfig = queueConfig;
        // Per-platform scrapers still need a location string for their search
        // URL (e.g. LinkedIn's `&location=`). The backend no longer drives
        // location-specific scraping, so each scraper instance picks a default
        // — "United States" works for US-bench-sales recruiting; override via
        // SCRAPER_DEFAULT_LOCATION if you want a tighter geographic scope.
        this.defaultLocation = defaultLocation || 'United States';
        this.mutex = new Mutex();
        this.autoInterval = null;
        // SCR-18 (#401): at most ONE follow-up poll may be pending at a time.
        // See #schedulePoll.
        this._pollScheduled = false;
        // The group source shares LinkedIn's credential path with normal role
        // work, so alternate which optional turn gets first refusal. This
        // bounds group starvation when the role queue is continuously due,
        // while a 204/404 group response immediately falls back to roles.
        this._preferGroupNext = false;
        this._sweepSchedule = sweepSchedule;
        // Panel-only bookkeeping (read via snapshot()). Never consulted by the
        // workflow itself, so getting it wrong can't change scraping behavior.
        this._lastPollAt = null;
        this._lastPollOutcome = null;
        this._autoCheckIntervalMs = queueConfig?.checkIntervalMs ?? null;
        // sessionId -> { role, startedAt, platforms: { name: 'pending'|'success'|'failed' } }
        this._activeSessions = new Map();
        // Injection seams (default to the production singletons). Behavior-
        // neutral: server.js passes none of these, so construction is
        // identical to before. Tests inject fakes to exercise the workflow
        // without live HTTP / the real scraper registry.
        this._metrics = metrics;
        this._resolveScraper = scraperResolver ?? getScraper;
        this._groupScraper = groupScraper ?? createLinkedInGroupScraper();
        this._cooldownCheck = cooldownCheck ?? platformsOnCooldown;
        // Local pause/resume from the control panel. Injected the same way as
        // the other seams — tests supply a fake, production lazily resolves
        // the singleton so importing this module never touches the filesystem.
        this._platformOverrides = platformOverrides;
    }

    // Resolve the metrics sink: injected fake in tests, global registry in prod.
    #metrics() {
        return this._metrics ?? getMetrics();
    }

    // Resolve the local platform overrides: injected fake in tests, global
    // singleton in prod (see src/panel/overrides.js).
    #overrides() {
        return this._platformOverrides ?? getPlatformOverrides();
    }

    // Cadence gate. Intervals are read through the overrides object on every
    // call, so changing one in the control panel takes effect on the next
    // cycle — no restart, no deploy.
    #schedule() {
        if (!this._sweepSchedule) {
            this._sweepSchedule = new SweepSchedule({
                // Optional chaining on purpose: an injected overrides object
                // (tests, older callers) may predate intervalMinutes. Missing
                // it must mean "no cadence configured", not a crash in the
                // claim path.
                intervalMinutes: (platform) => this.#overrides().intervalMinutes?.(platform) ?? null,
            });
        }
        return this._sweepSchedule;
    }

    /** Read-only cadence view for the control panel. */
    sweepSnapshot() {
        return this.#schedule().snapshot();
    }

    // ----- public API -------------------------------------------------------

    /**
     * Runs a single queue cycle. The mutex covers the CLAIM portion only
     * (poll + receive assignments), not the long-running scrape work.
     * Assignments are fired in the background so a fast-finishing
     * platform doesn't sit idle waiting for slow siblings before the
     * next claim fires. The backend's claim filter excludes platforms
     * that already have in-flight sessions for this scraper, which
     * prevents over-claiming when polls overlap with running work.
     */
    /**
     * Schedule ONE follow-up claim after a platform settles (SCR-18 / #401).
     *
     * Every settling platform used to fire its own `setImmediate(runOnce)`, so a
     * 6-platform assignment produced up to 6 polls. The claim mutex made the
     * overlapping ones cheap — they returned `{skipped:true}` — but platforms
     * that settle at DIFFERENT times do not overlap, so each one became a real
     * backend claim. Fast-failing platforms (no credentials, unsupported) settle
     * almost together and amplified hardest.
     *
     * Coalescing keeps the intent — a fast-finishing platform must not wait for
     * slow siblings before the next claim — while collapsing a burst into a
     * single poll. There is deliberately NO added delay: a pending poll is
     * dropped rather than deferred, so the first trigger still runs on the next
     * tick and latency is unchanged.
     */
    #schedulePoll(platformName) {
        if (this._pollScheduled) return;
        this._pollScheduled = true;
        setImmediate(() => {
            // Cleared BEFORE the run so a platform settling during this poll can
            // schedule the next one; clearing after would swallow it.
            this._pollScheduled = false;
            this.runOnce().catch((err) => {
                log.error('Post-platform claim failed', {
                    platform: platformName, err: err.message,
                });
            });
        });
    }

    // Test-only seam onto #schedulePoll, matching the _issueLeaseForTest /
    // _hasActiveLease convention in api/credentials.js. The coalescing is the
    // behaviour under test and is otherwise only reachable through a full
    // assignment run.
    _schedulePollForTest(platformName = 'test') {
        this.#schedulePoll(platformName);
    }

    async runOnce() {
        this._lastPollAt = Date.now();
        if (!this.mutex.tryAcquire()) {
            log.info('Queue run skipped — claim already in flight');
            this.#metrics().recordQueueCheck('skipped_busy');
            this._lastPollOutcome = 'skipped_busy';
            return { skipped: true };
        }
        let queueResult;
        try {
            queueResult = await this.#claim();
        } catch (error) {
            this._lastPollOutcome = 'error';
            throw error;
        } finally {
            this.mutex.release();
        }

        const assignments = queueResult?.assignments || [];
        if (assignments.length === 0) {
            this._lastPollOutcome = 'empty';
            return { message: 'Queue is empty for idle platforms' };
        }

        this._lastPollOutcome = `batched:${assignments.length}`;
        // Fire each assignment in the background. The mutex is already
        // released so the next poll (30s tick or manual trigger) can
        // immediately claim work for any platform that finishes early.
        for (const assignment of assignments) {
            this.#runAssignment(assignment, this.#metrics()).catch((err) => {
                log.error('Assignment failed unexpectedly', {
                    sessionId: assignment.session_id,
                    role: assignment.role?.name,
                    err: err.message,
                });
            });
        }
        return {
            batched: assignments.length,
            roles: assignments.map((a) => this.#assignmentLabel(a)),
        };
    }

    startAutoChecker() {
        if (this.autoInterval) return;
        const { checkIntervalMs, startupDelayMs } = this.queueConfig;
        log.info('Auto queue checker enabled', { checkIntervalMs, startupDelayMs });
        setTimeout(() => { this.runOnce().catch((err) => log.error('Auto run failed', { err: err.message })); }, startupDelayMs);
        this.autoInterval = setInterval(() => {
            this.runOnce().catch((err) => log.error('Auto run failed', { err: err.message }));
        }, checkIntervalMs);
    }

    stopAutoChecker() {
        if (this.autoInterval) {
            clearInterval(this.autoInterval);
            this.autoInterval = null;
            log.info('Auto queue checker stopped');
        }
    }

    // Read-only detail for the control panel. Pure read, no side effects —
    // safe to poll on every /panel/api/status request.
    snapshot() {
        const running = !!this.autoInterval;
        let secondsUntilNextTick = null;
        if (running && this._autoCheckIntervalMs && this._lastPollAt) {
            const elapsed = Date.now() - this._lastPollAt;
            secondsUntilNextTick = Math.max(0, Math.round((this._autoCheckIntervalMs - elapsed) / 1000));
        }
        return {
            running,
            mutexLocked: this.mutex.isLocked,
            lastPollAt: this._lastPollAt ? new Date(this._lastPollAt).toISOString() : null,
            lastPollOutcome: this._lastPollOutcome,
            secondsUntilNextTick,
            activeSessions: [...this._activeSessions.entries()].map(([sessionId, s]) => ({
                sessionId,
                role: s.role,
                startedAt: new Date(s.startedAt).toISOString(),
                platforms: { ...s.platforms },
            })),
        };
    }

    // ----- internals --------------------------------------------------------

    #assignmentHasPlatform(assignment, platformName) {
        const expected = String(platformName).toLowerCase();
        return (assignment?.platforms ?? []).some((platform) => {
            const name = typeof platform === 'string' ? platform : platform?.name;
            return String(name ?? '').toLowerCase() === expected;
        });
    }

    #assignmentLabel(assignment) {
        if (assignment?.group?.id !== undefined && assignment?.group?.id !== null) {
            return `LinkedIn group ${assignment.group.id}`;
        }
        return assignment?.role?.name ?? 'Unknown assignment';
    }

    #hasActivePlatform(platformName) {
        const expected = String(platformName).toLowerCase();
        for (const session of this._activeSessions.values()) {
            if (session.platforms?.[expected] === 'pending') return true;
        }
        return false;
    }

    #hasActiveGroupPlatform(platformName) {
        const expected = String(platformName).toLowerCase();
        for (const session of this._activeSessions.values()) {
            if (session.group === true && session.platforms?.[expected] === 'pending') return true;
        }
        return false;
    }

    #isValidGroupClaim(claim) {
        const group = claim?.group;
        const platforms = claim?.platforms;
        return typeof claim?.session_id === 'string'
            && claim.session_id.length > 0
            && typeof group?.source_id === 'number'
            && (typeof group.id === 'number' || typeof group.id === 'string')
            && typeof group.url === 'string'
            && group.url.length > 0
            && group.checkpoint
            && Array.isArray(platforms)
            && this.#assignmentHasPlatform(claim, 'linkedin');
    }

    async #claimGroupAssignment() {
        if (typeof this.client.claimLinkedInGroup !== 'function') return null;

        let claim;
        try {
            claim = await this.client.claimLinkedInGroup();
        } catch (error) {
            // Group collection is an optional capability during a rolling
            // upgrade. Its failure must leave normal queue work runnable.
            if (isAmbiguousClaimFailure(error)) {
                const recovered = await this.#recoverOrphanedSession('group');
                if (recovered?.group) return recovered;
            }
            if (error instanceof NetworkError && error.statusCode === 404) return null;
            log.warn('LinkedIn group claim unavailable; continuing normal queue work', {
                err: error.message,
                scraper_alert: 'group_claim_unavailable',
            });
            return null;
        }

        if (claim === null || claim === undefined) return null;
        if (!this.#isValidGroupClaim(claim)) {
            log.warn('LinkedIn group claim response was unrecognized; skipping it', {
                scraper_alert: 'group_claim_unrecognized',
            });
            return null;
        }
        return { ...claim, role: null, group: claim.group };
    }

    /**
     * Claim portion of a queue cycle. Returns the raw queue response
     * (with `assignments` array) or null/empty result for an empty
     * queue. The caller (runOnce) is responsible for firing each
     * assignment fire-and-forget once the mutex is released.
     *
     * Pre-flight: ask the backend which platforms have leasable
     * credentials RIGHT NOW. Pass that as a runtime filter on the
     * claim, so we don't claim work for platforms whose creds are out
     * of stock. Without this, a starved platform causes the orchestrator
     * to claim → fail-on-null-lease → submit failed → re-poll → claim
     * again, spamming thousands of failed sessions (observed 36k in 2h
     * with 1 starved Indeed cred).
     */
    async #claim() {
        const metrics = this.#metrics();
        log.info('Starting queue cycle');

        let usablePlatforms = null;
        try {
            const availability = await this.client.checkCredentialAvailability();
            // Platforms with > 0 leasable creds (999 marks public/no-auth).
            usablePlatforms = Object.entries(availability)
                .filter(([, n]) => n > 0)
                .map(([p]) => p);
            if (usablePlatforms.length === 0) {
                log.info('No credentials available for any platform — skipping claim', {
                    availability,
                });
                metrics.recordQueueCheck('no_creds');
                return { assignments: [] };
            }
            const starved = Object.entries(availability)
                .filter(([, n]) => n === 0)
                .map(([p]) => p);
            if (starved.length > 0) {
                log.info('Platforms starved this cycle — excluded from claim', { starved });
            }
        } catch (error) {
            // Don't block the claim if the availability check fails —
            // fall back to old behaviour (let the backend filter only
            // by static allowlist). Log so it's visible, and count it: a
            // failed pre-flight is exactly the condition (backend blip,
            // open circuit breaker — SCR-15) most likely to coincide with a
            // platform being on local cooldown, so this degraded path must
            // be countable, not just a log line (SCR-25).
            log.warn('Credential availability pre-flight failed; falling back to static allowlist', {
                err: error.message,
                scraper_alert: 'preflight_failed',
            });
            metrics.recordQueueCheck('preflight_failed');
            // SCR-10: resolve null → the full known platform list so the
            // cooldown filter below always has an explicit array to subtract
            // from. Without this, a failed pre-flight fell through the
            // Array.isArray guard below and cooldowns were never consulted —
            // exactly the condition that caused ~185 zero-result sessions/min
            // in prod on 2026-06-14 (Glassdoor + Monster both cooled down).
            usablePlatforms = [...PLATFORM_NAMES];
        }

        // Exclude platforms on a LOCAL cooldown (Cloudflare/DataDome
        // back-off markers). Without this the orchestrator keeps claiming work
        // for a cooled-down platform that then instant-fails at scrape time,
        // churning 0-result sessions — prod 2026-06-14 burned ~185/min this way
        // once Glassdoor + Monster were both cooled down. This must run
        // unconditionally (not just when the pre-flight succeeded) — that
        // guard is exactly what let the incident happen.
        const cooled = this._cooldownCheck().filter((p) => usablePlatforms.includes(p));
        if (cooled.length > 0) {
            log.info('Platforms on local cooldown — excluded from claim', { cooled });
            usablePlatforms = usablePlatforms.filter((p) => !cooled.includes(p));
            if (usablePlatforms.length === 0) {
                log.info('All usable platforms are on local cooldown — skipping claim');
                metrics.recordQueueCheck('all_cooldown');
                return { assignments: [] };
            }
        }

        // Exclude platforms the operator locally paused via the control
        // panel (src/panel/overrides.js). Host-local, not a backend concept
        // — a paused platform still shows up in the allowlist, it's just
        // never claimed by THIS host until resumed.
        const paused = this.#overrides().pausedList().filter((p) => usablePlatforms.includes(p));
        if (paused.length > 0) {
            log.info('Platforms locally paused — excluded from claim', { paused });
            usablePlatforms = usablePlatforms.filter((p) => !paused.includes(p));
            if (usablePlatforms.length === 0) {
                log.info('All usable platforms are locally paused — skipping claim');
                metrics.recordQueueCheck('all_paused');
                return { assignments: [] };
            }
        }

        // A group source has its own durable cadence in the backend. Keep its
        // eligibility separate from the role sweep gate below, so a LinkedIn
        // role sweep that is not due cannot starve the configured group feed.
        // The normal role claim still honors the existing per-platform cadence.
        const groupEligible = usablePlatforms.includes('linkedin')
            && !this.#hasActivePlatform('linkedin');

        // Exclude platforms whose next SWEEP isn't due yet (see
        // ./sweep-schedule.js). A platform with no configured cadence is always
        // claimable, so this is inert for everything an operator hasn't
        // deliberately slowed. Indeed was re-scraping every role every ~5 min
        // for a 0.29% import rate; an hourly sweep drains the same queue in
        // ~1/12th of the sessions.
        const schedule = this.#schedule();
        let normalPlatforms = usablePlatforms.filter((p) => schedule.isClaimable(p));
        const notDue = usablePlatforms.filter((p) => !normalPlatforms.includes(p));
        if (notDue.length > 0) {
            log.info('Platforms not due for a sweep — excluded from claim', { notDue });
        }

        // A group session owns the LinkedIn credential path just like a normal
        // LinkedIn assignment. Let unrelated platforms proceed, while keeping
        // a normal LinkedIn role from overlapping the active group session.
        if (this.#hasActiveGroupPlatform('linkedin')) {
            normalPlatforms = normalPlatforms.filter((p) => p !== 'linkedin');
        }

        // A continuously due role queue must not win every LinkedIn turn.
        // When the group turn is first, claim it before asking for normal
        // LinkedIn work and remove LinkedIn from that role claim if it wins.
        // A 204/404 falls through to the ordinary role claim in this cycle.
        const canTryGroup = groupEligible && typeof this.client.claimLinkedInGroup === 'function';
        let groupAssignment = null;
        let groupAttempted = false;
        if (canTryGroup && this._preferGroupNext) {
            groupAttempted = true;
            groupAssignment = await this.#claimGroupAssignment();
            if (groupAssignment) normalPlatforms = normalPlatforms.filter((p) => p !== 'linkedin');
        }

        // Open a sweep for any scheduled platform we're about to claim.
        for (const platform of normalPlatforms) schedule.begin(platform);

        let queueResult;
        if (normalPlatforms.length === 0) {
            queueResult = { assignments: [] };
            if (notDue.length > 0) metrics.recordQueueCheck('not_due');
        } else {
            try {
                queueResult = await this.client.getNextRole({ platforms: normalPlatforms });
            } catch (error) {
                metrics.recordQueueCheck('error');
                // An ambiguous claim failure may already have been
                // COMMITTED by the backend (session + RPQ claim created before our
                // HTTP read timed out). That orphans the session — the backend
                // won't issue new work for those platforms until the 1-hour
                // stale-session sweep. Recover by resuming our active session
                // instead of stranding it. See incident 2026-06-23.
                if (isAmbiguousClaimFailure(error)) {
                    const recovered = await this.#recoverOrphanedSession('role');
                    if (recovered && !recovered.group) return { assignments: [recovered] };
                }
                throw error;
            }
        }

        let assignments = queueResult?.assignments || [];
        const closeUnassignedNormalSweeps = () => {
            const assignedNormalPlatforms = new Set(
                assignments
                    .filter((assignment) => !assignment.group)
                    .flatMap((assignment) => (assignment.platforms ?? []).map((platform) => (
                        typeof platform === 'string' ? platform : platform?.name
                    )))
                    .filter(Boolean)
                    .map((platform) => String(platform).toLowerCase()),
            );
            for (const platform of normalPlatforms) {
                if (assignedNormalPlatforms.has(String(platform).toLowerCase())) continue;
                if (this.#hasActivePlatform(platform)) continue;
                schedule.end(platform);
            }
        };
        if (assignments.length === 0) {
            // Nothing left for normal role work this pass — close only the
            // normal sweep that was actually considered. A group claim below
            // has no effect on this cadence state.
            closeUnassignedNormalSweeps();
            assignments = [];
            metrics.recordQueueCheck('empty');
        } else {
            // A multi-platform claim can return only the pairs currently
            // available. Close every sweep that was opened for this request
            // but was not returned, unless an already-running session still
            // owns that platform and needs to drain it.
            closeUnassignedNormalSweeps();
        }

        // On the normal-first turn, give the optional group source its chance
        // when no normal LinkedIn assignment was returned. This keeps the
        // existing role-first behavior while bounding starvation through the
        // alternating first-turn preference above.
        const normalLinkedInAssigned = assignments.some(
            (assignment) => this.#assignmentHasPlatform(assignment, 'linkedin'),
        );
        if (canTryGroup && !groupAttempted && !normalLinkedInAssigned) {
            groupAttempted = true;
            groupAssignment = await this.#claimGroupAssignment();
        }
        if (groupAssignment) assignments.push(groupAssignment);

        if (canTryGroup) {
            // If normal LinkedIn work consumed this turn, make the next
            // eligible cycle group-first. A group turn, including a 204/404,
            // hands the next cycle back to normal role work.
            this._preferGroupNext = normalLinkedInAssigned && !groupAssignment;
        }

        if (assignments.length === 0) {
            log.info('Queue empty');
            // `normalPlatforms` was already ended above when it was queried.
            // This second branch is for a group-only-ineligible cycle.
            return { ...queueResult, assignments };
        }
        metrics.recordQueueCheck('job_found');

        log.info('Batch acquired', {
            count: assignments.length,
            roles: assignments.map((a) => this.#assignmentLabel(a)),
            totalPlatforms: assignments.reduce((sum, a) => sum + (a.platforms?.length ?? 0), 0),
        });
        for (const assignment of assignments) {
            // Group sources have their own durable cadence in the backend and
            // must not open or advance the normal role sweep clock.
            if (assignment.group) continue;
            for (const platform of assignment.platforms ?? []) {
                // The claim response returns platforms as OBJECTS
                // ({id, name, display_name}) while the gating path above works in
                // plain strings. Passing the object straight through stringified
                // it to "[object object]", so every sweep's roles/sessions landed
                // in one junk bucket and the per-platform summary that makes the
                // cadence change measurable always read 0. Observed live on m1.
                schedule.record(platform?.name ?? platform, { roles: 1, sessions: 1 });
            }
        }
        return { ...queueResult, assignments };
    }

    /**
     * Recover an orphaned in-progress session after an ambiguous claim failure.
     *
     * When a claim times out or returns an ambiguous transport/5xx error, the
     * backend may already have created the session + claim. Ask the backend for
     * the source-filtered current active session; if it still has pending platforms,
     * return it as an assignment so runOnce resumes it — finishing the work
     * rather than stranding it for the 1-hour stale-session sweep. Returns null
     * when there's nothing to resume (no active session, no pending platforms,
     * or the lookup itself fails). See incident 2026-06-23.
     */
    async #recoverOrphanedSession(source = null) {
        let active;
        try {
            active = await this.client.checkActiveSession(source ? { source } : undefined);
        } catch (err) {
            log.warn('Orphaned-session recovery check failed', { source, err: err.message });
            return null;
        }
        const session = active?.has_active_session ? active.session : null;
        const platforms = session?.platforms;
        if (!session || !Array.isArray(platforms) || platforms.length === 0) {
            return null;
        }
        const group = session.group ?? (
            session.group_source_id !== undefined
            && session.group_id !== undefined
            && session.group_url
                ? {
                    source_id: session.group_source_id,
                    id: session.group_id,
                    url: session.group_url,
                    checkpoint: session.group_checkpoint ?? null,
                }
                : null
        );
        const roleName = group ? `LinkedIn group ${group.id}` : session.role_name;
        log.warn('Recovered orphaned session after ambiguous claim — resuming', {
            sessionId: session.session_id,
            role: roleName,
            group: group?.id ?? null,
            platforms: platforms.map((p) => p.name),
            scraper_alert: 'orphan_recovered',
        });
        this.#metrics().recordQueueCheck('recovered_orphan');
        return {
            session_id: session.session_id,
            ...(group
                ? { role: null, group }
                : { role: { name: session.role_name, search_queries: session.search_queries ?? null } }),
            // Carried through so a resumed candidate-query session re-runs the
            // recruiter's boolean rather than silently degrading to a role sweep
            // — the backend has already flagged that session to bypass the
            // relevance filter, so a role-shaped scrape under it would import
            // unfiltered results.
            candidate_query: session.candidate_query ?? null,
            platforms,
        };
    }

    /**
     * Run one assignment end-to-end: scrape every platform in parallel,
     * then complete the assignment's session.
     */
    async #runAssignment(assignment, metrics) {
        const { session_id: sessionId, role = null, group = null, platforms = [] } = assignment;
        const isGroup = Boolean(group);
        const roleName = this.#assignmentLabel(assignment);
        const location = this.defaultLocation;
        log.info('Assignment started', {
            sessionId, role: roleName, group: group?.id ?? null, location,
            platforms: platforms.map((p) => typeof p === 'string' ? p : p.name),
        });

        const results = {
            session_id: sessionId,
            role: roleName,
            ...(isGroup ? { group } : {}),
            location,
            platforms: {},
            summary: {
                total_platforms: platforms.length,
                successful: 0,
                failed: 0,
            },
        };

        // Panel-only bookkeeping (read via snapshot()) — tracks this
        // in-flight session so the control panel can show "what's running
        // right now" without touching the workflow itself. Removed in the
        // `finally` below regardless of outcome.
        this._activeSessions.set(sessionId, {
            role: roleName,
            group: isGroup,
            startedAt: Date.now(),
            platforms: Object.fromEntries(platforms.map((p) => {
                const name = typeof p === 'string' ? p : p.name;
                return [String(name).toLowerCase(), 'pending'];
            })),
        });

        // Run platforms IN PARALLEL within an assignment. Most scrapers are
        // self-contained (own browser context + credential lease per scrape).
        // EXCEPTION: LinkedIn shares a cached cookie jar and credential lease
        // across roles (the LinkedInRscSession singleton, which is single-flight
        // so concurrent borrowers don't double-read the profile).
        // Concurrency stays safe either way. Failures are isolated via
        // Promise.allSettled + per-task try/catch.
        //
        // After EACH platform task settles (success or fail), we kick a
        // fresh poll cycle so that platform's slot doesn't sit idle
        // waiting for siblings. The mutex short-circuits if a poll is
        // already in flight, and the backend's in-flight filter excludes
        // platforms still mid-scrape — so over-claiming is impossible.
        const tasks = platforms.map(async (platformInfo) => {
            const platformName = String(
                typeof platformInfo === 'string' ? platformInfo : platformInfo.name,
            ).toLowerCase();
            const scraper = isGroup ? this._groupScraper : this._resolveScraper(platformName);

            const triggerNextPoll = () => this.#schedulePoll(platformName);
            const failedSubmitMeta = isGroup ? { group } : {};

            if (!scraper) {
                log.warn('Unknown platform', { platformName });
                await this.#safeSubmit(
                    sessionId, platformName, [], 'failed', 'Platform not supported', failedSubmitMeta,
                );
                this.#markPlatform(sessionId, platformName, 'failed');
                triggerNextPoll();
                return { platformName, result: { success: false, error: 'Platform not supported' } };
            }

            try {
                // Role scrapers receive the existing search context. Group
                // collection receives source provenance and no fabricated role
                // or query, so it cannot accidentally use content-search.
                const executeOptions = isGroup
                    ? { group }
                    : {
                        searchQueries: role.search_queries || null,
                        candidateQuery: assignment.candidate_query?.query || null,
                    };
                const output = await scraper.executeWithMeta(
                    isGroup ? null : role.name,
                    location,
                    sessionId,
                    executeOptions,
                );
                const jobs = Array.isArray(output?.jobs) ? output.jobs : [];
                const emptyConfirmed = output?.emptyConfirmed === true;
                const groupProgress = output?.groupProgress ?? output?.group_progress ?? null;
                const formatted = jobs.map((job) => formatJobForBlacklight(job, platformName));
                const submitMeta = { emptyConfirmed };
                if (isGroup) {
                    submitMeta.group = group;
                    submitMeta.groupProgress = groupProgress;
                }
                const submitResponse = await this.client.submitJobs(
                    sessionId, platformName, formatted, 'success', null, submitMeta,
                );

                if (formatted.length === 0) {
                    // SCR-20 (#403): the wire status stays 'success', but it now
                    // carries `empty_confirmed` so the backend can tell a
                    // positively-verified empty result from the silent-block
                    // signature. That was the "needs backend coordination"
                    // piece this comment used to defer.
                    log.warn(
                        emptyConfirmed
                            ? 'Submitted 0 jobs — confirmed empty (no results for this query)'
                            : 'Submitted 0 jobs as success — possible silent block',
                        {
                            platform: platformName,
                            sessionId,
                            group: group?.id ?? null,
                            emptyConfirmed,
                            // Keep the alert tag ONLY for the suspicious case; a
                            // confirmed empty is normal and must not page anyone.
                            scraper_alert: emptyConfirmed ? undefined : 'submitted_zero',
                        },
                    );
                } else {
                    log.info('Jobs submitted', {
                        platform: platformName,
                        group: group?.id ?? null,
                        jobCount: formatted.length,
                        progress: submitResponse.progress,
                    });
                }
                metrics.recordJobsSubmitted(platformName, 'success', formatted.length);
                this.#markPlatform(sessionId, platformName, 'success');
                triggerNextPoll();

                return {
                    platformName,
                    result: {
                        success: true,
                        jobs_found: jobs.length,
                        jobs_submitted: formatted.length,
                    },
                };
            } catch (error) {
                // Race-window: scraper acquired no credential between
                // orchestrator pre-flight and acquire(). Distinct from a
                // real scrape failure — log at info, tag the metric so
                // dashboards don't conflate it with real platform
                // failures (e.g. captcha, timeout).
                if (error.skipNoCreds) {
                    log.info('Platform skipped — no credentials (race with pre-flight)', {
                        platform: platformName,
                    });
                    const groupProgress = error.groupProgress ?? error.group_progress ?? null;
                    await this.#safeSubmit(sessionId, platformName, [], 'failed', error.message, {
                        ...failedSubmitMeta,
                        ...(groupProgress ? { groupProgress } : {}),
                    });
                    metrics.recordJobsSubmitted(platformName, 'no_creds', 0);
                } else {
                    log.error('Platform scrape failed', { platform: platformName, err: error.message });
                    const groupProgress = error.groupProgress ?? error.group_progress ?? null;
                    await this.#safeSubmit(sessionId, platformName, [], 'failed', error.message, {
                        ...failedSubmitMeta,
                        ...(groupProgress ? { groupProgress } : {}),
                    });
                    metrics.recordJobsSubmitted(platformName, 'failed', 0);
                }
                this.#markPlatform(sessionId, platformName, 'failed');
                triggerNextPoll();
                return { platformName, result: { success: false, error: error.message } };
            }
        });

        try {
            const settled = await Promise.allSettled(tasks);
            for (const entry of settled) {
                if (entry.status === 'fulfilled') {
                    const { platformName, result } = entry.value;
                    results.platforms[platformName] = result;
                    if (result.success) results.summary.successful += 1;
                    else results.summary.failed += 1;
                } else {
                    log.error('Platform task threw unexpectedly', { err: entry.reason?.message });
                    results.summary.failed += 1;
                }
            }

            // C3 (spec): an assignment where every platform failed must NOT be
            // silently treated as a normal completion. We still call
            // completeSession (the backend coordinates sibling sessions for the
            // same role and must receive it), but we flag it loudly + on a
            // dedicated metric so a dashboard/alert can distinguish "role done,
            // 0 jobs because all platforms broke" from "role done normally".
            if (results.summary.total_platforms > 0 && results.summary.successful === 0) {
                log.error('All platforms failed for assignment — completing session anyway (backend coordination)', {
                    sessionId,
                    role: roleName,
                    group: group?.id ?? null,
                    totalPlatforms: results.summary.total_platforms,
                    scraper_alert: 'session_all_failed',
                });
                metrics.recordSessionAllFailed();
            }

            try {
                const completion = await this.client.completeSession(sessionId);
                results.completion = completion;
                log.info('Session completed', {
                    sessionId,
                    role: roleName,
                    group: group?.id ?? null,
                    durationSec: completion.duration_seconds,
                    imported: completion.jobs?.total_imported,
                    found: completion.jobs?.total_found,
                });
            } catch (error) {
                log.error('Session completion failed', { sessionId, err: error.message });
                results.completion_error = error.message;
            }

            return results;
        } finally {
            // Panel bookkeeping cleanup — the session is no longer in flight
            // regardless of how the block above finished.
            this._activeSessions.delete(sessionId);
        }
    }

    // Panel-only: record a platform's terminal state on its tracked session.
    // A no-op if the session isn't tracked (shouldn't happen — set at the top
    // of #runAssignment — but this must never throw into the scrape path).
    #markPlatform(sessionId, platformName, state) {
        const session = this._activeSessions.get(sessionId);
        if (session) session.platforms[platformName] = state;
    }

    async #safeSubmit(sessionId, platform, jobs, status, errorMessage, meta = {}) {
        try {
            await this.client.submitJobs(sessionId, platform, jobs, status, errorMessage, meta);
        } catch (error) {
            log.error('Failed to report platform result', { platform, err: error.message });
        }
    }
}
