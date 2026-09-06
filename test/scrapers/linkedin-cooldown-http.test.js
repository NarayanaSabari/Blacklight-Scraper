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
