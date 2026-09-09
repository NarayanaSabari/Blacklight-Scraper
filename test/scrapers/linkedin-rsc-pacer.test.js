// Per-account request pacing.
//
// Guards the burst signature from the 2026-08-18 incident: 12 LinkedIn
// sessions between 06:29:05 and 06:29:32 on one credential, gaps of 1.6-4.6s.
// The backend's 15-minute floor is per QUEUE ROW and cannot see this; it
// bounds how often one search repeats, not how close together different
// searches run on one account.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    RequestPacer, DEFAULT_MIN_SPACING_MS, minSpacingMs, jitterMs,
} from '../../src/scrapers/linkedin-rsc/pacer.js';
import { CanaryTracker } from '../../src/scrapers/linkedin-rsc/canary.js';

const LEASE_A = { credential: { profile_key: 'acct-a', name: 'A' } };
const LEASE_B = { credential: { profile_key: 'acct-b', name: 'B' } };

function pacerAt(clock, opts = {}) {
    const slept = [];
    const pacer = new RequestPacer({
        spacingMs: 20_000,
        jitter: 0,
        now: () => clock.t,
        sleep: async (ms) => { slept.push(ms); clock.t += ms; },
        rng: () => 0,
        ...opts,
    });
    return { pacer, slept };
}

test('the first scrape on a credential never waits', async () => {
    const clock = { t: 1_000 };
    const { pacer, slept } = pacerAt(clock);
    assert.equal(await pacer.pace(LEASE_A), 0);
    assert.deepEqual(slept, []);
});

test('a second scrape immediately after is spaced out', async () => {
    const clock = { t: 0 };
    const { pacer } = pacerAt(clock);
    await pacer.pace(LEASE_A);
    clock.t += 2_000;                      // the observed 2s burst gap
    const waited = await pacer.pace(LEASE_A);
    assert.equal(waited, 18_000, 'must top the gap up to the 20s floor');
});

test('a scrape that arrives after the floor does not wait at all', async () => {
    const clock = { t: 0 };
    const { pacer } = pacerAt(clock);
    await pacer.pace(LEASE_A);
    clock.t += 45_000;
    assert.equal(await pacer.pace(LEASE_A), 0);
});

test('the burst that got the account banned is fully paced', async () => {
    // Replay the production shape: 12 back-to-back scrapes arriving ~2s apart.
    // Every one after the first must be held to the floor.
    const clock = { t: 0 };
    const { pacer } = pacerAt(clock);
    const waits = [];
    for (let i = 0; i < 12; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        waits.push(await pacer.pace(LEASE_A));
        clock.t += 2_000;
    }
    assert.equal(waits[0], 0, 'first scrape runs immediately');
    assert.ok(waits.slice(1).every((w) => w === 18_000), `unexpected waits: ${waits}`);
    // 11 gaps of 20s: the burst is stretched from 24 seconds to ~3.7 minutes.
    assert.ok(clock.t >= 11 * 20_000, `burst not spread: ended at ${clock.t}ms`);
});

test('pacing is per credential — one account never delays another', async () => {
    // Two accounts exist precisely so work can proceed in parallel; a shared
    // clock would serialise them and halve throughput for no safety gain.
    const clock = { t: 0 };
    const { pacer } = pacerAt(clock);
    await pacer.pace(LEASE_A);
    assert.equal(await pacer.pace(LEASE_B), 0);
});

test('jitter keeps the gap from being a constant', async () => {
    const clock = { t: 0 };
    const { pacer } = pacerAt(clock, { jitter: 10_000, rng: () => 0.5 });
    await pacer.pace(LEASE_A);
    assert.equal(pacer.waitFor(LEASE_A), 25_000, 'floor + half the jitter window');
});

test('spacing can be disabled outright', async () => {
    const clock = { t: 0 };
    const { pacer, slept } = pacerAt(clock, { spacingMs: 0 });
    await pacer.pace(LEASE_A);
    assert.equal(await pacer.pace(LEASE_A), 0);
    assert.deepEqual(slept, []);
});

test('env overrides are read, with sane fallbacks', () => {
    assert.equal(minSpacingMs({}), DEFAULT_MIN_SPACING_MS);
    assert.equal(minSpacingMs({ LINKEDIN_MIN_REQUEST_SPACING_MS: '5000' }), 5_000);
    assert.equal(minSpacingMs({ LINKEDIN_MIN_REQUEST_SPACING_MS: '0' }), 0, 'explicit 0 disables');
    assert.equal(minSpacingMs({ LINKEDIN_MIN_REQUEST_SPACING_MS: 'nonsense' }), DEFAULT_MIN_SPACING_MS);
    assert.equal(jitterMs({ LINKEDIN_REQUEST_SPACING_JITTER_MS: '250' }), 250);
});

// ─── wiring into scrapeLinkedInRsc ──────────────────────────────────────

test('the real scrape path paces, and an injected paginate does not', async () => {
    // Two-sided on purpose. The default must actually pace (or this whole
    // module is dead code shipped to production), and an injected paginateImpl
    // must NOT (or every test touching the scrape path sits through a 20s
    // floor per call — measured: the canary suite went 0.2s → 130s).
    const { scrapeLinkedInRsc } = await import('../../src/scrapers/linkedin-rsc/scraper.js');
    const lease = { credential: { profile_key: 'wire-test' }, reportSuccess: async () => {} };
    const session = {
        async withCookies(_id, fn) {
            return fn([{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }], lease);
        },
    };
    const paced = [];
    const spy = { pace: async (l) => { paced.push(l); return 0; } };

    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session,
        template: { url: 'https://x', headers: {}, postData: '{}' },
        paginateImpl: async () => ({ posts: [], emptyConfirmed: true, pages: [] }),
        canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
        pacer: spy,
    });
    assert.equal(paced.length, 1, 'an explicitly supplied pacer is always honoured');
    assert.equal(paced[0], lease, 'paced against the held lease, not a global key');
});

test('pacing is keyed by credential id, so two accounts never share a clock', async () => {
    // The same keyFor() collision as canary.js, and worse here: two accounts
    // sharing one clock would pace EACH OTHER, halving throughput for no safety
    // gain. A credential pool exists precisely so accounts run independently.
    const clock = { t: 0 };
    const { pacer } = pacerAt(clock);
    const a = { credential: { id: 1, name: '', profile_key: null } };
    const b = { credential: { id: 2, name: '', profile_key: null } };

    await pacer.pace(a);
    assert.equal(await pacer.pace(b), 0, 'a second credential must start immediately');
    assert.ok(pacer.waitFor(a) > 0, 'while the first is still held to its own floor');
});

// ─── concurrency ────────────────────────────────────────────────────────

test('concurrent scrapes on ONE credential are still spaced apart', async () => {
    // scraper_platforms.max_inflight is 2 for linkedin IN PRODUCTION, and the
    // orchestrator runs platform tasks under Promise.allSettled — so two
    // scrapes on one credential genuinely overlap.
    //
    // The original pace() read waitFor(), awaited the sleep, and only THEN
    // stamped the clock. Both callers observed the same `last`: the first
    // waited its 20s, the second computed 0 and fired immediately. That is the
    // exact back-to-back burst this class exists to prevent, appearing
    // precisely when load is highest. Measured pre-fix: waits were [20000, 0].
    const clock = { t: 0 };
    const { pacer } = pacerAt(clock);
    const lease = { credential: { id: 1 } };

    await pacer.pace(lease);
    const [a, b] = await Promise.all([pacer.pace(lease), pacer.pace(lease)]);
    assert.ok(a > 0 && b > 0, `both concurrent scrapes must wait, got [${a}, ${b}]`);
});

test('many concurrent scrapes queue into distinct slots', async () => {
    // Each caller must reserve a LATER slot than the one before, rather than
    // all piling onto the same one.
    const pacer = new RequestPacer({
        spacingMs: 20_000, jitter: 0, now: () => 0, sleep: async () => {}, rng: () => 0,
    });
    const lease = { credential: { id: 2 } };
    const waits = await Promise.all([1, 2, 3, 4, 5].map(() => pacer.pace(lease)));

    assert.deepEqual(waits, [0, 20_000, 40_000, 60_000, 80_000]);
});

test('under a real clock, concurrent scrapes actually start apart', async () => {
    // The injected-clock tests prove the arithmetic; this proves the behaviour,
    // since a wall-clock sleep is what production actually does.
    const pacer = new RequestPacer({ spacingMs: 150, jitter: 0 });
    const lease = { credential: { id: 9 } };
    const starts = [];
    const run = async () => { await pacer.pace(lease); starts.push(Date.now()); };

    await Promise.all([run(), run(), run(), run()]);

    starts.sort((x, y) => x - y);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    assert.ok(
        gaps.every((g) => g >= 140),
        `concurrent scrapes must start ~150ms apart, got gaps [${gaps.join(', ')}]`,
    );
});
