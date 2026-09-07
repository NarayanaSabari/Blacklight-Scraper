import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BaseScraper } from '../../src/core/base-scraper.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { LinkedInRscSession } from '../../src/scrapers/linkedin-rsc/session.js';
import { SearchQuotaTracker } from '../../src/scrapers/linkedin-rsc/search-quota.js';
import { ScrapeArchive } from '../../src/scrapers/linkedin-rsc/archive.js';

// Exercise HTTP, flight parsing, lease lifetime, the scraper adapter and disk
// evidence. Only LinkedIn and the remote credential pool are replaced.
test('real HTTP empty responses cannot pause a healthy scraper after 25 narrow queries', async () => {
    const empty = await readFile(new URL('../fixtures/linkedin-rsc-no-results.txt', import.meta.url), 'utf8');
    const served = await readFile(new URL('../fixtures/linkedin-rsc-search.txt', import.meta.url), 'utf8');
    let controls = 0, ordinary = 0, failures = 0, released = 0;
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const request = JSON.parse(raw).clientArguments.payload;
        if (request.keywords === 'hiring') {
            controls++;
            assert.equal(request.startIndex, 0);
            assert.equal(request.count, 10);
            res.end(served);
        } else { ordinary++; res.end(empty); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-diagnostic-'));
    try {
        const template = { url: `http://127.0.0.1:${server.address().port}/pagination`, headers: {},
            postData: JSON.stringify({ clientArguments: { payload: {} } }) };
        const session = new LinkedInRscSession({ templateHealth: null, metrics: null,
            cookieReader: async () => [{ name: 'li_at', value: 'test-secret' },
                { name: 'JSESSIONID', value: '"ajax:test"' }],
            apiClient: { isLocal: false, acquire: async () => ({ credential: { id: 15 },
                reportSuccess: async () => {}, reportFailure: async () => { failures++; },
                release: async () => { released++; } }) } });
        const quotaTracker = new SearchQuotaTracker();
        const scraper = new BaseScraper('linkedin', scrapeLinkedInRsc, { strictEmpty: true });
        for (let n = 0; n < 25; n++) {
            const result = await scraper.executeWithMeta('Rare specialist', 'United States', `http-test-${n}`, {
                session, template, quotaTracker, pacer: null, queryState: null,
                archive: new ScrapeArchive({ directory }),
            });
            assert.equal(result.emptyConfirmed, true);
        }
        assert.equal(ordinary, 25);
        assert.equal(controls, 1);
        assert.equal(failures, 0);
        assert.equal(released, 25);
        assert.equal(quotaTracker.snapshot().paused, false);
        const records = await Promise.all((await readdir(directory)).map(async (name) =>
            JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
        const evidence = records.find((r) => r.outcome === 'diagnostic_healthy');
        assert.ok(evidence.posts.length > 0);
        assert.equal(evidence.diagnostic.account, 'id:15');
        assert.equal(JSON.stringify(records).includes('test-secret'), false);
        await session.shutdown();
    } finally {
        server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

// Session health and the credential pool are external boundaries; HTTP search
// transport, response parsing, diagnostic decisions and admission remain real.
for (const [status, expectedPauses] of [
    [200, [0, 5, 10, 15, 15, 15]],
    [429, [5, 10, 20, 40, 60, 60]],
]) {
    test(`HTTP ${status} recovery reports the correct cooldown and admits a retry at expiry`, async () => {
        const empty = await readFile(new URL('../fixtures/linkedin-rsc-no-results.txt', import.meta.url), 'utf8');
        let requests = 0, now = 1_000_000;
        const reports = [];
        const server = http.createServer(async (req, res) => {
            for await (const chunk of req) { /* consume the search request */ }
            requests++;
            res.writeHead(status);
            res.end(status === 200 ? empty : 'Too many requests');
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            const tracker = new SearchQuotaTracker({ startupProbe: true, now: () => now });
            const lease = { credential: { id: 15 },
                reportFailure: async (_, minutes) => reports.push(minutes) };
            const options = {
                session: { isAlive: () => true, withCookies: async (_, fn) => fn([
                    { name: 'li_at', value: 'test-secret' },
                    { name: 'JSESSIONID', value: '"ajax:test"' },
                ], lease),
                    isRequestHealthy: async () => true, verifySearchSession: async () => true },
                template: { url: `http://127.0.0.1:${server.address().port}/pagination`, headers: {},
                    postData: JSON.stringify({ clientArguments: { payload: {} } }) },
                quotaTracker: tracker, quotaAdmission: true, pacer: null,
                queryState: null, canaryTracker: null, metrics: null,
            };
            const scrape = () => scrapeLinkedInRsc('Rare specialist', 'US', 'http-recovery', options);
            for (const [index, minutes] of expectedPauses.entries()) {
                assert.equal((await scrape()).searchOutcome, 'deferred');
                assert.equal(requests, index + 1, 'one control request per admitted recovery');
                if (minutes > 0) assert.equal(reports.at(-1), minutes);
                else assert.equal(reports.length, 0, 'one empty does not report a cooldown');
                const pauseMs = minutes === 0 ? 60_000 : minutes * 60_000;
                assert.equal(tracker.snapshot().nextRetryAt, new Date(now + pauseMs).toISOString());
                now += pauseMs - 1;
                assert.equal((await scrape()).searchOutcome, 'deferred');
                assert.equal(requests, index + 1, 'the account gate holds until cooldown expiry');
                now++;
            }
            assert.deepEqual(reports, expectedPauses.filter((minutes) => minutes > 0));
        } finally {
            server.close();
        }
    });
}
