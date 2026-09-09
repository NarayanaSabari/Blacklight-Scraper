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
    CanaryTracker, runCanary, CANARY_QUERIES, DEFAULT_BAN_COOLDOWN_MINUTES,
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
            // The probe rotates across the control set rather than sending one
            // fixed word every time — see CANARY_QUERIES.
            assert.ok(CANARY_QUERIES.includes(keywords), `unexpected probe query: ${keywords}`);
            return { posts: [POST] };
        },
    });
    assert.equal(verdict, 'healthy');
    assert.equal(t.streak(lease), 0);
    assert.equal(reports.length, 0, 'a healthy account must never be reported failed');
});

test('ONE empty probe is suspected, not banned', async () => {
    // A single empty probe took both production accounts offline on 2026-08-18
    // and stopped the pipeline dead. One probe is now a strike, not a verdict.
    const reports = [];
    const lease = { ...LEASE_A, reportFailure: async (...a) => reports.push(a) };
    const verdict = await runCanary({
        tracker: trackerAt(5, lease), lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });
    assert.equal(verdict, 'suspected');
    assert.equal(reports.length, 0, 'one probe must not cool a credential');
});

test('canary empty twice → shadow_banned, credential cooled for hours', async () => {
    const reports = [];
    const lease = { ...LEASE_A, reportFailure: async (msg, cooldown) => reports.push({ msg, cooldown }) };
    const t = trackerAt(5, lease);
    const probe = () => runCanary({
        tracker: t, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });
    assert.equal(await probe(), 'suspected');
    const verdict = await probe();
    assert.equal(verdict, 'shadow_banned');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].cooldown, DEFAULT_BAN_COOLDOWN_MINUTES);
    assert.match(reports[0].msg, /shadow-ban/i);
});

test('a probe that finds posts clears an earlier strike', async () => {
    // Corroboration must be CONSECUTIVE. An account that shows results between
    // two empty probes is visibly being served and starts over.
    const reports = [];
    const lease = { ...LEASE_A, reportFailure: async (...a) => reports.push(a) };
    const t = trackerAt(5, lease);
    const probeWith = (posts) => runCanary({
        tracker: t, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts }),
    });
    assert.equal(await probeWith([]), 'suspected');
    assert.equal(await probeWith([POST]), 'healthy');
    assert.equal(await probeWith([]), 'suspected', 'strike counter must have reset');
    assert.equal(reports.length, 0);
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
    const tracker = trackerAt(5, lease);
    const probe = () => runCanary({
        tracker, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });
    await probe();
    const verdict = await probe();
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

// ─── recovery after a ban ───────────────────────────────────────────────

test('a banned credential starts clean when it returns from cooldown', async () => {
    // PRODUCTION DOOM LOOP (2026-08-18 08:40 UTC). Link1's 4h cooldown expired
    // at 08:35. It was leased at 08:40:06, ran ONE session, and was re-banned
    // at 08:40:10 -- four seconds and a single scrape later, with the failure
    // message reading "after 15 consecutive zero-yield scrapes". Its streak had
    // been sitting at 14 in memory the whole time it was cooled, so the first
    // scrape back tipped it over and the probe floor had long since elapsed.
    //
    // An account could therefore never recover: every return from cooldown
    // bought exactly one scrape before another 4 hours off. Link1 went
    // 9 -> 10 failures this way while doing nothing wrong.
    const reports = [];
    const lease = {
        credential: { profile_key: 'acct-a', name: 'Link1' },
        reportFailure: async (msg, cooldown) => reports.push({ msg, cooldown }),
    };
    const tracker = new CanaryTracker({ threshold: 3, probeIntervalMs: 0 });

    // Drive it to a confirmed ban.
    for (let i = 0; i < 3; i += 1) tracker.recordEmpty(lease);
    const probe = () => runCanary({
        tracker, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });
    assert.equal(await probe(), 'suspected');
    assert.equal(await probe(), 'shadow_banned');
    assert.equal(reports.length, 1, 'banned once');

    // The credential is now cooled. When the pool hands it back, it must face
    // the full evidence bar again rather than one scrape.
    assert.equal(tracker.streak(lease), 0, 'streak must not survive the ban');
    assert.equal(tracker.suspicion(lease), 0, 'strikes must not survive the ban');
    assert.equal(
        tracker.recordEmpty(lease), false,
        'the first scrape after a cooldown must not immediately re-probe',
    );
});

// ─── credential identity ────────────────────────────────────────────────

test('evidence is keyed by credential id, not by a collidable label', async () => {
    // keyFor() used `profile_key || name || 'default'`. Neither of the first
    // two is guaranteed unique by the backend: scraper_credentials has NO
    // unique index on `name`, and profile_key is nullable — production's Link1
    // has none. Two credentials missing both collapsed onto the literal string
    // 'default' and shared one streak and one strike counter.
    //
    // Consequences, both bad: a healthy account convicted on a banned
    // sibling's evidence, and reset() on one silently clearing the other.
    const t = new CanaryTracker({ threshold: 5 });
    const a = { credential: { id: 1, name: '', profile_key: null } };
    const b = { credential: { id: 2, name: '', profile_key: null } };

    t.recordEmpty(a);
    t.recordEmpty(a);
    t.recordEmpty(a);

    assert.equal(t.streak(a), 3);
    assert.equal(t.streak(b), 0, 'a second credential must not inherit the first evidence');
});

test('the production credential shapes stay isolated', async () => {
    // Link1 (id 15, profile_key NULL) and Link2 (id 17, profile_key set).
    const t = new CanaryTracker({ threshold: 5 });
    const link1 = { credential: { id: 15, name: 'Link1', profile_key: null } };
    const link2 = { credential: { id: 17, name: 'Link2', profile_key: 'li-acct-2' } };

    t.recordEmpty(link1);
    t.recordEmpty(link1);
    assert.equal(t.streak(link2), 0);
    t.reset(link1);
    t.recordEmpty(link2);
    assert.equal(t.streak(link2), 1, 'resetting one credential must not touch the other');
});

test('a lease with no id at all still works (older payloads, hand-built tests)', () => {
    const t = new CanaryTracker({ threshold: 5 });
    const byKey = { credential: { profile_key: 'acct-x' } };
    t.recordEmpty(byKey);
    assert.equal(t.streak(byKey), 1, 'profile_key remains a usable fallback');
});

// ─── detection latency for a GENUINE ban ────────────────────────────────

test('corroboration does not leave a banned account scraping for half an hour', async () => {
    // Two strikes fixed the false positive, but naively it also doubled the
    // wait for a REAL ban — and the 30-minute probe floor, not the strike
    // count, was what dominated. Measured on a banned account paced at 25s:
    //
    //   one strike            10 scrapes,  4.2 min
    //   two strikes @ 30min   82 scrapes, 34.2 min   <- 72 extra scrapes
    //   two strikes @  5min   22 scrapes,  9.2 min
    //
    // Every extra scrape is a request from an account LinkedIn is already
    // refusing, which is the behaviour that deepens a ban. The long floor
    // exists to stop probe storms in the steady state; a credential already
    // carrying an unresolved strike is one probe from a verdict, so it gets
    // the short floor.
    let clock = 0;
    let scrapes = 0;
    let banned = false;
    const tracker = new CanaryTracker({ threshold: 10, now: () => clock });
    const lease = { credential: { id: 1 }, reportFailure: async () => { banned = true; } };

    while (!banned && scrapes < 5000) {
        scrapes += 1;
        clock += 25_000;                       // paced cadence
        if (tracker.recordEmpty(lease)) {
            // eslint-disable-next-line no-await-in-loop
            await runCanary({
                tracker, lease, template: {}, cookies: [],
                paginateImpl: async () => ({ posts: [] }),
            });
        }
    }

    assert.ok(banned, 'a genuinely dark account must still be cooled');
    assert.ok(
        clock <= 15 * 60_000,
        `took ${(clock / 60_000).toFixed(1)}min to cool a banned account — too long, `
        + 'every extra scrape deepens the ban',
    );
});

test('the short corroboration floor does NOT weaken false-positive protection', async () => {
    // The whole point of two strikes is that ONE empty probe cannot cool a
    // credential. Shortening the gap between probes must not quietly restore
    // single-probe convictions.
    const reports = [];
    let clock = 0;
    const tracker = new CanaryTracker({ threshold: 2, now: () => clock });
    const lease = {
        credential: { id: 2 },
        reportFailure: async (...a) => reports.push(a),
    };

    tracker.recordEmpty(lease);
    tracker.recordEmpty(lease);
    const verdict = await runCanary({
        tracker, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });

    assert.equal(verdict, 'suspected');
    assert.equal(reports.length, 0, 'one probe must still never cool a credential');
});

// ─── inconclusive probes ────────────────────────────────────────────────

test('a network blip does not cost the probe budget', async () => {
    // noteProbe() stamps BEFORE the request, so an errored probe used to be
    // charged the full 30-minute floor despite learning nothing. With every
    // second probe blipping, a genuinely banned credential took 106 scrapes /
    // 44.2 min to cool instead of 22 / 9.2 min — a flaky link made a banned
    // account look healthy.
    let clock = 0;
    const tracker = new CanaryTracker({ threshold: 2, now: () => clock });
    const lease = { credential: { id: 1 }, reportFailure: async () => {} };

    tracker.recordEmpty(lease);
    tracker.recordEmpty(lease);
    const verdict = await runCanary({
        tracker, lease, template: {}, cookies: [],
        paginateImpl: async () => { throw new Error('network blip'); },
    });
    assert.equal(verdict, 'inconclusive');
    assert.equal(tracker.suspicion(lease), 0, 'an inconclusive probe is not evidence');

    // A short retry gap later, the probe is due again — not 30 minutes later.
    clock += 31_000;
    assert.equal(tracker.recordEmpty(lease), true, 'must retry soon after a blip');
});

test('repeated inconclusive probes back off instead of storming', async () => {
    // The naive fix (clear the stamp outright) produced 1,991 probes in 13.9h —
    // 143/hour, one per scrape — when every probe errored. A dead proxy or a
    // stale template would hammer LinkedIn from an account already under
    // suspicion. Each consecutive inconclusive verdict now doubles the retry
    // gap, capped at the normal floor.
    let clock = 0;
    let probes = 0;
    const tracker = new CanaryTracker({ threshold: 10, now: () => clock });
    const lease = { credential: { id: 2 }, reportFailure: async () => {} };

    for (let i = 0; i < 2000; i += 1) {
        clock += 25_000;
        if (tracker.recordEmpty(lease)) {
            probes += 1;
            // eslint-disable-next-line no-await-in-loop
            await runCanary({
                tracker, lease, template: {}, cookies: [],
                paginateImpl: async () => { throw new Error('always fails'); },
            });
        }
    }

    const hours = clock / 3_600_000;
    const perHour = probes / hours;
    assert.ok(perHour < 10, `probe storm: ${perHour.toFixed(1)}/hour over ${hours.toFixed(1)}h`);
});

test('a flaky network barely delays a genuine ban verdict', async () => {
    let clock = 0;
    let scrapes = 0;
    let probes = 0;
    let banned = false;
    const tracker = new CanaryTracker({ threshold: 10, now: () => clock });
    const lease = { credential: { id: 3 }, reportFailure: async () => { banned = true; } };

    while (!banned && scrapes < 20_000) {
        scrapes += 1;
        clock += 25_000;
        if (tracker.recordEmpty(lease)) {
            probes += 1;
            const blips = probes % 2 === 1;
            // eslint-disable-next-line no-await-in-loop
            await runCanary({
                tracker, lease, template: {}, cookies: [],
                paginateImpl: blips
                    ? async () => { throw new Error('blip'); }
                    : async () => ({ posts: [] }),
            });
        }
    }

    assert.ok(banned, 'a banned account must still be cooled through a flaky link');
    assert.ok(
        clock <= 15 * 60_000,
        `took ${(clock / 60_000).toFixed(1)}min through a flaky link (clean path is ~9.2min)`,
    );
});

// ─── auth failures must not be confused with bans ───────────────────────

test('a dead session (403) surfaces as AuthError before any canary verdict', async () => {
    // The two failure modes have opposite remedies: a dead cookie needs an
    // operator re-login, a shadow ban needs quiet time. Conflating them would
    // put a NEEDS_RELOGIN credential into a 4-hour ban cooldown, delaying the
    // one action that actually fixes it.
    //
    // The separation is structural, not incidental: fetchPage maps 403 to
    // AuthError, so a dead session throws out of paginate() and never reaches
    // the canary's zero-yield accounting at all. Pinning that, because the
    // canary's own logic could not tell the difference if it ever did.
    const { paginate } = await import('../../src/scrapers/linkedin-rsc/client.js');
    const { AuthError } = await import('../../src/core/errors.js');

    await assert.rejects(
        () => paginate({
            template: { url: 'https://x', headers: { 'user-agent': 'u' }, postData: '{}' },
            cookies: [{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"x"' }],
            keywords: 'q',
            fetchImpl: async () => ({ status: 403, text: async () => '' }),
            delay: async () => {},
        }),
        (err) => {
            assert.ok(err instanceof AuthError, `expected AuthError, got ${err?.constructor?.name}`);
            assert.equal(err.code, 'NEEDS_RELOGIN');
            return true;
        },
    );
});

test('a rate limit (429) is a block, not a ban verdict either', async () => {
    // 429 means "slow down", which the pacer answers. Treating it as a ban
    // would cool a perfectly good credential for hours over a burst.
    const { paginate } = await import('../../src/scrapers/linkedin-rsc/client.js');
    const { BlockedError } = await import('../../src/core/errors.js');

    await assert.rejects(
        () => paginate({
            template: { url: 'https://x', headers: { 'user-agent': 'u' }, postData: '{}' },
            cookies: [{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"x"' }],
            keywords: 'q',
            fetchImpl: async () => ({ status: 429, text: async () => '' }),
            delay: async () => {},
        }),
        (err) => {
            assert.ok(err instanceof BlockedError, `expected BlockedError, got ${err?.constructor?.name}`);
            assert.equal(err.kind, 'rate_limit');
            return true;
        },
    );
});

test('a returning credential is not convicted by luck of the draw', async () => {
    // PRODUCTION, 2026-08-18. Two credentials came off cooldown into the SAME
    // unrestarted process, both carrying a stale above-threshold streak:
    //
    //   Link1 08:40  first scrape 0 jobs   -> streak tipped -> re-banned in 4s
    //   Link2 10:30  first scrape 17 jobs  -> recordHealthy() cleared it -> fine
    //
    // So the doom loop is probabilistic, not deterministic: a healthy account's
    // fate depended on whether its first query after cooldown happened to be
    // productive. That is still a bug — a thin query is not evidence of a ban,
    // and a returning credential should face the full bar either way.
    //
    // Guards BOTH halves: the ban must clear the evidence, so the unlucky
    // ordering can no longer convict.
    const tracker = new CanaryTracker({ threshold: 3, probeIntervalMs: 0 });
    const lease = { credential: { id: 42 }, reportFailure: async () => {} };

    // Drive to a ban.
    for (let i = 0; i < 3; i += 1) tracker.recordEmpty(lease);
    await runCanary({
        tracker, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });
    await runCanary({
        tracker, lease, template: {}, cookies: [],
        paginateImpl: async () => ({ posts: [] }),
    });

    // Cooldown elapses. The UNLUCKY case: first scrape back is zero-yield.
    // Link1's exact situation, and it must no longer be enough to convict.
    assert.equal(
        tracker.recordEmpty(lease), false,
        'one thin query after a cooldown must not re-trip the canary',
    );
    assert.equal(tracker.streak(lease), 1, 'the streak restarts from zero, not from the old total');
});
