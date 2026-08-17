// Shadow-ban canary: streak tracking, probe verdicts, and the wiring into
// scrapeLinkedInRsc.
//
// The failure mode under test is the one every other detector misses: a
// shadow-banned account fails POLITELY (HTTP 200, valid session, "no
// results"), so it reports success forever and the pool keeps leasing it.
// Production 2026-08-13→17: ~50k zero-result sessions on one credential
// while its success_count climbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CanaryTracker, runCanary, CANARY_QUERY, DEFAULT_BAN_COOLDOWN_MINUTES,
} from '../../src/scrapers/linkedin-rsc/canary.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';

const LEASE_A = { credential: { profile_key: 'acct-a', name: 'A' } };
const LEASE_B = { credential: { profile_key: 'acct-b', name: 'B' } };

const POST = {
    activity_id: '7487914656553025536',
    post_url: 'https://www.linkedin.com/posts/x_y-7487914656553025536-AbCd',
    text: 'Hiring a Data Engineer on W2, remote',
    author_handle: 'x',
    posted_at: null,
};

// ─── CanaryTracker ──────────────────────────────────────────────────────

test('streak below threshold never asks for a probe', () => {
    const t = new CanaryTracker({ threshold: 3 });
    assert.equal(t.recordEmpty(LEASE_A), false);
    assert.equal(t.recordEmpty(LEASE_A), false);
});

test('streak at threshold asks for a probe', () => {
    const t = new CanaryTracker({ threshold: 3 });
    t.recordEmpty(LEASE_A);
    t.recordEmpty(LEASE_A);
    assert.equal(t.recordEmpty(LEASE_A), true);
});

test('a healthy scrape resets the streak', () => {
    const t = new CanaryTracker({ threshold: 2 });
    t.recordEmpty(LEASE_A);
    t.recordHealthy(LEASE_A);
    assert.equal(t.recordEmpty(LEASE_A), false, 'streak must restart from zero');
});

test('streaks are per credential, not global', () => {
    // One banned account must not spend the healthy account's probe budget —
    // and a healthy account's results must not mask the banned one.
    const t = new CanaryTracker({ threshold: 2 });
    t.recordEmpty(LEASE_A);
    t.recordEmpty(LEASE_B);
    assert.equal(t.recordEmpty(LEASE_A), true);
    assert.equal(t.streak(LEASE_B), 1);
});

test('probe interval floor prevents a canary per scrape while banned', () => {
    // If the ban report fails to land, the credential keeps getting leased —
    // without this floor every subsequent empty scrape would buy a probe.
    let clock = 0;
    const t = new CanaryTracker({ threshold: 2, probeIntervalMs: 1000, now: () => clock });
    t.recordEmpty(LEASE_A);
    assert.equal(t.recordEmpty(LEASE_A), true);
    t.noteProbe(LEASE_A);
    assert.equal(t.recordEmpty(LEASE_A), false, 'just probed — hold');
    clock += 1001;
    assert.equal(t.recordEmpty(LEASE_A), true, 'floor elapsed — probe again');
});

// ─── runCanary verdicts ─────────────────────────────────────────────────

function trackerAt(streak, lease = LEASE_A) {
    const t = new CanaryTracker({ threshold: streak });
    for (let i = 0; i < streak; i++) t.recordEmpty(lease);
    return t;
}

test('canary with posts → healthy, streak reset, no failure report', async () => {
    const reports = [];
    const lease = { ...LEASE_A, reportFailure: async (...a) => reports.push(a) };
    const t = trackerAt(5, lease);
    const verdict = await runCanary({
        tracker: t, lease, template: {}, cookies: [],
        paginateImpl: async ({ keywords }) => {
            assert.equal(keywords, CANARY_QUERY);
            return { posts: [POST] };
        },
    });
    assert.equal(verdict, 'healthy');
    assert.equal(t.streak(lease), 0);
    assert.equal(reports.length, 0, 'a healthy account must never be reported failed');
});

test('canary empty → shadow_banned, credential cooled for hours', async () => {
    const reports = [];
    const lease = { ...LEASE_A, reportFailure: async (msg, cooldown) => reports.push({ msg, cooldown }) };
    const t = trackerAt(5, lease);
    const verdict = await runCanary({
        tracker: t, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });
    assert.equal(verdict, 'shadow_banned');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].cooldown, DEFAULT_BAN_COOLDOWN_MINUTES);
    assert.match(reports[0].msg, /shadow-ban/i);
});

test('canary that errors is inconclusive — no failure report', async () => {
    // The triggering scrape already succeeded on the wire; a probe error must
    // not convert a healthy zero into a banned credential.
    const reports = [];
    const lease = { ...LEASE_A, reportFailure: async (...a) => reports.push(a) };
    const verdict = await runCanary({
        tracker: trackerAt(5, lease), lease, template: {}, cookies: [],
        paginateImpl: async () => { throw new Error('network blip'); },
    });
    assert.equal(verdict, 'inconclusive');
    assert.equal(reports.length, 0);
});

test('a failed reportFailure does not throw out of the canary', async () => {
    const lease = { ...LEASE_A, reportFailure: async () => { throw new Error('backend down'); } };
    const verdict = await runCanary({
        tracker: trackerAt(5, lease), lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });
    assert.equal(verdict, 'shadow_banned');
});

// ─── wiring into scrapeLinkedInRsc ──────────────────────────────────────

function fakeSession(lease) {
    return {
        async withCookies(_sessionId, fn) {
            return fn([{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }], lease);
        },
    };
}

const TEMPLATE = { url: 'https://x', headers: {}, postData: '{}' };

test('zero-yield scrapes accumulate and the canary fires at the threshold', async () => {
    const canaryCalls = [];
    const tracker = new CanaryTracker({ threshold: 2 });
    const opts = {
        session: fakeSession(LEASE_A),
        template: TEMPLATE,
        paginateImpl: async () => ({ posts: [], emptyConfirmed: true }),
        canaryTracker: tracker,
        runCanaryImpl: async (args) => { canaryCalls.push(args); return 'healthy'; },
    };
    await scrapeLinkedInRsc('Data Engineer', 'US', null, opts);
    assert.equal(canaryCalls.length, 0, 'below threshold — no probe');
    await scrapeLinkedInRsc('Data Engineer', 'US', null, opts);
    assert.equal(canaryCalls.length, 1, 'threshold hit — probe fires');
    // The probe runs with the SAME held template so it exercises the same
    // request identity the failing scrapes used.
    assert.equal(canaryCalls[0].template, TEMPLATE);
});

test('a scrape with posts marks the account healthy', async () => {
    const tracker = new CanaryTracker({ threshold: 2 });
    tracker.recordEmpty(LEASE_A);
    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session: fakeSession(LEASE_A),
        template: TEMPLATE,
        paginateImpl: async () => ({ posts: [POST], emptyConfirmed: false }),
        canaryTracker: tracker,
        runCanaryImpl: async () => { throw new Error('must not probe'); },
    });
    assert.equal(tracker.streak(LEASE_A), 0);
});

test('an up-to-date scrape (known ground) also counts as healthy', async () => {
    // upToDate means LinkedIn positively served posts we already hold — the
    // strongest possible health signal, despite yielding zero new jobs.
    const tracker = new CanaryTracker({ threshold: 2 });
    tracker.recordEmpty(LEASE_A);
    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session: fakeSession(LEASE_A),
        template: TEMPLATE,
        paginateImpl: async () => ({ posts: [], upToDate: true, emptyConfirmed: false }),
        canaryTracker: tracker,
        runCanaryImpl: async () => { throw new Error('must not probe'); },
    });
    assert.equal(tracker.streak(LEASE_A), 0);
});

test('the canary runs while the lease is still reportable (before reportSuccess)', async () => {
    // reportSuccess releases the lease. Production 2026-08-17: the canary
    // fired twice and both ban reports were dropped on a dead lease ("No
    // active credential to report failure for"), leaving the banned account
    // available for four more hours. The probe must run first.
    const order = [];
    const lease = {
        credential: { profile_key: 'acct-a', name: 'A' },
        reportSuccess: async () => order.push('success'),
        reportFailure: async () => order.push('failure'),
    };
    const tracker = new CanaryTracker({ threshold: 1 });
    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session: fakeSession(lease),
        template: TEMPLATE,
        paginateImpl: async () => ({ posts: [], emptyConfirmed: true }),
        canaryTracker: tracker,
        runCanaryImpl: async ({ lease: l }) => { await l.reportFailure(); return 'shadow_banned'; },
    });
    assert.deepEqual(order, ['failure'], 'ban report must precede (and replace) the success ping');
});

test('a healthy canary verdict still sends the liveness success ping', async () => {
    const order = [];
    const lease = {
        credential: { profile_key: 'acct-a', name: 'A' },
        reportSuccess: async () => order.push('success'),
        reportFailure: async () => order.push('failure'),
    };
    const tracker = new CanaryTracker({ threshold: 1 });
    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session: fakeSession(lease),
        template: TEMPLATE,
        paginateImpl: async () => ({ posts: [], emptyConfirmed: true }),
        canaryTracker: tracker,
        runCanaryImpl: async () => 'healthy',
    });
    assert.deepEqual(order, ['success']);
});
