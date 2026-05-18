// BaseScraper — thin lifecycle wrapper shared by every platform scraper.
//
// Wraps the platform scraper function with:
//   • scoped logging (start, finish, duration)
//   • structured error normalization (any throw becomes ScraperError)
//   • a normalized return contract so "0 jobs" is no longer silently
//     assumed to be success (spec F12 / C1 seam)
//
// Return contract (backward compatible): the scraper function may return
//   - an Array of jobs (legacy; treated as emptyConfirmed:false), or
//   - { jobs: Array, emptyConfirmed?: boolean }
// `emptyConfirmed` must be set true ONLY when the scraper positively
// confirmed a real empty result set (Plan 1C). Default production
// behavior is unchanged: unconfirmed-empty still returns [] and records
// success unless opt-in strict mode is enabled.

import { createLogger } from '../logger/index.js';
import { ScraperError, BlockedError } from './errors.js';
import { getMetrics } from '../metrics/registry.js';
import { classifyError } from '../metrics/classify.js';

function normalizeResult(result) {
    if (Array.isArray(result)) {
        return { jobs: result, emptyConfirmed: false };
    }
    if (result && Array.isArray(result.jobs)) {
        return { jobs: result.jobs, emptyConfirmed: result.emptyConfirmed === true };
    }
    // Non-array / missing `jobs`, or null/undefined → bad/empty return
    // treated as UNCONFIRMED empty on purpose: it must surface loudly
    // via the zero-jobs path, never silently as a confirmed success.
    return { jobs: [], emptyConfirmed: false };
}

export class BaseScraper {
    constructor(platform, scraperFn, options = {}) {
        if (!platform) throw new Error('BaseScraper requires a platform name');
        if (typeof scraperFn !== 'function') {
            throw new Error(`BaseScraper(${platform}) requires a scraper function`);
        }
        this.platform = platform;
        this.scraperFn = scraperFn;
        this.log = createLogger(platform);
        this._metrics = options.metrics ?? null;
        this.strictEmpty = options.strictEmpty
            ?? (process.env.SCRAPER_STRICT_EMPTY === 'true');
    }

    /**
     * @param {string} jobTitle
     * @param {string} location
     * @param {string|null} sessionId
     * @param {{searchQueries?: string[] | null}} [options]
     *   Optional per-platform extras the orchestrator passes through —
     *   today only LinkedIn looks at `searchQueries` (AI-generated
     *   boolean variants from the backend); other scrapers ignore.
     * @returns {Promise<Array<object>>}
     */
    async execute(jobTitle, location, sessionId = null, options = {}) {
        const start = Date.now();
        const metrics = this._metrics ?? getMetrics();
        this.log.info('Starting scrape', { jobTitle, location, sessionId });
        try {
            const raw = await this.scraperFn(jobTitle, location, sessionId, options);
            const { jobs, emptyConfirmed } = normalizeResult(raw);
            const durationMs = Date.now() - start;
            const jobCount = jobs.length;

            if (jobCount === 0 && !emptyConfirmed) {
                this.log.warn('Scrape returned 0 jobs (unconfirmed) — possible block / DOM change', {
                    durationMs,
                    scraper_alert: 'zero_jobs_unconfirmed',
                });
                metrics.noteZeroJobs?.(this.platform);
                if (this.strictEmpty) {
                    throw new BlockedError(
                        'Scrape returned 0 jobs with no confirmed-empty signal — suspected block / DOM change',
                        { platform: this.platform, kind: null },
                    );
                }
            } else if (jobCount === 0) {
                this.log.info('Scrape complete (confirmed empty)', { jobCount: 0, durationMs });
            } else {
                this.log.info('Scrape complete', { jobCount, durationMs });
            }

            metrics.recordSession(this.platform, 'success', durationMs);
            metrics.recordJobsScraped(this.platform, jobCount);
            return jobs;
        } catch (error) {
            const durationMs = Date.now() - start;
            const reason = classifyError(error);
            this.log.error('Scrape failed', {
                err: error?.message ?? 'unknown',
                reason,
                durationMs,
                scraper_alert:
                    reason === 'auth_required' ? 'auth_required'
                    : reason === 'blocked' ? 'blocked'
                    : undefined,
            });
            metrics.recordSession(this.platform, 'failed', durationMs);
            metrics.recordFailure(this.platform, reason);
            if (error instanceof ScraperError) throw error;
            throw new ScraperError(error?.message ?? 'Scraper failed', {
                platform: this.platform,
                cause: error,
            });
        }
    }
}
