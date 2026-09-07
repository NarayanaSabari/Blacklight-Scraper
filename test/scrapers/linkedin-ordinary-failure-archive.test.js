import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { paginate } from '../../src/scrapers/linkedin-rsc/client.js';
import { ScrapeArchive } from '../../src/scrapers/linkedin-rsc/archive.js';
import { SearchQuotaTracker } from '../../src/scrapers/linkedin-rsc/search-quota.js';
import { AuthError, NetworkError } from '../../src/core/errors.js';

const secret = 'private-http-response-echo';
const cookies = [{ name: 'li_at', value: secret }, { name: 'JSESSIONID', value: '"ajax:private"' }];

async function harness(t, handler, options = {}) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-ordinary-failure-'));
    t.after(async () => { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
    const archive = new ScrapeArchive({ directory });
    const quotaTracker = new SearchQuotaTracker({ startupProbe: false });
    const reports = [];
    const settings = { template: { url: `http://127.0.0.1:${server.address().port}/search/results/content/?token=${secret}`,
        headers: {}, postData: '{}' }, archive, quotaTracker,
        queryState: null, canaryTracker: null, pacer: null, metrics: null,
        session: { withCookies: async (_id, work) => work(cookies, {
            credential: { id: 23 }, reportFailure: async (...args) => reports.push(args),
        }) }, ...options };
    return { directory, archive, quotaTracker, reports,
        scrape: () => scrapeLinkedInRsc('Data engineer', 'US', 'ordinary-test', settings),
        read: async () => {
            const records = [];
            for (const file of await readdir(directory)) {
                const raw = await readFile(path.join(directory, file), 'utf8');
                for (const value of [secret, 'ajax:private', 'private-header', 'private-cause']) {
                    assert.equal(raw.includes(value), false, `archive leaked ${value}`);
                }
                records.push(JSON.parse(raw));
            }
            return records;
        } };
}

// Removing the ordinary-error archive must lose the failed response evidence.
for (const status of [403, 503]) {
    test(`ordinary HTTP ${status} is archived before the original typed error escapes`, async (t) => {
        const h = await harness(t, (_req, res) => {
            res.writeHead(status, { 'Content-Type': `text/html; private=${secret}`, 'Set-Cookie': secret, 'X-Private': 'private-header' });
            res.end(secret);
        });
        await assert.rejects(h.scrape(), (error) => status === 403
            ? error instanceof AuthError && error.code === 'NEEDS_RELOGIN'
            : error instanceof NetworkError && error.statusCode === 503);
        const records = await h.read();
        assert.equal(records.length, 1);
        assert.equal(records[0].outcome, 'request_failed');
        assert.equal(records[0].pages[0].response.status, status);
        assert.equal(records[0].pages[0].response.contentType, 'text/html');
        assert.equal(records[0].pages[0].response.bodySha256, null);
        assert.deepEqual(records[0].posts, []);
        assert.equal(h.reports.length, 0);
        assert.equal(h.quotaTracker.snapshot().consecutiveTrips, 0);
        assert.equal(h.quotaTracker.beginSearch().allowed, true, 'ordinary failures release admission');
    });
}

test('ordinary stalled-body failure retains received headers without misreporting body evidence', async (t) => {
    const h = await harness(t, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.write(secret);
    }, { paginateImpl: (args) => paginate({ ...args, timeBudgetMs: 500 }) });
    await assert.rejects(h.scrape(), (error) => error instanceof NetworkError && /deadline/.test(error.message));
    const records = await h.read();
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'request_failed');
    assert.equal(records[0].pages[0].response.status, 200);
    assert.equal(records[0].pages[0].response.bodyBytes, null);
    assert.equal(records[0].pages[0].response.bodySha256, null);
    assert.equal(h.reports.length, 0);
});

test('a failed next page preserves already archived posts and adds safe failure evidence', async (t) => {
    let requests = 0;
    let originalError;
    const card = ['$', 'div', null, { componentkey: 'expandedHASHFeedType_FLAGSHIP_SEARCH', children: [
        'https://www.linkedin.com/posts/test_hiring-share-7487914656553025536-AbCd',
        ['$', 'span', 'text-attr-0', { children: [['$', 'span', '0', { children: [null, 'Hiring engineer for remote work'] }]] }],
    ] }];
    const h = await harness(t, (_req, res) => {
        if (++requests === 1) res.end(`0:${JSON.stringify(card)}\n`);
        else { res.writeHead(503); res.end(secret); }
    }, { paginateImpl: async (args) => {
        try { return await paginate({ ...args, delay: async () => {} }); }
        catch (error) {
            // Exercise the trust boundary: never spread arbitrary error fields.
            error.message = 'private-cause';
            error.pages.at(-1).response.headers = { cookie: secret };
            error.pages.at(-1).html = secret;
            originalError = error;
            throw error;
        }
    } });
    await assert.rejects(h.scrape(), (error) => error === originalError);
    const records = await h.read();
    assert.equal(records.length, 2);
    assert.equal(records.find((record) => record.outcome === 'page').posts.length, 1);
    const failure = records.find((record) => record.outcome === 'request_failed');
    assert.equal(failure.pages.at(-1).page, 2);
    assert.equal(failure.pages.at(-1).response.status, 503);
});

test('archive filesystem failure cannot replace the original authentication error', async (t) => {
    const h = await harness(t, (_req, res) => { res.writeHead(403); res.end(secret); });
    const occupied = path.join(h.directory, 'occupied');
    await writeFile(occupied, 'not a directory');
    h.archive.directory = occupied;
    await assert.rejects(h.scrape(), (error) => error instanceof AuthError && error.code === 'NEEDS_RELOGIN');
    assert.equal(h.reports.length, 0);
});
