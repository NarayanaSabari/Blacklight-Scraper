import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchQuotaTracker } from '../../src/scrapers/linkedin-rsc/search-quota.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { BlockedError } from '../../src/core/errors.js';

function pending() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const served = { posts: [{ activity_id: '7487914656553025536',
    text: 'Hiring a Data Engineer in Chicago with Python and SQL.',
    post_url: 'https://www.linkedin.com/posts/recruiter_hiring-share-7487914656553025536-AbCd' }], pages: [{}] };

function recoveryOptions(quotaTracker, paginateImpl) {
    return { quotaTracker, quotaAdmission: true, queryState: null, canaryTracker: null, metrics: null,
        session: { withCookies: async (_, fn) => fn([], {}) }, template: {},
        archive: { save: async () => {} }, paginateImpl };
}

test('a restarted production tracker gates searches through three startup probes', () => {
    const quota = new SearchQuotaTracker({ startupProbe: true });
    for (let remaining = 3; remaining > 0; remaining--) {
        assert.equal(quota.snapshot().probationRemaining, remaining);
        const admission = quota.beginSearch();
        assert.equal(admission.allowed, true);
        assert.equal(admission.recovery, true);
        assert.equal(quota.beginSearch().allowed, false);
        quota.finishRecovery(true);
    }
    assert.equal(quota.beginSearch().recovery, false);
});

test('finishing one requested query cannot release the next active recovery probe', async () => {
    let now = 1000;
    const quota = new SearchQuotaTracker({ threshold: 1, basePause: 100, now: () => now });
    quota.recordEmpty();
    now += 100;
    const firstQuery = pending();
    const firstStarted = pending();
    const secondProbe = pending();
    const secondStarted = pending();
    const first = scrapeLinkedInRsc('A', 'US', 'a', recoveryOptions(quota, async ({ keywords }) => {
        if (keywords === 'hiring') return served;
        firstStarted.resolve();
        return firstQuery.promise;
    }));
    await firstStarted.promise;
    const second = scrapeLinkedInRsc('B', 'US', 'b', recoveryOptions(quota, async ({ keywords }) => {
        if (keywords !== 'hiring') return served;
        secondStarted.resolve();
        return secondProbe.promise;
    }));
    await secondStarted.promise;
    try {
        firstQuery.resolve(served);
        await first;
        const third = await scrapeLinkedInRsc('C', 'US', 'c', recoveryOptions(quota, async () => served));
        assert.equal(third.searchOutcome, 'deferred');
        assert.equal(quota.snapshot().recoveryInFlight, true);
    } finally {
        secondProbe.resolve(served);
        await second;
    }
});

test('a refused recovery request extends cooldown before another assignment is admitted', async () => {
    let now = 1000;
    const quota = new SearchQuotaTracker({ threshold: 1, basePause: 100, now: () => now });
    quota.recordEmpty();
    now += 100;
    let writtenPause;
    await assert.rejects(scrapeLinkedInRsc('Engineer', 'US', 's', {
        ...recoveryOptions(quota, async () => { throw new BlockedError('HTTP 429', { platform: 'linkedin' }); }),
        applyQuotaPauseImpl: ({ pauseMs }) => { writtenPause = pauseMs; return true; },
    }), /HTTP 429/);
    assert.equal(writtenPause, 200);
    assert.equal(quota.snapshot().paused, true);
    const next = await scrapeLinkedInRsc('Engineer', 'US', 'next', recoveryOptions(quota, async () => served));
    assert.equal(next.searchOutcome, 'deferred');
});

test('cooldown admits only one recovery search and failed probe extends pause', () => {
    let now = 1000;
    const quota = new SearchQuotaTracker({ threshold: 1, basePause: 100, maxPause: 1000, now: () => now });
    quota.recordEmpty();
    assert.equal(quota.beginSearch().allowed, false);
    now += 100;
    const recovery = quota.beginSearch();
    assert.equal(recovery.allowed, true);
    assert.equal(recovery.recovery, true);
    assert.equal(quota.beginSearch().allowed, false);
    const result = quota.finishRecovery(false);
    assert.equal(result.pauseMs, 200);
    assert.equal(quota.snapshot().paused, true);
});

test('successful recovery holds probation until three served searches', () => {
    let now = 1000;
    const quota = new SearchQuotaTracker({ threshold: 1, basePause: 100, now: () => now });
    quota.recordEmpty();
    now += 100;
    for (let i = 0; i < 3; i++) {
        assert.equal(quota.beginSearch().recovery, true);
        assert.equal(quota.beginSearch().allowed, false);
        quota.finishRecovery(true);
    }
    assert.equal(quota.beginSearch().recovery, false);
    assert.equal(quota.snapshot().consecutiveTrips, 0);
});

test('aborted recovery releases its slot so a subsequent probe can proceed', () => {
    let now = 1000;
    const quota = new SearchQuotaTracker({ threshold: 1, basePause: 100, now: () => now });
    quota.recordEmpty();
    now += 100;
    quota.beginSearch();
    quota.cancelRecovery();
    assert.equal(quota.beginSearch().allowed, true);
});

test('scraper recovery archives a bounded probe and defers the requested query on refusal', async () => {
    const { scrapeLinkedInRsc } = await import('../../src/scrapers/linkedin-rsc/scraper.js');
    let now = 1000;
    const quota = new SearchQuotaTracker({ threshold: 1, basePause: 100, now: () => now });
    quota.recordEmpty();
    now += 100;
    const requests = [];
    const archives = [];
    let pause;
    const result = await scrapeLinkedInRsc('Data Engineer', 'US', 's', {
        quotaTracker: quota, quotaAdmission: true, queryState: null, highWater: null,
        session: { withCookies: async (_, fn) => fn([], {}) }, template: {},
        archive: { save: async (record) => archives.push(record) },
        paginateImpl: async (args) => { requests.push(args); return { posts: [], pages: [{}], emptyConfirmed: true }; },
        applyQuotaPauseImpl: ({ pauseMs }) => { pause = pauseMs; return true; },
    });
    assert.equal(result.searchOutcome, 'deferred');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].keywords, 'hiring');
    assert.equal(requests[0].maxPages, 1);
    assert.equal(archives[0].outcome, 'recovery_unavailable');
    assert.equal(pause, 200);
});
