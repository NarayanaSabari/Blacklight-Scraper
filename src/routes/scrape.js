// POST /scrape — manual single-shot scraping.
//
// Validates input with zod, then runs each requested platform IN PARALLEL.
// Wall-clock matches the slowest platform rather than the sum. Each task
// is fully isolated (its own try/catch + its own results file write), so
// Promise.allSettled cannot poison sibling platforms. Mirrors the parallel
// model in src/queue/orchestrator.js — keep them in sync.

import path from 'path';
import fs from 'fs';
import { ZodError } from 'zod';
import { parseScrapeRequest } from '../validation/schemas.js';
import { getScraper, PLATFORM_NAMES } from '../scrapers/registry.js';
import { createLogger } from '../logger/index.js';
import { sanitizeFilename, generateTimestamp } from '../core/html.js';

const log = createLogger('route:scrape');

function resolvePlatforms(requested) {
    if (requested.length === 1 && requested[0] === 'all') return [...PLATFORM_NAMES];
    return requested.filter((p) => p !== 'all');
}

function savePlatformResults(platformName, payload, jobTitle, location, timestamp) {
    const resultsDir = path.join(process.cwd(), 'results');
    try { fs.mkdirSync(resultsDir, { recursive: true }); } catch { /* ignore */ }

    const filename = `${platformName}_${sanitizeFilename(jobTitle)}_${sanitizeFilename(location)}_${timestamp}.json`;
    const filepath = path.join(resultsDir, filename);
    const body = {
        timestamp: new Date().toISOString(),
        platform: platformName,
        jobTitle,
        location,
        ...payload,
    };
    fs.writeFileSync(filepath, JSON.stringify(body, null, 2));
    log.info('Platform results saved', { filename });
    return filename;
}

export function registerScrapeRoute(app) {
    app.post('/scrape', async (req, res) => {
        let params;
        try {
            params = parseScrapeRequest(req.body);
        } catch (error) {
            if (error instanceof ZodError) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid request body',
                    details: error.issues,
                    validPlatforms: PLATFORM_NAMES,
                });
            }
            return res.status(400).json({ success: false, error: error.message });
        }

        const { platform, jobTitle, location } = params;
        // Optional: caller can pass `searchQueries: [...]` to override
        // the default boolean-template behaviour (used by LinkedIn). The
        // production code path receives this from the backend role
        // payload via the orchestrator; for ad-hoc /scrape calls,
        // accept it directly so the manual workflow can mirror the
        // multi-query flow.
        const adhocSearchQueries = Array.isArray(req.body?.searchQueries)
            ? req.body.searchQueries
            : null;
        const platforms = resolvePlatforms(platform);
        log.info('Scrape request received', { platforms, jobTitle, location });

        const timestamp = generateTimestamp();
        const savedFiles = [];
        const results = {
            timestamp: new Date().toISOString(),
            jobTitle,
            location,
            platforms: {},
        };

        const tasks = platforms.map(async (platformName) => {
            const scraper = getScraper(platformName);
            if (!scraper) {
                log.warn('Unknown platform requested', { platformName });
                return {
                    platformName,
                    payload: { success: false, error: 'Platform not supported' },
                };
            }

            let payload;
            try {
                const jobs = await scraper.execute(jobTitle, location, null, {
                    searchQueries: adhocSearchQueries,
                });
                payload = { success: true, count: jobs.length, jobs };
            } catch (error) {
                payload = {
                    success: false,
                    platform: platformName,
                    error: error.message,
                    timestamp: new Date().toISOString(),
                };
            }

            let savedFile = null;
            try {
                savedFile = savePlatformResults(platformName, payload, jobTitle, location, timestamp);
            } catch (error) {
                log.error('Failed to persist platform results', { platformName, err: error.message });
            }

            return { platformName, payload, savedFile };
        });

        const settled = await Promise.allSettled(tasks);
        for (const entry of settled) {
            if (entry.status === 'fulfilled') {
                const { platformName, payload, savedFile } = entry.value;
                results.platforms[platformName] = payload;
                if (savedFile) savedFiles.push(savedFile);
            } else {
                log.error('Platform task threw unexpectedly', { err: entry.reason?.message });
            }
        }

        const platformEntries = Object.values(results.platforms);
        results.summary = {
            totalPlatforms: platforms.length,
            completedPlatforms: platformEntries.length,
            successfulPlatforms: platformEntries.filter((p) => p.success).length,
            failedPlatforms: platformEntries.filter((p) => !p.success).length,
            totalJobs: platformEntries.filter((p) => p.success).reduce((sum, p) => sum + (p.count ?? 0), 0),
            status: 'completed',
            savedFiles,
        };

        res.json({ success: true, message: 'Scraping completed', summary: results.summary, results });
    });
}
