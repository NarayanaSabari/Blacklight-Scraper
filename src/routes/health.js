// GET / (welcome), GET /healthz (cheap state).

import { existsSync } from 'node:fs';
import { PLATFORM_NAMES } from '../scrapers/registry.js';

export function registerHealthRoute(app, port, deps = {}) {
    const bootInfo = deps.bootInfo ?? { gitSha: 'unknown', pkgVersion: '0.0.0' };
    const getLinkedInSession = deps.getLinkedInSession ?? (() => ({ isAlive: () => false, lease: null }));

    app.get('/', (_req, res) => {
        res.json({
            status: 'Unified Job Scraper API is running',
            version: bootInfo.pkgVersion ?? '2.0.0',
            gitSha: bootInfo.gitSha,
            availablePlatforms: PLATFORM_NAMES,
            endpoints: {
                scrape: { method: 'POST', path: '/scrape', description: 'Manual scraping. Platforms can be a comma-separated string, array, or "all".', body: { platform: 'string | string[]', jobTitle: 'string', location: 'string' } },
                scrapeQueue: { method: 'POST', path: '/scrape-queue', description: 'Blacklight queue — automatic role selection.' },
                metrics: { method: 'GET', path: '/metrics', description: 'Prometheus text format — current in-process counters and gauges.' },
                healthz: { method: 'GET', path: '/healthz', description: 'Cheap liveness + identity payload.' },
            },
            examples: [
                { description: 'Single platform', curl: `curl -X POST http://localhost:${port}/scrape -H "Content-Type: application/json" -d '{"platform":"monster","jobTitle":"DevOps Engineer","location":"california"}'` },
                { description: 'Blacklight queue', curl: `curl -X POST http://localhost:${port}/scrape-queue` },
            ],
        });
    });

    app.get('/healthz', (_req, res) => {
        const session = getLinkedInSession();
        res.json({
            ok: true,
            pid: bootInfo.pid,
            gitSha: bootInfo.gitSha,
            bootedAt: bootInfo.bootedAt,
            nodeVersion: bootInfo.nodeVersion,
            pkgVersion: bootInfo.pkgVersion,
            profileDir: bootInfo.profileDir,
            profileDirExists: bootInfo.profileDir && bootInfo.profileDir !== 'unknown'
                ? existsSync(bootInfo.profileDir)
                : null,
            sessionAlive: !!session?.isAlive?.(),
            leaseCredentialId: session?.lease?.credential?.id ?? null,
            headless: !!bootInfo.headless,
            strict: !!bootInfo.strict,
            uptimeSec: Math.round(process.uptime()),
        });
    });
}
