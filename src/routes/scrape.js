// POST /scrape — manual single-shot scraping.
//
// Validates input with zod, then runs each requested platform sequentially.
// Results for each platform are collected and returned in a single response.
// Incremental per-platform persistence is delegated to a small persistence
// helper so the route stays HTTP-only.

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

        for (const platformName of platforms) {
            const scraper = getScraper(platformName);
            if (!scraper) {
                log.warn('Unknown platform requested', { platformName });
                results.platforms[platformName] = { success: false, error: 'Platform not supported' };
                continue;
            }

            try {
                const jobs = await scraper.execute(jobTitle, location, null);
                results.platforms[platformName] = { success: true, count: jobs.length, jobs };
            } catch (error) {
                results.platforms[platformName] = {
                    success: false,
                    platform: platformName,
                    error: error.message,
                    timestamp: new Date().toISOString(),
                };
            }

            try {
                savedFiles.push(savePlatformResults(platformName, results.platforms[platformName], jobTitle, location, timestamp));
            } catch (error) {
                log.error('Failed to persist platform results', { platformName, err: error.message });
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
