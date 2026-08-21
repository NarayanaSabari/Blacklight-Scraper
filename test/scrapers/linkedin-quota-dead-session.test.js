// Regression: a DEAD SESSION must never be read as a platform search quota.
//
// PRODUCTION INCIDENT (2026-08-19/20, m1)
//   08-19 11:09  sessionAlive false, lastServedAt null, 26 empties, 3 trips
//                — all within 3.4h of boot, i.e. the host had NEVER worked
//   08-20 10:21  9 trips, pinned at the 4h ceiling, 8.6h since a real scrape
//
//   The session was simply not logged in. An unauthenticated session answers
//   every query with a confirmed empty, which is byte-identical on the wire to
//   LinkedIn metering content search, so the quota tracker convicted the
//   platform for the host's own broken login. A pause cannot fix a dead
//   session, so every expiry re-tripped and doubled. The quota pause also
//   overwrote the auth cooldown marker, taking the "run npm run linkedin:login"
//   instruction with it.
//
// THE TWO INVARIANTS, which must hold AT ONCE:
//   dead session + empties                     -> NEVER trips
//   live session + real block + never served   -> STILL trips
//
// The second is not hypothetical. On 2026-08-20 11:12 the host was freshly
// restarted (lastServedAt null, no success yet this process) while LinkedIn was
// genuinely refusing every content query — confirmed independently by
// scripts/linkedin-search-scope.js, which saw 12 profiles on `all` search and
// zero on every content search. A gate that required a prior success would
// never back off in exactly that situation, which is the opposite failure.

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

test('a LIVE session still trips on a real block, even with no prior success', async () => {
    // The 2026-08-20 11:12 state: freshly restarted, never served, real block.
    const tracker = new SearchQuotaTracker();
    assert.equal(tracker.snapshot().lastServedAt, null, 'precondition: never served');

    const pauses = await run(fakeSession({ alive: true }), tracker, 25);

    assert.equal(pauses, 1, 'a genuine platform block must still back off');
    assert.equal(tracker.snapshot().paused, true);
});

test('a session that cannot report liveness keeps the previous behaviour', async () => {
    // No opinion must not silently disable quota detection.
    const tracker = new SearchQuotaTracker();
    const pauses = await run(capabilityLessSession(), tracker, 25);
    assert.equal(pauses, 1);
});
