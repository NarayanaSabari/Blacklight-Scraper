import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ScrapeArchive } from '../../src/scrapers/linkedin-rsc/archive.js';
import { QueryState } from '../../src/scrapers/linkedin-rsc/query-state.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { paginate } from '../../src/scrapers/linkedin-rsc/client.js';

const post = { activity_id: '7487914656553025536', text: 'Hiring a Data Engineer on W2 in Chicago, IL. Python and SQL required.', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7487914656553025536' };
function options(extra = {}) {
    return { session: { withCookies: async (_, fn) => fn([], { credential: { id: 1 } }) },
        template: {}, highWater: null, canaryTracker: null,
        paginateImpl: async () => ({ posts: [post], rawPosts: [post], pages: [{ page: 1 }], emptyConfirmed: false }), ...extra };
}

function flightPage(index) {
    const activityId = 7487914656553025500n + BigInt(index);
    const card = ['$', 'div', null, {
        componentkey: 'expandedHASHFeedType_FLAGSHIP_SEARCH',
        children: [`https://www.linkedin.com/posts/recruiter_hiring-share-${activityId}-AbCd`,
            ['$', 'span', 'text-attr-0', { children: [['$', 'span', '0', {
                children: [null, `Hiring Data Engineer number ${index} in Chicago with Python and SQL.`],
            }]] }]],
    }];
    return `0:${JSON.stringify(card)}\n`;
}

test('role reconciliation discovers an unseen post below ten known pages', async () => {
    let now = 1_000_000;
    const state = new QueryState({ filePath: null, now: () => now });
    let includeDeepPost = false;
    let requests;
    const opts = options({ scheduledRefresh: true, queryState: state, count: 1,
        template: { url: 'https://fixture.invalid', headers: {}, postData: '{}' },
        archive: { save: async () => {} },
        paginateImpl: (args) => paginate({ ...args, delay: async () => {},
            cookies: [{ name: 'li_at', value: 'test' }, { name: 'JSESSIONID', value: 'test' }],
            fetchImpl: async () => {
                const page = ++requests;
                return { ok: true, status: 200, text: async () => page <= (includeDeepPost ? 11 : 10)
                    ? flightPage(page) : '0:{"HasNoresultsBindingKey":{"booleanValue":true}}\n' };
            },
        }),
    });
    requests = 0;
    await scrapeLinkedInRsc('Engineer', 'US', 'first', opts);
    includeDeepPost = true;
    now += 30 * 60_000;
    requests = 0;
    const incremental = await scrapeLinkedInRsc('Engineer', 'US', 'incremental', opts);
    assert.equal(incremental.jobs.length, 0);
    now += 6 * 60 * 60_000;
    requests = 0;
    const reconciled = await scrapeLinkedInRsc('Engineer', 'US', 'reconcile', opts);
    assert.equal(reconciled.jobs.length, 11);
    assert.equal(requests, 12);
});

test('an incomplete first reconciliation stays due for full coverage on its next refresh', async () => {
    let now = 1_000_000;
    const state = new QueryState({ filePath: null, now: () => now });
    const opts = options({ scheduledRefresh: true, queryState: state,
        archive: { save: async () => {} },
        paginateImpl: async () => ({ posts: [post], pages: [{}], budgetExhausted: true, exhausted: false }),
    });
    await scrapeLinkedInRsc('Engineer', 'US', 'first', opts);
    const key = JSON.stringify(['past-24h', 'US', null, '"Engineer" AND (c2c OR W2 OR 1099)']);
    assert.equal(state.plan(key).due, false);
    now += 30 * 60_000;
    assert.equal(state.plan(key).reconcile, true);
    assert.equal(state.plan(key).seenPostIds.size, 0);
});

test('an incomplete overdue reconciliation waits for the next refresh instead of spinning', async () => {
    let now = 1_000_000;
    const state = new QueryState({ filePath: null, now: () => now });
    const opts = options({ scheduledRefresh: true, queryState: state,
        archive: { save: async () => {} },
        paginateImpl: async () => ({ posts: [post], pages: [{}], exhausted: true }),
    });
    await scrapeLinkedInRsc('Engineer', 'US', 'first', opts);
    now += 6 * 60 * 60_000;
    await scrapeLinkedInRsc('Engineer', 'US', 'partial', { ...opts,
        paginateImpl: async () => ({ posts: [post], pages: [{}], budgetExhausted: true, exhausted: false }),
    });
    const next = await scrapeLinkedInRsc('Engineer', 'US', 'repeat', opts);
    assert.equal(next.searchOutcome, 'deferred');
});

test('reconciliation re-emits known posts without counting them as new yield', async () => {
    let now = 1_000_000;
    const state = new QueryState({ filePath: null, now: () => now });
    const searches = [];
    const opts = options({ scheduledRefresh: true, queryState: state,
        archive: { save: async () => {} },
        metrics: { recordLinkedInSearch: (...values) => searches.push(values) },
        paginateImpl: async () => ({ posts: [post], rawPosts: [post], pages: [{}], exhausted: true }),
    });
    await scrapeLinkedInRsc('Engineer', 'US', 'first', opts);
    assert.equal(state.snapshot().newPosts, 1);
    for (const intervalMinutes of [60, 120]) {
        now += 6 * 60 * 60_000;
        const result = await scrapeLinkedInRsc('Engineer', 'US', `reconcile-${now}`, opts);
        assert.equal(result.jobs.length, 1, 'full coverage is still submitted');
        const [, outcome, requests, rawPosts, newPosts] = searches.at(-1);
        assert.equal(outcome, 'served');
        assert.equal(requests, 1);
        assert.equal(rawPosts, 1);
        assert.equal(newPosts, 0, 'retained IDs are not new just because the filter was cleared');
        assert.equal(state.snapshot().newPosts, 1);
        assert.equal(Date.parse(result.nextRefreshAt) - now, intervalMinutes * 60_000);
    }
});

test('archive persists full posts privately without credentials and survives a new instance', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'li-archive-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const archive = new ScrapeArchive({ directory });
    const file = await archive.save({ sessionId: 's', keywords: 'Data Engineer', posts: [post], cookies: ['secret'], headers: { authorization: 'secret' } });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.posts[0].text, post.text);
    assert.equal(JSON.stringify(data).includes('secret'), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal((await new ScrapeArchive({ directory }).stats()).count, 1);
});

test('archive failure prevents a scrape from advancing incremental state', async () => {
    const state = new QueryState({ filePath: null });
    await assert.rejects(scrapeLinkedInRsc('Data Engineer', 'US', 's', options({
        queryState: state, scheduledRefresh: true,
        archive: { save: async () => { throw new Error('disk full'); } },
    })), /disk full/);
    assert.equal(state.snapshot().queries, 0);
});

test('scheduled refresh archives before remembering posts and defers a repeat without network', async () => {
    let calls = 0;
    let archives = 0;
    const state = new QueryState({ filePath: null, now: () => 1000 });
    const opts = options({ scheduledRefresh: true, queryState: state,
        archive: { save: async () => { archives++; assert.equal(state.snapshot().queries, 0); } },
        paginateImpl: async () => { calls++; return { posts: [post], rawPosts: [post], pages: [{}] }; },
    });
    await scrapeLinkedInRsc('Data Engineer', 'US', 's1', opts);
    const next = await scrapeLinkedInRsc('Data Engineer', 'US', 's2', opts);
    assert.equal(calls, 1);
    assert.equal(archives, 1);
    assert.equal(next.searchOutcome, 'deferred');
    assert.equal(next.emptyConfirmed, false);
});

test('explicit candidate full search bypasses refresh state', async () => {
    let args;
    const result = await scrapeLinkedInRsc('Data Engineer', 'US', 's', options({
        candidateQuery: 'exact recruiter query', queryState: new QueryState({ filePath: null }),
        archive: { save: async () => {} },
        paginateImpl: async (value) => { args = value; return { posts: [post], pages: [] }; },
    }));
    assert.equal(args.keywords, 'exact recruiter query');
    assert.equal(args.seenPostIds, undefined);
    assert.equal(args.maxPosts, Number.MAX_SAFE_INTEGER);
    assert.equal(result.jobs.length, 1);
});

test('empty refresh backoff is bounded and reconciliation clears seen IDs', () => {
    let now = 1000;
    const state = new QueryState({ filePath: null, now: () => now });
    const key = 'query';
    state.record(key, { posts: [post], newPosts: 1, requests: 1, reconciled: true });
    now += 30 * 60_000;
    assert.equal(state.plan(key).seenPostIds.has(post.activity_id), true);
    for (let i = 0; i < 8; i++) {
        state.record(key, { posts: [], newPosts: 0, requests: 1 });
        const p = state.plan(key);
        assert.ok(p.nextDueAt - now <= 4 * 60 * 60_000);
        now = p.nextDueAt;
    }
    assert.equal(state.plan(key).reconcile, true);
    assert.equal(state.plan(key).seenPostIds.size, 0);
});

test('registry preserves deferred outcome without reporting a successful scrape', async () => {
    const { BaseScraper } = await import('../../src/core/base-scraper.js');
    let sessions = 0;
    const scraper = new BaseScraper('linkedin', async () => ({ jobs: [], emptyConfirmed: false,
        searchOutcome: 'deferred', nextRefreshAt: '2026-09-06T10:00:00.000Z' }),
    { strictEmpty: true, metrics: { recordSession: () => sessions++, recordFailure: () => {} } });
    const result = await scraper.executeWithMeta('Engineer', 'US');
    assert.equal(result.searchOutcome, 'deferred');
    assert.equal(result.emptyConfirmed, false);
    assert.equal(sessions, 0);
});

test('submission carries truthful search outcome and next refresh time', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-meta-'));
    const previousArchive = process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR;
    process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR = directory;
    t.after(() => {
        if (previousArchive === undefined) delete process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR;
        else process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR = previousArchive;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { BlacklightApiClient } = await import('../../src/api/blacklight.js');
    const original = globalThis.fetch;
    let body;
    globalThis.fetch = async (_, request) => {
        body = JSON.parse(request.body);
        return { ok: true, status: 202, json: async () => ({ status: 'accepted' }) };
    };
    try {
        const client = new BlacklightApiClient('http://backend', 'test');
        await client.submitJobs('s', 'linkedin', [], 'success', null, {
            emptyConfirmed: false, searchOutcome: 'deferred', nextRefreshAt: '2026-09-06T10:00:00.000Z',
        });
        assert.equal(body.search_outcome, 'deferred');
        assert.equal(body.next_refresh_at, '2026-09-06T10:00:00.000Z');
        assert.equal(body.empty_confirmed, false);
    } finally { globalThis.fetch = original; }
});

test('backend import feedback backs off noisy searches only once per completed run', () => {
    let now = 1_000_000;
    const state = new QueryState({ filePath: null, now: () => now });
    state.record('q', { posts: [post], newPosts: 100, requests: 10 });
    const feedback = { last_run_at: new Date(now).toISOString(), last_jobs_found: 0 };
    state.applyFeedback('q', feedback);
    assert.equal(state.plan('q').nextDueAt, now + 60 * 60_000);
    state.applyFeedback('q', feedback);
    assert.equal(state.plan('q').nextDueAt, now + 60 * 60_000);
    now += 60 * 60_000;
    state.record('q', { posts: [post], newPosts: 100, requests: 10 });
    state.applyFeedback('q', { last_run_at: new Date(now).toISOString(), last_jobs_found: 0 });
    assert.equal(state.plan('q').nextDueAt, now + 120 * 60_000);
    now += 120 * 60_000;
    state.record('q', { posts: [post], newPosts: 1, requests: 1 });
    state.applyFeedback('q', { last_run_at: new Date(now).toISOString(), last_jobs_found: 1 });
    assert.equal(state.plan('q').nextDueAt, now + 30 * 60_000);
});

test('scheduled noisy query retains import backoff when the next scrape finds fresh posts', async () => {
    let now = 1_000_000;
    const state = new QueryState({ filePath: null, now: () => now });
    const opts = options({ scheduledRefresh: true, queryState: state, candidateQuery: 'Business OR C2C',
        candidateQueryId: 19, paginateImpl: async () => ({ posts: [{ ...post, activity_id: String(now) }],
            pages: [{}], exhausted: true }) });
    await scrapeLinkedInRsc('Analyst', 'US', 'first', opts);
    const feedback = { last_run_at: new Date(now).toISOString(), last_jobs_found: 0 };
    await scrapeLinkedInRsc('Analyst', 'US', 'feedback', { ...opts, queryFeedback: feedback });
    now += 60 * 60_000;
    const next = await scrapeLinkedInRsc('Analyst', 'US', 'second', { ...opts, queryFeedback: feedback });
    assert.equal(next.jobs.length, 1);
    assert.equal(Date.parse(next.nextRefreshAt), now + 60 * 60_000);
    now += 30 * 60_000;
    assert.equal((await scrapeLinkedInRsc('Analyst', 'US', 'too-soon', opts)).searchOutcome, 'deferred');
});

test('scheduled role searches cover a due variant before deferring and return the earliest retry', async (t) => {
    let now = 1_000_000;
    let requests = 0;
    const server = http.createServer((request, response) => {
        request.resume();
        response.end(++requests % 2 ? flightPage(requests)
            : '0:{"HasNoresultsBindingKey":{"booleanValue":true}}\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const state = new QueryState({ filePath: null, now: () => now });
    const opts = options({ scheduledRefresh: true, queryState: state,
        searchQueries: ['query A', 'query B'], rng: () => 0,
        template: { url: `http://127.0.0.1:${server.address().port}`, headers: {}, postData: '{}' },
        paginateImpl: (args) => paginate({ ...args, delay: async () => {}, fetchImpl: fetch,
            cookies: [{ name: 'li_at', value: 'fixture' }, { name: 'JSESSIONID', value: 'fixture' }] }),
    });
    await scrapeLinkedInRsc('Engineer', 'US', 'first', opts);
    now += 5 * 60_000;
    const second = await scrapeLinkedInRsc('Engineer', 'US', 'second', opts);
    assert.equal(second.jobs.length, 1, 'query B is due even though RNG chooses A');
    const deferred = await scrapeLinkedInRsc('Engineer', 'US', 'third', { ...opts, rng: () => 0.99 });
    assert.equal(deferred.searchOutcome, 'deferred');
    assert.equal(Date.parse(deferred.nextRefreshAt), 1_000_000 + 30 * 60_000);
    assert.equal(requests, 4, 'two full searches and no request for the deferred assignment');
});

test('explicit query cadence survives fresh posts and empty scrapes', () => {
    let now = 1_000_000;
    const state = new QueryState({ filePath: null, now: () => now });
    state.record('q', { posts: [post], newPosts: 1, requests: 1, reconciled: true });
    state.applyFeedback('q', { last_run_at: new Date(now).toISOString(), last_jobs_found: 0, interval_minutes: 45 });
    now += 45 * 60_000;
    state.record('q', { posts: [], newPosts: 0, requests: 1 });
    assert.equal(state.plan('q').nextDueAt, now + 45 * 60_000);
});
