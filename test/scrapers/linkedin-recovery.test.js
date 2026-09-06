import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchQuotaTracker, SearchQuotaRegistry } from '../../src/scrapers/linkedin-rsc/search-quota.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { BlockedError } from '../../src/core/errors.js';

function pending() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
const served = { posts: [{ activity_id: '7487914656553025536', text: 'Hiring a data engineer',
    post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7487914656553025536/' }], pages: [{}] };
function options(quotaTracker, paginateImpl) {
    return { quotaTracker, quotaAdmission: true, queryState: null, canaryTracker: null, metrics: null,
        session: { withCookies: async (_, fn) => fn([], {}) }, template: {}, archive: null, paginateImpl };
}

test('a pending diagnostic defers another assignment without releasing the first reservation', async () => {
    const q = new SearchQuotaTracker({ startupProbe: true });
    const probe = pending(), started = pending();
    const first = scrapeLinkedInRsc('A', 'US', 'a', options(q, async () => {
        started.resolve(); return probe.promise;
    }));
    await started.promise;
    try {
        const second = await scrapeLinkedInRsc('B', 'US', 'b', options(q, async () => served));
        assert.equal(second.searchOutcome, 'deferred');
        assert.equal(q.snapshot().recoveryInFlight, true);
    } finally { probe.resolve(served); await first; }
    assert.equal(q.beginSearch().allowed, true);
});

test('explicit rate limiting cools the account and archives the reason', async () => {
    const q = new SearchQuotaTracker({ startupProbe: true });
    const reports = [], archives = [];
    const result = await scrapeLinkedInRsc('A', 'US', 'a', {
        ...options(q, async () => { throw new BlockedError('HTTP 429', { kind: 'rate_limit' }); }),
        session: { withCookies: async (_, fn) => fn([], {
            reportFailure: async (...args) => reports.push(args),
        }) }, archive: { save: async (record) => archives.push(record) },
    });
    assert.equal(result.searchOutcome, 'deferred');
    assert.equal(reports[0][1], 5);
    assert.equal(archives[0].diagnostic.outcome, 'rate_limited');
    assert.equal(archives[0].diagnostic.cooldownMs, 300_000);
    assert.equal((await scrapeLinkedInRsc('B', 'US', 'b', options(q, async () => served))).searchOutcome, 'deferred');
});

test('a healthy account keeps scraping while a different account is cooling', async () => {
    const registry = new SearchQuotaRegistry();
    const bad = { credential: { id: 15 }, reportFailure: async () => {} };
    const good = { credential: { id: 17 }, reportSuccess: async () => {} };
    registry.forAccount(bad).finishRecovery('rate_limited');
    const opts = { quotaRegistry: registry, quotaAdmission: true, template: {}, metrics: null,
        paginateImpl: async () => served, session: { withCookies: async (_, fn) => fn([], bad) } };
    assert.equal((await scrapeLinkedInRsc('A', 'US', 'a', opts)).searchOutcome, 'deferred');
    opts.session = { withCookies: async (_, fn) => fn([], good) };
    assert.equal((await scrapeLinkedInRsc('B', 'US', 'b', opts)).jobs.length, 1);
});

test('a 429 on an ordinary query pauses that account without sending another search', async () => {
    const q = new SearchQuotaTracker();
    let requests = 0;
    const reports = [];
    const result = await scrapeLinkedInRsc('A', 'US', 'a', {
        ...options(q, async () => { requests++; throw new BlockedError('HTTP 429', { kind: 'rate_limit' }); }),
        session: { withCookies: async (_, fn) => fn([], { reportFailure: async (...args) => reports.push(args) }) },
    });
    assert.equal(requests, 1);
    assert.equal(result.searchOutcome, 'deferred');
    assert.equal(reports[0][1], 5);
});
