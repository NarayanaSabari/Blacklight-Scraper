// SCR-17: #establish used to assign this._lease BEFORE launching the
// browser. If the launch (or any step of establishing) threw, the method
// propagated with the lease still held and nothing released it — the
// credential stayed `in_use` with nothing using it, recoverable only by the
// backend's reaper. This suite pins the fix: the lease is scoped to the
// establish attempt, released on any non-NEEDS_RELOGIN failure, and never
// left set alongside a null _context once the failure has been fully
// handled — while NEEDS_RELOGIN keeps going through withPage's authDead
// report instead of a plain release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../src/scrapers/linkedin-session.js';
import { AuthError } from '../../src/core/errors.js';

// A launcher that always throws, simulating Chrome missing / profile locked /
// proxy dead / disk full — anything that isn't the NEEDS_RELOGIN branch.
function makeLaunchFailureSession(launchError = new Error('spawn ENOENT: chrome not found')) {
    const calls = { acquires: 0, releases: 0, launches: 0 };
    const lease = {
        credential: { id: 'acct-1', profile_key: 'li-profile-1', proxy: null },
        release: async () => { calls.releases++; },
        reportFailure: async () => { throw new Error('reportFailure must not be called on a plain launch failure'); },
    };
    const apiClient = {
        isLocal: false,
        acquire: async () => { calls.acquires++; return lease; },
    };
    const launcher = async () => { calls.launches++; throw launchError; };
    const session = new LinkedInSession({
        apiClient,
        launcher,
        maxConcurrency: 1,
        jitter: () => Promise.resolve(),
        maxLeaseRetries: 1,
        leaseRetryDelayMs: 0,
    });
    return { session, calls, lease };
}

test('SCR-17: injected launcher throws → lease.release() is called and _lease is cleared', async () => {
    const { session, calls } = makeLaunchFailureSession();

    await assert.rejects(
        () => session.ensureReady('sid'),
        /chrome not found/,
    );

    assert.equal(calls.releases, 1, 'lease.release() must be called exactly once');
    assert.equal(session.lease, null, '_lease must be cleared after the failed establish');
    assert.equal(session.isAlive(), false, '_context stays null on a launch failure');
});

test('SCR-17: _lease is never left set alongside a null _context after a launch failure', async () => {
    const { session } = makeLaunchFailureSession();

    await assert.rejects(() => session.ensureReady('sid'));

    // The specific inconsistency called out in the issue: lease truthy while
    // context is null (isAlive() false but `lease` truthy). After the fix,
    // both must agree: context is null AND lease is null.
    assert.equal(session.isAlive(), false);
    assert.equal(session.lease, null);
});

test('SCR-17: credential is leasable again after a launch failure (a fresh acquire gets a NEW lease)', async () => {
    const { session, calls } = makeLaunchFailureSession();
    await assert.rejects(() => session.ensureReady('sid'));
    assert.equal(calls.releases, 1);

    // Simulate the pool now handing out a fresh (or the same, now-released)
    // credential and a working launcher on the next attempt.
    const workingContext = {
        cookies: async () => [],
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
    };
    session._launch = async () => workingContext;
    session._apiClient.acquire = async () => ({
        credential: { id: 'acct-2' },
        release: async () => {},
    });

    await session.ensureReady('sid');
    assert.equal(session.isAlive(), true, 'a subsequent establish can succeed and reuse the pool');
});

test('SCR-17: legacy (no profile_key) launch failure also releases the lease, not just the per-account path', async () => {
    const calls = { releases: 0 };
    const lease = {
        credential: { id: 'acct-1' }, // no profile_key → legacy (non-per-account) branch
        release: async () => { calls.releases++; },
    };
    const apiClient = { isLocal: false, acquire: async () => lease };
    const launcher = async () => { throw new Error('proxy unreachable'); };
    const session = new LinkedInSession({
        apiClient,
        launcher,
        maxConcurrency: 1,
        jitter: () => Promise.resolve(),
        maxLeaseRetries: 1,
        leaseRetryDelayMs: 0,
    });

    await assert.rejects(() => session.ensureReady('sid'), /proxy unreachable/);
    assert.equal(calls.releases, 1);
    assert.equal(session.lease, null);
    assert.equal(session.isAlive(), false);
});

test('SCR-17: NEEDS_RELOGIN still results in authDead via withPage, NOT a plain lease.release()', async () => {
    const calls = { releases: 0, reportFailure: [] };
    const lease = {
        credential: { id: 'acct-1', profile_key: 'li-profile-1', proxy: null },
        release: async () => { calls.releases++; },
        reportFailure: async (msg, cooldownMinutes, opts) => {
            calls.reportFailure.push({ msg, cooldownMinutes, opts });
        },
    };
    const context = {
        cookies: async () => [], // no li_at → not authed → NEEDS_RELOGIN
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
    };
    const apiClient = { isLocal: false, acquire: async () => lease };
    const launcher = async () => context;
    const session = new LinkedInSession({
        apiClient,
        launcher,
        maxConcurrency: 1,
        jitter: () => Promise.resolve(),
        readCookies: (ctx) => ctx.cookies(),
        isAuthed: (cookies) => cookies.some((c) => c.name === 'li_at'),
        maxLeaseRetries: 1,
        leaseRetryDelayMs: 0,
    });

    await assert.rejects(
        () => session.withPage('sid', async () => 'x'),
        (err) => err instanceof AuthError && err.code === 'NEEDS_RELOGIN',
    );

    assert.equal(calls.releases, 0, 'NEEDS_RELOGIN must NOT call lease.release()');
    assert.equal(calls.reportFailure.length, 1, 'reportFailure must be called exactly once');
    assert.deepEqual(calls.reportFailure[0].opts, { authDead: true });

    // After withPage has fully handled the NEEDS_RELOGIN error (reported +
    // cleared), the lease/context invariant must hold: neither is left
    // dangling.
    assert.equal(session.lease, null, '_lease is cleared once the authDead report has landed');
    assert.equal(session.isAlive(), false);
});

test('SCR-17: ensureReady() alone (no withPage) on NEEDS_RELOGIN leaves _lease set for the caller to report — but _context stays null', async () => {
    // Direct callers of ensureReady() (bypassing withPage) are exercised
    // elsewhere (linkedin-session-warmprofile.test.js, linkedin-session-seed.
    // test.js) and only assert isAlive() === false. This test additionally
    // pins that #establish itself does not prematurely null the lease before
    // withPage gets a chance to report it — establish alone is not the place
    // that decides the credential's fate for this specific error code.
    const lease = {
        credential: { id: 'acct-1', profile_key: 'li-profile-1', proxy: null },
        release: async () => { throw new Error('release must not be called directly by #establish for NEEDS_RELOGIN'); },
        reportFailure: async () => {},
    };
    const context = {
        cookies: async () => [],
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
    };
    const apiClient = { isLocal: false, acquire: async () => lease };
    const launcher = async () => context;
    const session = new LinkedInSession({
        apiClient,
        launcher,
        maxConcurrency: 1,
        jitter: () => Promise.resolve(),
        readCookies: (ctx) => ctx.cookies(),
        isAuthed: (cookies) => cookies.some((c) => c.name === 'li_at'),
        maxLeaseRetries: 1,
        leaseRetryDelayMs: 0,
    });

    await assert.rejects(
        session.ensureReady('sid'),
        (e) => e instanceof AuthError && e.code === 'NEEDS_RELOGIN',
    );

    assert.equal(session.isAlive(), false, '_context torn down by #establish itself');
    assert.equal(session.lease, lease, '_lease stays set — withPage (not #establish) owns clearing it for NEEDS_RELOGIN');
});
