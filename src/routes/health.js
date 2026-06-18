// GET / (welcome), GET /healthz (cheap state), GET /health/linkedin?probe=1
// (real session probe — wired in a later task).

import { existsSync } from 'node:fs';
import { PLATFORM_NAMES } from '../scrapers/registry.js';
import { classifyLinkedinUrl } from '../setup/verify.js';

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
                healthLinkedin: { method: 'GET', path: '/health/linkedin?probe=1', description: 'Real in-session probe of the LinkedIn feed page.' },
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

    app.get('/health/linkedin', async (req, res) => {
        if (req.query.probe !== '1') {
            return res.json({
                probe: false,
                hint: 'Add ?probe=1 to run an in-session feed check. Cheap state is on /healthz.',
            });
        }
        const session = getLinkedInSession();
        const sessionId = `healthcheck-${Date.now()}`;
        try {
            const { url, urlClass } = await session.withPage(sessionId, async (page) => {
                await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                const u = page.url();
                return { url: u, urlClass: classifyLinkedinUrl(u) };
            });
            res.json({
                probe: true,
                checkedAt: new Date().toISOString(),
                url,
                urlClass,
                loggedIn: urlClass === 'authed',
            });
        } catch (e) {
            res.status(503).json({
                probe: true,
                checkedAt: new Date().toISOString(),
                loggedIn: false,
                error: e?.message ?? String(e),
            });
        }
    });
}
