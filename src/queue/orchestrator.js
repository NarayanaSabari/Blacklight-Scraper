// Queue orchestrator — the end-to-end Blacklight workflow:
//
//   1. Check for an active session (resume if found)
//   2. Pull the next role off the queue (backend filters platforms by this
//      key's platform_allowlist, if set)
//   3. For each returned platform: run scraper → format → submit jobs
//   4. Complete the session — backend coordinates with sibling sessions
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

const log = createLogger('orchestrator');

export class QueueOrchestrator {
    constructor({ blacklightConfig, queueConfig, defaultLocation, client = null, metrics = null, scraperResolver = null }) {
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
        // Injection seams (default to the production singletons). Behavior-
        // neutral: server.js passes none of these, so construction is
        // identical to before. Tests inject fakes to exercise the workflow
        // without live HTTP / the real scraper registry.
        this._metrics = metrics;
        this._resolveScraper = scraperResolver ?? getScraper;
    }

    // Resolve the metrics sink: injected fake in tests, global registry in prod.
    #metrics() {
        return this._metrics ?? getMetrics();
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
    async runOnce() {
        if (!this.mutex.tryAcquire()) {
            log.info('Queue run skipped — claim already in flight');
            this.#metrics().recordQueueCheck('skipped_busy');
            return { skipped: true };
        }
        let queueResult;
        try {
            queueResult = await this.#claim();
        } finally {
            this.mutex.release();
        }

        const assignments = queueResult?.assignments || [];
        if (assignments.length === 0) {
            return { message: 'Queue is empty for idle platforms' };
        }

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
        return { batched: assignments.length, roles: assignments.map((a) => a.role.name) };
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

    // ----- internals --------------------------------------------------------

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
            // by static allowlist). Log so it's visible.
            log.warn('Credential availability pre-flight failed; falling back to static allowlist', {
                err: error.message,
            });
            usablePlatforms = null;
        }

        // Also exclude platforms on a LOCAL cooldown (Cloudflare/DataDome
        // back-off markers). Without this the orchestrator keeps claiming work
        // for a cooled-down platform that then instant-fails at scrape time,
        // churning 0-result sessions — prod 2026-06-14 burned ~185/min this way
        // once Glassdoor + Monster were both cooled down.
        if (Array.isArray(usablePlatforms)) {
            const cooled = platformsOnCooldown().filter((p) => usablePlatforms.includes(p));
            if (cooled.length > 0) {
                log.info('Platforms on local cooldown — excluded from claim', { cooled });
                usablePlatforms = usablePlatforms.filter((p) => !cooled.includes(p));
                if (usablePlatforms.length === 0) {
                    log.info('All usable platforms are on local cooldown — skipping claim');
                    metrics.recordQueueCheck('all_cooldown');
                    return { assignments: [] };
                }
            }
        }

        let queueResult;
        try {
            queueResult = await this.client.getNextRole({ platforms: usablePlatforms });
        } catch (error) {
            metrics.recordQueueCheck('error');
            throw error;
        }

        const assignments = queueResult?.assignments || [];
        if (assignments.length === 0) {
            log.info('Queue empty');
            metrics.recordQueueCheck('empty');
            return queueResult;
        }
        metrics.recordQueueCheck('job_found');

        log.info('Batch acquired', {
            count: assignments.length,
            roles: assignments.map((a) => a.role.name),
            totalPlatforms: assignments.reduce((sum, a) => sum + a.platforms.length, 0),
        });
        return queueResult;
    }

    /**
     * Run one assignment end-to-end: scrape every platform in parallel,
     * then complete the session. Mirrors the old single-role flow.
     */
    async #runAssignment(assignment, metrics) {
        const { session_id: sessionId, role, platforms } = assignment;
        const location = this.defaultLocation;
        log.info('Assignment started', {
            sessionId, role: role.name, location,
            platforms: platforms.map((p) => p.name),
        });

        const results = {
            session_id: sessionId,
            role: role.name,
            location,
            platforms: {},
            summary: {
                total_platforms: platforms.length,
                successful: 0,
                failed: 0,
            },
        };

        // Run platforms IN PARALLEL within an assignment. Most scrapers are
        // self-contained (own browser context + credential lease per scrape).
        // EXCEPTION: LinkedIn now shares ONE long-lived browser context +
        // credential lease across roles (the LinkedInSession singleton, which
        // is single-flight so concurrent borrowers don't double-lease/launch).
        // Concurrency stays safe either way. Failures are isolated via
        // Promise.allSettled + per-task try/catch.
        //
        // After EACH platform task settles (success or fail), we kick a
        // fresh poll cycle so that platform's slot doesn't sit idle
        // waiting for siblings. The mutex short-circuits if a poll is
        // already in flight, and the backend's in-flight filter excludes
        // platforms still mid-scrape — so over-claiming is impossible.
        const tasks = platforms.map(async (platformInfo) => {
            const platformName = platformInfo.name.toLowerCase();
            const scraper = this._resolveScraper(platformName);

            const triggerNextPoll = () => {
                setImmediate(() => this.runOnce().catch((err) => {
                    log.error('Post-platform claim failed', {
                        platform: platformName, err: err.message,
                    });
                }));
            };

            if (!scraper) {
                log.warn('Unknown platform', { platformName });
                await this.#safeSubmit(sessionId, platformName, [], 'failed', 'Platform not supported');
                triggerNextPoll();
                return { platformName, result: { success: false, error: 'Platform not supported' } };
            }

            try {
                // Pass AI-generated LinkedIn search queries (if any)
                // through to the scraper. Only LinkedIn looks at it
                // today; others ignore the extra option.
                const jobs = await scraper.execute(role.name, location, sessionId, {
                    searchQueries: role.search_queries || null,
                });
                const formatted = jobs.map((job) => formatJobForBlacklight(job, platformName));
                const submitResponse = await this.client.submitJobs(sessionId, platformName, formatted, 'success');

                if (formatted.length === 0) {
                    // O9 (spec): the wire status stays 'success' (changing it
                    // needs backend coordination — deferred), but a 0-job
                    // "success" is the silent-block signature. Emit a distinct
                    // Loki-queryable signal so it is not buried among healthy
                    // submissions. The metric dimension is already covered by
                    // scraper_zero_result_sessions_total (Plan 1B, scraper layer).
                    log.warn('Submitted 0 jobs as success — possible silent block / empty result', {
                        platform: platformName,
                        sessionId,
                        scraper_alert: 'submitted_zero',
                    });
                } else {
                    log.info('Jobs submitted', {
                        platform: platformName,
                        jobCount: formatted.length,
                        progress: submitResponse.progress,
                    });
                }
                metrics.recordJobsSubmitted(platformName, 'success', formatted.length);
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
                    await this.#safeSubmit(sessionId, platformName, [], 'failed', error.message);
                    metrics.recordJobsSubmitted(platformName, 'no_creds', 0);
                } else {
                    log.error('Platform scrape failed', { platform: platformName, err: error.message });
                    await this.#safeSubmit(sessionId, platformName, [], 'failed', error.message);
                    metrics.recordJobsSubmitted(platformName, 'failed', 0);
                }
                triggerNextPoll();
                return { platformName, result: { success: false, error: error.message } };
            }
        });

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
                role: role.name,
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
                role: role.name,
                durationSec: completion.duration_seconds,
                imported: completion.jobs?.total_imported,
                found: completion.jobs?.total_found,
            });
        } catch (error) {
            log.error('Session completion failed', { sessionId, err: error.message });
            results.completion_error = error.message;
        }

        return results;
    }

    async #safeSubmit(sessionId, platform, jobs, status, errorMessage) {
        try {
            await this.client.submitJobs(sessionId, platform, jobs, status, errorMessage);
        } catch (error) {
            log.error('Failed to report platform result', { platform, err: error.message });
        }
    }
}
