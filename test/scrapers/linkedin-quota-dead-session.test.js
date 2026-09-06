// Cached cookies or missing health capabilities cannot establish a quota restriction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { SearchQuotaTracker } from '../../src/scrapers/linkedin-rsc/search-quota.js';

const TEMPLATE = { url: 'https://x', headers: {}, postData: '{}' };

function fakeSession({ alive }) {
    return {
        isAlive: () => alive,
        async withCookies(_sessionId, fn) {
            return fn([{ name: 'li_at', value: 'x' }], { credential: { profile_key: 'a' }, reportSuccess: async () => {} });
        },
    };
}

// A session with no isAlive capability at all — must behave as it did before.
function capabilityLessSession() {
    return {
        async withCookies(_sessionId, fn) {
            return fn([{ name: 'li_at', value: 'x' }], { credential: { profile_key: 'a' }, reportSuccess: async () => {} });
        },
    };
}

// LinkedIn's polite refusal: a well-formed confirmed empty with no rows. This
// is the response shape shared by a dead session AND a real quota block.
const refuse = async () => ({
    posts: [], emptyConfirmed: true, upToDate: false, newestActivityId: null, pages: [1],
});

async function run(session, tracker, n) {
    let pauses = 0;
    for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('Business Analyst', 'United States', null, {
            session,
            template: TEMPLATE,
            paginateImpl: refuse,
            highWater: { get: () => null, advance: () => {} },
            quotaTracker: tracker,
            applyQuotaPauseImpl: () => { pauses += 1; return true; },
            runCanaryImpl: async () => 'healthy',
        });
    }
    return pauses;
}

test('a dead session never trips the platform quota, however long the streak', async () => {
    const tracker = new SearchQuotaTracker();
    // Far past the 25 threshold — production reached 26 and kept going.
    const pauses = await run(fakeSession({ alive: false }), tracker, 60);

    assert.equal(pauses, 0, 'a dead session must not pause the whole platform');
    const snap = tracker.snapshot();
    assert.equal(snap.consecutiveEmpty, 0, 'dead-session empties must not be counted at all');
    assert.equal(snap.consecutiveTrips, 0);
    assert.equal(snap.paused, false);
});

test('cached cookies alone cannot confirm a search restriction', async () => {
    // Freshly loaded cookies have not established live authentication.
    const tracker = new SearchQuotaTracker();
    assert.equal(tracker.snapshot().lastServedAt, null, 'precondition: never served');

    const pauses = await run(fakeSession({ alive: true }), tracker, 25);

    assert.equal(pauses, 0, 'cached cookies are not live authentication evidence');
    assert.equal(tracker.snapshot().paused, false);
});

test('unknown session health cannot trigger a platform pause', async () => {
    // Unknown health requires diagnosis, not a quota verdict.
    const tracker = new SearchQuotaTracker();
    const pauses = await run(capabilityLessSession(), tracker, 25);
    assert.equal(pauses, 0);
});
