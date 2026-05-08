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

const log = createLogger('orchestrator');

export class QueueOrchestrator {
    constructor({ blacklightConfig, queueConfig, defaultLocation }) {
        if (!blacklightConfig) {
            throw new Error('QueueOrchestrator requires blacklightConfig');
        }
        this.client = new BlacklightApiClient(blacklightConfig.apiUrl, blacklightConfig.apiKey);
        this.queueConfig = queueConfig;
        // Per-platform scrapers still need a location string for their search
        // URL (e.g. LinkedIn's `&location=`). The backend no longer drives
        // location-specific scraping, so each scraper instance picks a default
        // — "United States" works for US-bench-sales recruiting; override via
        // SCRAPER_DEFAULT_LOCATION if you want a tighter geographic scope.
        this.defaultLocation = defaultLocation || 'United States';
        this.mutex = new Mutex();
        this.autoInterval = null;
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
            getMetrics().recordQueueCheck('skipped_busy');
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
            this.#runAssignment(assignment, getMetrics()).catch((err) => {
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
     */
    async #claim() {
        const metrics = getMetrics();
        log.info('Starting queue cycle');

        let queueResult;
        try {
            queueResult = await this.client.getNextRole();
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

        // Run platforms IN PARALLEL within an assignment. Each scrape
        // is self-contained (its own browser context, its own credential
        // lease) so concurrency is safe. Failures are isolated via
        // Promise.allSettled + per-task try/catch.
        const tasks = platforms.map(async (platformInfo) => {
            const platformName = platformInfo.name.toLowerCase();
            const scraper = getScraper(platformName);

            if (!scraper) {
                log.warn('Unknown platform', { platformName });
                await this.#safeSubmit(sessionId, platformName, [], 'failed', 'Platform not supported');
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

                log.info('Jobs submitted', {
                    platform: platformName,
                    jobCount: formatted.length,
                    progress: submitResponse.progress,
                });
                metrics.recordJobsSubmitted(platformName, 'success', formatted.length);

                return {
                    platformName,
                    result: {
                        success: true,
                        jobs_found: jobs.length,
                        jobs_submitted: formatted.length,
                    },
                };
            } catch (error) {
                log.error('Platform scrape failed', { platform: platformName, err: error.message });
                await this.#safeSubmit(sessionId, platformName, [], 'failed', error.message);
                metrics.recordJobsSubmitted(platformName, 'failed', 0);
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
