// BaseScraper — thin lifecycle wrapper shared by every platform scraper.
//
// This wraps the platform scraper function with:
//   • scoped logging (start, finish, duration)
//   • structured error normalization (any throw becomes ScraperError)
//
// Credential acquisition stays inside the concrete scraper module — each
// platform already knows how to fetch its own credential from the API.
// BaseScraper stays deliberately dumb so the scraping logic can evolve
// independently.

import { createLogger } from '../logger/index.js';
import { ScraperError } from './errors.js';
import { getMetrics } from '../metrics/registry.js';
import { classifyError } from '../metrics/classify.js';

export class BaseScraper {
    constructor(platform, scraperFn) {
        if (!platform) throw new Error('BaseScraper requires a platform name');
        if (typeof scraperFn !== 'function') {
            throw new Error(`BaseScraper(${platform}) requires a scraper function`);
        }
        this.platform = platform;
        this.scraperFn = scraperFn;
        this.log = createLogger(platform);
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
        const metrics = getMetrics();
        this.log.info('Starting scrape', { jobTitle, location, sessionId });
        try {
            const jobs = await this.scraperFn(jobTitle, location, sessionId, options);
            const durationMs = Date.now() - start;
            const jobCount = jobs?.length ?? 0;
            this.log.info('Scrape complete', { jobCount, durationMs });
            metrics.recordSession(this.platform, 'success', durationMs);
            metrics.recordJobsScraped(this.platform, jobCount);
            return jobs ?? [];
        } catch (error) {
            const durationMs = Date.now() - start;
            const reason = classifyError(error);
            this.log.error('Scrape failed', {
                err: error?.message ?? 'unknown',
                reason,
                durationMs,
                scraper_alert: reason === 'auth_required' ? 'auth_required' : undefined,
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
