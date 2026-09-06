import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { SearchQuotaTracker } from '../../src/scrapers/linkedin-rsc/search-quota.js';
import { NetworkError } from '../../src/core/errors.js';

const empty = { posts: [], pages: [{}], emptyConfirmed: true, upToDate: false };
const served = { posts: [{ activity_id: '7487914656553025536', text: 'Hiring a data engineer',
    post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7487914656553025536/' }], pages: [{}] };

function harness({ startupProbe = false, probe = async () => served } = {}) {
    let now = 1_000_000;
    const tracker = new SearchQuotaTracker({ startupProbe, now: () => now });
    const reports = [], probes = [];
    const lease = { credential: { id: 15, profile_key: 'test-account' },
        reportSuccess: async () => {}, reportFailure: async (...args) => reports.push(args) };
    const options = { quotaTracker: tracker, quotaAdmission: true, template: {},
        canaryTracker: null, metrics: null, queryState: null,
        session: { isAlive: () => true, withCookies: async (_, fn) => fn([], lease),
            isRequestHealthy: async () => true, verifySearchSession: async () => true },
        paginateImpl: async (args) => {
            if (['hiring', 'jobs', 'recruiting'].includes(args.keywords)) {
                probes.push(args); return probe(args);
            }
            return empty;
        },
    };
    return { tracker, reports, probes, options, advance: (ms) => { now += ms; },
        scrape: () => scrapeLinkedInRsc('Rare specialist', 'US', 'test-session', options) };
}

test('25 narrow empty searches require a successful broad diagnostic instead of a platform pause', async () => {
    const h = harness();
    for (let n = 0; n < 25; n++) await h.scrape();
    assert.equal(h.tracker.snapshot().paused, false, 'ordinary empties must not create a cooldown');
    assert.equal(h.probes.length, 1, 'the threshold must run a control search');
    assert.equal(h.probes[0].maxPages, 1);
    assert.equal(h.probes[0].sinceActivityId ?? null, null);
    assert.equal(h.tracker.snapshot().consecutiveTrips, 0);
    assert.equal(h.tracker.snapshot().consecutiveEmpty, 0);
    assert.equal(h.reports.length, 0);
});

test('a network failure during startup diagnostic never escalates quota', async () => {
    const h = harness({ startupProbe: true, probe: async () => { throw new NetworkError('socket reset'); } });
    await h.scrape().catch(() => {});
    assert.equal(h.tracker.snapshot().consecutiveTrips, 0);
    assert.equal(h.reports.length, 0);
    assert.equal((await h.scrape()).searchOutcome, 'deferred', 'inconclusive diagnostics retry with a bounded delay');
});

test('two separated verified empty controls cool only the held account and recovery resets escalation', async () => {
    let healthy = false;
    const h = harness({ startupProbe: true, probe: async () => healthy ? served : empty });
    assert.equal((await h.scrape()).searchOutcome, 'deferred');
    assert.equal(h.reports.length, 0, 'one empty control is only suspicion');
    h.advance(60_000);
    await h.scrape();
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0][1], 5, 'first verified account pause is five minutes');
    assert.notEqual(h.probes[0].keywords, h.probes[1].keywords);
    assert.equal(h.tracker.snapshot().consecutiveTrips, 1);
    h.advance(5 * 60_000);
    healthy = true;
    await h.scrape();
    assert.equal(h.tracker.snapshot().consecutiveTrips, 0);
    assert.equal(h.tracker.snapshot().paused, false);
});

for (const [label, health] of [['stale template', false], ['unknown template', null]]) {
    test(`${label} cannot corroborate an empty control`, async () => {
        const h = harness({ startupProbe: true, probe: async () => empty });
        h.options.session.isRequestHealthy = async () => health;
        for (let n = 0; n < 4; n++) { await h.scrape(); h.advance(5 * 60_000); }
        assert.equal(h.reports.length, 0);
        assert.equal(h.tracker.snapshot().consecutiveTrips, 0);
    });
}

test('archive failure cannot mask an explicit authentication failure', async () => {
    const { AuthError } = await import('../../src/core/errors.js');
    const h = harness({ startupProbe: true, probe: async () => { throw new AuthError('re-login needed'); } });
    h.options.archive = { save: async () => { throw new Error('disk full'); } };
    await assert.rejects(h.scrape(), AuthError);
    assert.equal(h.tracker.snapshot().consecutiveTrips, 0);
});

test('archive failure cannot prevent a confirmed account cooldown report', async () => {
    const { BlockedError } = await import('../../src/core/errors.js');
    const h = harness({ startupProbe: true, probe: async () => { throw new BlockedError('HTTP 429', { kind: 'rate_limit' }); } });
    h.options.archive = { save: async () => { throw new Error('disk full'); } };
    await assert.rejects(h.scrape(), /disk full/);
    assert.equal(h.reports.length, 1);
});
