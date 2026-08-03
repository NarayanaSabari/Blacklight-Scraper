// Seat-leak backstop — regression tests for the 2026-08-03 outage.
//
// Both CloakBrowser seats sat leased for ~26h while `waiting` climbed to 576,
// starving dice/techfetch/linkedin/glassdoor/monster. Indeed was unaffected
// only because it uses the HTTP API and never takes a seat.
//
// The leak was not a missing release path: dice/techfetch close their browser
// in a `finally`. The orchestrator abandons a scrape after its own ~10 min
// timeout while the underlying promise keeps running, so the `finally` is never
// reached. A `close()` that hangs behaves identically. Neither is fixable from
// the call sites, hence the TTL reclaim in the pool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LicensePool } from '../../src/core/license-pool.js';

// Deterministic clock so nothing here sleeps.
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

const opts = (c, extra = {}) => ({
    locking: false,        // filesystem locks are covered by license-pool.test.js
    autoSweep: false,      // drive sweep() by hand
    now: c.now,
    ...extra,
});

test('sweep reclaims a seat held past the TTL and unblocks a waiter', async () => {
    const c = clock();
    const pool = new LicensePool(['k1'], opts(c, { leaseTtlMs: 60_000 }));

    const leaked = await pool.acquire('dice');       // never released — the bug
    assert.equal(pool.stats().free, 0);

    let got = null;
    const queued = pool.acquire('techfetch').then((l) => { got = l; });
    await Promise.resolve();
    assert.equal(pool.stats().waiting, 1, 'second caller must be queued');

    c.advance(59_000);
    pool.sweep();
    assert.equal(got, null, 'must not reclaim before the TTL elapses');

    c.advance(2_000);                                 // now past 60s
    pool.sweep();
    await queued;

    assert.ok(got, 'queued caller gets the reclaimed seat');
    assert.equal(pool.stats().reclaimed, 1);
    assert.equal(leaked.key, 'k1');
});

test('a late release from a reclaimed lease does NOT free the new holder seat', async () => {
    // Without fencing, the hung holder waking up would free a seat it no
    // longer owns — turning the leak fix into a double-free.
    const c = clock();
    const pool = new LicensePool(['k1'], opts(c, { leaseTtlMs: 1_000 }));

    const hung = await pool.acquire('dice');
    c.advance(2_000);
    pool.sweep();

    const successor = await pool.acquire('techfetch');
    assert.equal(pool.stats().free, 0, 'successor now holds the only seat');

    hung.release();                                   // the zombie finally wakes
    assert.equal(pool.stats().free, 0, 'successor seat must still be held');

    successor.release();
    assert.equal(pool.stats().free, 1);
});

test('healthy scrapes are never reclaimed (dice 32-81s, techfetch ~108s observed)', async () => {
    const c = clock();
    const pool = new LicensePool(['k1', 'k2'], opts(c, { leaseTtlMs: 5 * 60_000 }));

    const dice = await pool.acquire('dice');
    const techfetch = await pool.acquire('techfetch');

    c.advance(120_000);                               // slower than any measured run
    pool.sweep();
    assert.equal(pool.stats().reclaimed, 0, 'a 2-minute scrape is healthy, not a leak');

    dice.release();
    techfetch.release();
    assert.equal(pool.stats().free, 2);
});

test('starvation alert fires only when every seat is busy AND callers are queued', async () => {
    const c = clock();
    const pool = new LicensePool(['k1'], opts(c, {
        leaseTtlMs: 60 * 60_000,      // long, so TTL does not mask starvation
        starvationMs: 10 * 60_000,
    }));

    const held = await pool.acquire('dice');
    c.advance(20 * 60_000);
    pool.sweep();
    assert.equal(pool.stats().starved, false, 'busy with NO queue is not starvation');

    pool.acquire('techfetch');                        // deliberately not awaited
    await Promise.resolve();
    pool.sweep();
    assert.equal(pool.stats().starved, false, 'queue just formed — not yet sustained');

    c.advance(11 * 60_000);
    pool.sweep();
    assert.equal(pool.stats().starved, true, 'sustained queue with zero free seats');

    held.release();                                   // hands the seat to the waiter
    pool.sweep();
    assert.equal(pool.stats().starved, false, 'clears once a caller is served');
});

test('stats expose the deadlock signature (free + oldestLeaseMs)', async () => {
    const c = clock();
    const pool = new LicensePool(['k1', 'k2'], opts(c));

    assert.deepEqual(
        { seats: pool.stats().seats, free: pool.stats().free, oldest: pool.stats().oldestLeaseMs },
        { seats: 2, free: 2, oldest: 0 },
    );

    await pool.acquire('dice');
    c.advance(45_000);
    const s = pool.stats();
    assert.equal(s.free, 1);
    assert.equal(s.inUse, 1);
    assert.equal(s.oldestLeaseMs, 45_000, 'panel can see a climbing lease age');
});

test('sweep is idempotent — a reclaimed seat is not counted twice', async () => {
    const c = clock();
    const pool = new LicensePool(['k1'], opts(c, { leaseTtlMs: 1_000 }));
    await pool.acquire('dice');
    c.advance(5_000);
    pool.sweep();
    pool.sweep();
    pool.sweep();
    assert.equal(pool.stats().reclaimed, 1);
});
