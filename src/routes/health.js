// GET / — health check + usage hints.

import { PLATFORM_NAMES } from '../scrapers/registry.js';

export function registerHealthRoute(app, port) {
    app.get('/', (_req, res) => {
        res.json({
            status: 'Unified Job Scraper API is running',
            version: '2.0.0',
            availablePlatforms: PLATFORM_NAMES,
            endpoints: {
                scrape: {
                    method: 'POST',
                    path: '/scrape',
                    description: 'Manual scraping. Platforms can be a comma-separated string, array, or "all".',
                    body: {
                        platform: 'string | string[] (e.g. "dice", "dice,monster", ["dice","monster"], "all")',
                        jobTitle: 'string',
                        location: 'string',
                    },
                },
                scrapeQueue: {
                    method: 'POST',
                    path: '/scrape-queue',
                    description: 'Blacklight queue — automatic role selection. Backend filters platforms by this key\'s platform_allowlist (if set).',
                },
                metrics: {
                    method: 'GET',
                    path: '/metrics',
                    description: 'Prometheus text format — current in-process counters and gauges.',
                },
            },
            examples: [
                {
                    description: 'Single platform',
                    curl: `curl -X POST http://localhost:${port}/scrape -H "Content-Type: application/json" -d '{"platform":"monster","jobTitle":"DevOps Engineer","location":"california"}'`,
                },
                {
                    description: 'Multiple platforms',
                    curl: `curl -X POST http://localhost:${port}/scrape -H "Content-Type: application/json" -d '{"platform":"monster,dice","jobTitle":"Software Engineer","location":"New York"}'`,
                },
                {
                    description: 'All platforms',
                    curl: `curl -X POST http://localhost:${port}/scrape -H "Content-Type: application/json" -d '{"platform":"all","jobTitle":"DevOps Engineer","location":"us"}'`,
                },
                {
                    description: 'Blacklight queue',
                    curl: `curl -X POST http://localhost:${port}/scrape-queue`,
                },
            ],
        });
    });
}
