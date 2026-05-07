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
     * Runs a single queue cycle. Safe to call concurrently — the mutex
     * ensures only one run is active at a time; extra callers short-circuit
     * with `{ skipped: true }`.
     */
    async runOnce() {
        if (!this.mutex.tryAcquire()) {
            log.info('Queue run skipped — already processing');
            getMetrics().recordQueueCheck('skipped_busy');
            return { skipped: true };
        }
        try {
            return await this.#doRun();
        } finally {
            this.mutex.release();
        }
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

    async #doRun() {
        const metrics = getMetrics();
        log.info('Starting queue cycle');

        let sessionCheck;
        try {
            sessionCheck = await this.client.checkActiveSession();
        } catch (error) {
            metrics.recordQueueCheck('error');
            throw error;
        }
        if (sessionCheck.has_active_session) {
            log.warn('Active session already exists', {
                sessionId: sessionCheck.session?.session_id,
                role: sessionCheck.session?.role_name,
            });
            metrics.recordQueueCheck('active_session');
            return { error: 'Active session already exists. Complete it first.' };
        }

        let queueItem;
        try {
            queueItem = await this.client.getNextRole();
        } catch (error) {
            metrics.recordQueueCheck('error');
            throw error;
        }
        if (!queueItem) {
            log.info('Queue empty');
            metrics.recordQueueCheck('empty');
            return { message: 'Queue is empty' };
        }
        metrics.recordQueueCheck('job_found');

        const { session_id: sessionId, role, platforms } = queueItem;
        const location = this.defaultLocation;
        log.info('Queue item acquired', {
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

        // Run platforms IN PARALLEL within a session.
        //
        // Previously this was a sequential `for...of` loop, so a role's
        // wall-clock = sum(monster_time + dice_time + techfetch_time) ≈ 130s
        // for our 3-platform allowlist. Sequential execution had no shared
        // state between platforms — each scraper.execute() is self-contained
        // (its own browser context, its own credential lease) — so the
        // sequencing was pure overhead.
        //
        // Each task already wraps its own try/catch and reports failures via
        // #safeSubmit, so Promise.allSettled here cannot poison the session.
        // Memory peak goes up because dice + techfetch both run Playwright
        // browsers concurrently (monster is HTTP-only). Measured peak on
        // CPX21 (4 GB RAM): ~1.7 GB — well within MemoryMax=3G.
        const tasks = platforms.map(async (platformInfo) => {
            const platformName = platformInfo.name.toLowerCase();
            const scraper = getScraper(platformName);

            if (!scraper) {
                log.warn('Unknown platform', { platformName });
                await this.#safeSubmit(sessionId, platformName, [], 'failed', 'Platform not supported');
                return { platformName, result: { success: false, error: 'Platform not supported' } };
            }

            try {
                // Pass the AI-generated LinkedIn search queries (if the
                // backend populated them) through to the scraper. Only
                // LinkedIn looks at this today; other scrapers ignore the
                // extra field. Missing/null = legacy single-template
                // fallback inside the scraper.
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
                // Task itself threw before our inner try/catch — shouldn't
                // happen, but log + count it as a failure rather than crash.
                log.error('Platform task threw unexpectedly', { err: entry.reason?.message });
                results.summary.failed += 1;
            }
        }

        try {
            const completion = await this.client.completeSession(sessionId);
            results.completion = completion;
            log.info('Session completed', {
                sessionId,
                durationSec: completion.duration_seconds,
                imported: completion.jobs?.total_imported,
                found: completion.jobs?.total_found,
            });
        } catch (error) {
            log.error('Session completion failed', { err: error.message });
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
