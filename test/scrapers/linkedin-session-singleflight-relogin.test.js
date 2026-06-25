import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LinkedInSession,
    linkedinSingleFlightRelogin,
} from '../../src/scrapers/linkedin-session.js';
import { AuthError } from '../../src/core/errors.js';

const tick = () => new Promise((r) => setImmediate(r));

// A fake CloakBrowser context whose pages track open/close so we can assert
// "no teardown while a page is live". The launcher hands out a fresh context
// per launch so we can count re-launches (= re-logins).
function makeLauncher() {
    const state = { launches: 0, closes: 0, livePages: 0, maxLivePages: 0 };
    const launcher = async () => {
        state.launches++;
        return {
            newPage: async () => {
                state.livePages++;
                state.maxLivePages = Math.max(state.maxLivePages, state.livePages);
                return { close: async () => { state.livePages--; } };
            },
            close: async () => { state.closes++; },
        };
    };
    return { state, launcher };
}

// A fake credentials pool: acquire() hands out sequential leases so a re-login
// (re-acquire) is observable as a NEW credential id.
function makePool(opts = {}) {
    const state = { acquires: 0, released: 0 };
    const apiClient = {
        isLocal: opts.isLocal ?? false, // REMOTE by default (pool mode)
        acquire: async () => {
            state.acquires++;
            if (opts.acquireReturnsNull) return null;
            if (opts.acquireNullAfter != null && state.acquires > opts.acquireNullAfter) return null;
            return {
                credential: { id: `acct-${state.acquires}`, profile_key: null, cookies: null },
                release: async () => { state.released++; },
            };
        },
    };
    return { state, apiClient };
}

function makeSession(extra = {}) {
    const { state: launchState, launcher } = makeLauncher();
    const { state: poolState, apiClient } = makePool(extra.pool);
    const session = new LinkedInSession({
        apiClient,
        launcher,
        maxConcurrency: 2,
        jitter: () => Promise.resolve(),
        singleFlightRelogin: true,
        ...extra.session,
    });
    return { session, launchState, poolState };
}

test('linkedinSingleFlightRelogin: default off; 1/true/yes → on; junk → off', () => {
    assert.equal(linkedinSingleFlightRelogin({}), false);
    assert.equal(linkedinSingleFlightRelogin({ LINKEDIN_SINGLEFLIGHT_RELOGIN: '1' }), true);
    assert.equal(linkedinSingleFlightRelogin({ LINKEDIN_SINGLEFLIGHT_RELOGIN: 'true' }), true);
    assert.equal(linkedinSingleFlightRelogin({ LINKEDIN_SINGLEFLIGHT_RELOGIN: 'yes' }), true);
    assert.equal(linkedinSingleFlightRelogin({ LINKEDIN_SINGLEFLIGHT_RELOGIN: '0' }), false);
    assert.equal(linkedinSingleFlightRelogin({ LINKEDIN_SINGLEFLIGHT_RELOGIN: 'nope' }), false);
    assert.equal(linkedinSingleFlightRelogin({ LINKEDIN_SINGLEFLIGHT_RELOGIN: '' }), false);
});

test('flag ON: AuthError mid-scrape triggers ONE re-login (fresh pool lease) and retries the role once', async () => {
    const { session, launchState, poolState } = makeSession();
    let calls = 0;
    const seenLeaseIds = [];
    const result = await session.withPage('sid', async (page, lease) => {
        calls++;
        seenLeaseIds.push(lease.credential.id);
        if (calls === 1) throw new AuthError('LinkedIn session not authenticated (cookies expired/rotated)');
        return 'scraped';
    });
    assert.equal(result, 'scraped', 'role succeeded on the retry after re-login');
    assert.equal(calls, 2, 'fn retried exactly once');
    assert.equal(poolState.acquires, 2, 'exactly one re-login: initial lease + one fresh pool lease');
    assert.deepEqual(seenLeaseIds, ['acct-1', 'acct-2'], 'retry used the freshly rotated lease');
    assert.ok(launchState.closes >= 1, 'old context torn down during re-login');
    assert.ok(launchState.launches >= 2, 'fresh context launched on re-login');
});

test('flag ON: re-login retries the role only ONCE — a second AuthError propagates (no infinite loop)', async () => {
    const { session, poolState } = makeSession();
    let calls = 0;
    await assert.rejects(
        session.withPage('sid', async () => { calls++; throw new AuthError('still dead'); }),
        (err) => err instanceof AuthError,
    );
    assert.equal(calls, 2, 'tried original + exactly one retry');
    assert.equal(poolState.acquires, 2, 'exactly one re-login attempt');
});

test('flag OFF (default): AuthError is NOT retried — propagates, no re-login (legacy behavior)', async () => {
    const { state: launchState, launcher } = makeLauncher();
    const { state: poolState, apiClient } = makePool();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 2, jitter: () => Promise.resolve(),
        // singleFlightRelogin omitted → default off
    });
    let calls = 0;
    await assert.rejects(
        session.withPage('sid', async () => { calls++; throw new AuthError('dead'); }),
        (err) => err instanceof AuthError,
    );
    assert.equal(calls, 1, 'no retry when the flag is off');
    assert.equal(poolState.acquires, 1, 'no re-login when the flag is off');
    assert.equal(launchState.launches, 1, 'context launched once only');
});

test('flag ON: two concurrent AuthErrors trigger exactly ONE shared re-login (not one per tab)', async () => {
    const { session, poolState } = makeSession();
    const callsPerTab = [0, 0];
    const run = (i) => session.withPage('sid', async (page, lease) => {
        callsPerTab[i]++;
        if (callsPerTab[i] === 1) throw new AuthError('dead');
        return `ok-${i}`;
    });
    const results = await Promise.all([run(0), run(1)]);
    assert.deepEqual(results.sort(), ['ok-0', 'ok-1'], 'both roles recovered');
    assert.equal(poolState.acquires, 2, 'ONE initial lease + ONE shared re-login (not 3)');
});

test('flag ON: re-login quiesces — the shared context is never torn down while a sibling page is live', async () => {
    const closeWitness = []; // live-page count observed at each context.close()
    let livePages = 0;
    const launcher = async () => ({
        newPage: async () => { livePages++; return { close: async () => { livePages--; } }; },
        close: async () => { closeWitness.push(livePages); },
    });
    const { state: poolState, apiClient } = makePool();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 2, jitter: () => Promise.resolve(), singleFlightRelogin: true,
    });

    let releaseSibling;
    const held = new Promise((r) => { releaseSibling = r; });
    // Tab A: a slow sibling that keeps its page open until released.
    const tabA = session.withPage('sid', async () => { await held; return 'A'; });
    await tick(); // let A borrow its page
    // Tab B: dead auth on the first lease → triggers a re-login while A is live.
    const tabB = session.withPage('sid', async (page, lease) => {
        if (lease.credential.id === 'acct-1') throw new AuthError('dead');
        return 'B';
    });
    await tick(); await tick(); // B fails and reaches the quiesce wait (blocked on A)
    assert.equal(closeWitness.length, 0, 're-login blocked: no teardown while A holds a live page');

    releaseSibling();
    const [ra, rb] = await Promise.all([tabA, tabB]);
    assert.equal(ra, 'A');
    assert.equal(rb, 'B', 'B recovered on the fresh lease');
    assert.ok(closeWitness.length >= 1, 'context eventually torn down for the re-login');
    assert.deepEqual(closeWitness.filter((n) => n > 0), [], 'EVERY teardown happened at 0 live pages');
    assert.equal(poolState.acquires, 2, 'one shared re-login');
});

test('flag ON: a healthy session still runs tabs in PARALLEL with no re-login', async () => {
    const { session, launchState, poolState } = makeSession();
    await Promise.all(Array.from({ length: 4 }, () =>
        session.withPage('sid', async () => { await tick(); await tick(); })));
    assert.equal(launchState.maxLivePages, 2, 'two tabs ran concurrently (parallelism preserved)');
    assert.equal(poolState.acquires, 1, 'no re-login on a healthy session');
    assert.equal(launchState.closes, 0, 'no teardown on a healthy session');
});

test('flag ON: a re-login that finds no pool account fails the role cleanly (no infinite loop)', async () => {
    const { session, poolState } = makeSession({
        pool: { acquireNullAfter: 1 },
        session: { maxLeaseRetries: 1, leaseRetryDelayMs: 0 },
    });
    let calls = 0;
    await assert.rejects(
        session.withPage('sid', async () => { calls++; throw new AuthError('dead'); }),
        (err) => /No LinkedIn credential available/.test(err.message),
    );
    assert.equal(calls, 1, 'no retry — re-login could not obtain a fresh account');
    assert.equal(poolState.acquires, 2, 'one initial lease + one (failed) re-login attempt, then stop');
});

test('flag ON: reestablish() is a NO-OP — re-login is coordinated by withPage, not the in-fn call', async () => {
    // linkedin.js calls session.reestablish() from INSIDE the withPage callback
    // (page still open). With single-flight on it must NOT tear down the context
    // there; the real re-login happens after fn throws + the page closes.
    const { state: launchState, launcher } = makeLauncher();
    const { state: poolState, apiClient } = makePool();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 2, jitter: () => Promise.resolve(), singleFlightRelogin: true,
    });
    await session.ensureReady('sid');
    await session.reestablish('sid');
    assert.equal(launchState.closes, 0, 'no teardown from reestablish() when single-flight is on');
    assert.equal(poolState.acquires, 1, 'no extra lease acquired by reestablish()');
    assert.ok(session.isAlive(), 'context still alive');
});

export { tick, makeLauncher, makePool, makeSession, AuthError };
