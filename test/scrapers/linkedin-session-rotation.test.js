import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../src/scrapers/linkedin-session.js';

const HOUR_MS = 60 * 60 * 1000;

// Fake deps that count lease acquisitions + launches. Each acquire() hands out
// a fresh "account" so we can prove rotation lands on a NEW lease.
function fakeDeps() {
    let leases = 0, launches = 0, releases = 0;
    const apiClient = {
        acquire: async () => {
            leases++;
            return {
                credential: { id: leases, email: 'a@b.c', password: 'p' },
                reportSuccess: async () => {},
                reportFailure: async () => {},
                release: async () => { releases++; },
            };
        },
    };
    const launcher = async () => {
        launches++;
        return {
            newPage: async () => ({ close: async () => {} }),
            close: async () => {},
            browser: () => null,
        };
    };
    return {
        apiClient, launcher,
        counts: () => ({ leases, launches, releases }),
    };
}

// Deterministic clock: starts at a fixed epoch, advance() bumps it.
function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

test('ROTATION DISABLED by default (env unset) → withPage NEVER reestablishes even far in the future', async () => {
    const d = fakeDeps();
    const clk = fakeClock();
    const s = new LinkedInSession({
        apiClient: d.apiClient, launcher: d.launcher,
        jitter: () => Promise.resolve(), now: clk.now,
        rotateHours: undefined, // unset env default
    });
    await s.withPage('sess', async () => {});
    clk.advance(1000 * HOUR_MS); // 1000h later — way past any plausible cap
    await s.withPage('sess', async () => {});
    // Disabled → single lease + launch, no rotation regardless of elapsed time.
    assert.deepEqual(d.counts(), { leases: 1, launches: 1, releases: 0 });
});

test('ROTATION DISABLED for 0 / NaN / negative rotateHours', async () => {
    for (const h of ['0', '0.0', 'abc', '-5', '', null]) {
        const d = fakeDeps();
        const clk = fakeClock();
        const s = new LinkedInSession({
            apiClient: d.apiClient, launcher: d.launcher,
            jitter: () => Promise.resolve(), now: clk.now, rotateHours: h,
        });
        await s.withPage('sess', async () => {});
        clk.advance(10_000 * HOUR_MS);
        await s.withPage('sess', async () => {});
        assert.deepEqual(d.counts(), { leases: 1, launches: 1, releases: 0 },
            `rotateHours=${JSON.stringify(h)} must disable rotation`);
    }
});

test('ENABLED + lease aged past cap → reestablish once, fresh lease acquired', async () => {
    const d = fakeDeps();
    const clk = fakeClock();
    const s = new LinkedInSession({
        apiClient: d.apiClient, launcher: d.launcher,
        jitter: () => Promise.resolve(), now: clk.now,
        // rotationJitter returns [0,1) → cap factor [0.8,1.2); 0.5 = midpoint =
        // factor 1.0 → cap == 6h exactly (deterministic, no jitter).
        rotateHours: 6, rotationJitter: () => 0.5,
    });
    await s.withPage('sess', async () => {});
    assert.deepEqual(d.counts(), { leases: 1, launches: 1, releases: 0 });
    // Age past the 6h cap, then borrow again → must rotate.
    clk.advance(6 * HOUR_MS + 1);
    await s.withPage('sess', async () => {});
    const c = d.counts();
    assert.equal(c.leases, 2, 'a second lease acquired (rotation → next account)');
    assert.equal(c.launches, 2, 'context relaunched on the new lease');
    assert.equal(c.releases, 1, 'the old lease was released exactly once');
});

test('ENABLED + lease NOT yet aged → NO reestablish', async () => {
    const d = fakeDeps();
    const clk = fakeClock();
    const s = new LinkedInSession({
        apiClient: d.apiClient, launcher: d.launcher,
        jitter: () => Promise.resolve(), now: clk.now,
        rotateHours: 6, rotationJitter: () => 0.5, // midpoint → cap == 6h exactly
    });
    await s.withPage('sess', async () => {});
    clk.advance(6 * HOUR_MS - 1000); // just shy of the cap
    await s.withPage('sess', async () => {});
    assert.deepEqual(d.counts(), { leases: 1, launches: 1, releases: 0 },
        'within cap → no rotation');
});

test('JITTERED cap stays within +-20% of H for any jitter in [0,1)', async () => {
    const H = 10;
    const expectedMin = H * HOUR_MS * 0.8;
    const expectedMax = H * HOUR_MS * 1.2;
    for (const r of [0, 0.0001, 0.25, 0.5, 0.75, 0.999999]) {
        const d = fakeDeps();
        const clk = fakeClock();
        const s = new LinkedInSession({
            apiClient: d.apiClient, launcher: d.launcher,
            jitter: () => Promise.resolve(), now: clk.now,
            rotateHours: H, rotationJitter: () => r,
        });
        await s.ensureReady('sess'); // computes the cap
        const cap = s._maxLeaseMs;
        assert.ok(cap >= expectedMin && cap <= expectedMax,
            `cap ${cap} out of +-20% bounds [${expectedMin}, ${expectedMax}] for r=${r}`);
    }
});

test('_establishedAt refreshes on reestablish so it does NOT immediately re-rotate', async () => {
    const d = fakeDeps();
    const clk = fakeClock();
    const s = new LinkedInSession({
        apiClient: d.apiClient, launcher: d.launcher,
        jitter: () => Promise.resolve(), now: clk.now,
        rotateHours: 6, rotationJitter: () => 0.5, // midpoint → cap == 6h exactly
    });
    await s.withPage('sess', async () => {}); // establish #1 at t0
    const t0 = s._establishedAt;
    clk.advance(6 * HOUR_MS + 1);             // age past cap
    await s.withPage('sess', async () => {}); // rotates → establish #2 at t1
    const t1 = s._establishedAt;
    assert.ok(t1 > t0, '_establishedAt advanced after rotation');
    assert.equal(d.counts().leases, 2);
    // Borrow again immediately (no further time passes) → must NOT re-rotate.
    await s.withPage('sess', async () => {});
    assert.equal(d.counts().leases, 2, 'fresh lease is not immediately rotated again');
});

test('first establish never rotates even if clock already "aged" before establish', async () => {
    // A never-established session must establish (not rotate) on first withPage,
    // regardless of the clock — rotation only applies to an already-live lease.
    const d = fakeDeps();
    const clk = fakeClock();
    const s = new LinkedInSession({
        apiClient: d.apiClient, launcher: d.launcher,
        jitter: () => Promise.resolve(), now: clk.now,
        rotateHours: 6, rotationJitter: () => 0.5, // midpoint → cap == 6h exactly
    });
    clk.advance(100 * HOUR_MS); // clock far ahead before the very first establish
    await s.withPage('sess', async () => {});
    assert.deepEqual(d.counts(), { leases: 1, launches: 1, releases: 0 },
        'first establish leases+launches exactly once, never rotates');
});
