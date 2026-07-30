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
// confirmed a real empty result set. The generic wrapper defaults to
// compatibility mode; the active registry opts every platform into strict
// handling.

import { createLogger } from '../logger/index.js';
import { ScraperError, BlockedError } from './errors.js';
import { getProxyPool } from './proxy-pool.js';
import { getMetrics } from '../metrics/registry.js';
import { classifyError } from '../metrics/classify.js';
import { classifyUrl } from './url-quality.js';

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
    /**
     * Scrape and return just the jobs array.
     *
     * Kept returning a bare array deliberately: the ad-hoc /scrape route and the
     * existing tests depend on that shape. Callers that need the
     * confirmed-empty signal use {@link executeWithMeta} instead.
     *
     * @returns {Promise<Array<object>>}
     */
    async execute(jobTitle, location, sessionId = null, options = {}) {
        const { jobs } = await this.executeWithMeta(jobTitle, location, sessionId, options);
        return jobs;
    }

    /**
     * Scrape and return the jobs plus whether an empty result was CONFIRMED.
     *
     * SCR-20 (#403): `emptyConfirmed` was computed here and then discarded, so a
     * zero-job scrape reached the backend looking identical to a silent block.
     * The orchestrator now forwards it on the wire.
     *
     * @returns {Promise<{jobs: Array<object>, emptyConfirmed: boolean}>}
     */
    async executeWithMeta(jobTitle, location, sessionId = null, options = {}) {
        const start = Date.now();
        const metrics = this._metrics ?? getMetrics();
        this.log.info('Starting scrape', { jobTitle, location, sessionId });
        try {
            const raw = await this.scraperFn(jobTitle, location, sessionId, options);
            const { jobs, emptyConfirmed } = normalizeResult(raw);
            const durationMs = Date.now() - start;
            const jobCount = jobs.length;

            try {
                for (const job of jobs) {
                    metrics.recordUrlQuality?.(this.platform, classifyUrl(job?.url));
                }
            } catch (_e) {
                // Observability must never crash the scraping path.
            }

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
            // This scrape's proxy IP worked — clear any cooldown on it.
            try { getProxyPool().reportOk(this.platform); } catch { /* never crash the path */ }
            // `emptyConfirmed` is only meaningful when jobCount === 0. A non-empty
            // result is reported false so the backend never has to reason about
            // "confirmed empty but 12 jobs".
            return { jobs, emptyConfirmed: jobCount === 0 && emptyConfirmed === true };
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
            // A block almost always means THIS scrape's proxy IP got flagged —
            // cool it down so the next scrape rotates to a different IP.
            if (reason === 'blocked') {
                try { getProxyPool().reportBlocked(this.platform); } catch { /* never crash the path */ }
            }
            if (error instanceof ScraperError) throw error;
            throw new ScraperError(error?.message ?? 'Scraper failed', {
                platform: this.platform,
                cause: error,
            });
        }
    }
}
