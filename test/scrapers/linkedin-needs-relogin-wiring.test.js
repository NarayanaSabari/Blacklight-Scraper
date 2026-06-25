// Task 6: NEEDS_RELOGIN from #establish (pre-fn) pauses the account via
// reportFailure({ authDead: true }) and does NOT trigger a re-login/rotate.
//
// Control-flow recap:
//   withPage() → #borrowWithRelogin() → ensureReady() → #establish()
//                                           ↑ throws NEEDS_RELOGIN here (before fn)
//   The throw propagates BACK through ensureReady → #borrowWithRelogin → withPage.
//   withPage must catch it, report auth_dead, then re-throw (no rotate, no retry).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../src/scrapers/linkedin-session.js';
import { AuthError } from '../../src/core/errors.js';

// Build a session that behaves like a remote warm-profile account that is NOT
// logged in: launcher returns a context whose cookies() contains no li_at, so
// #establish throws NEEDS_RELOGIN.  The lease has a reportFailure spy so we
// can assert exactly how it is called.
function makeNeedsReloginSession() {
    const calls = { launches: 0, reportFailure: [] };

    // Context: no li_at cookie → #establish detects "not authed"
    const context = {
        cookies: async () => [],
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
    };

    const launcher = async (o) => {
        calls.launches++;
        calls.launchedWith = o;
        return context;
    };

    const lease = {
        credential: { id: 'acct-1', profile_key: 'li-profile-1', proxy: null },
        release: async () => {},
        reportFailure: async (msg, cooldownMinutes, opts) => {
            calls.reportFailure.push({ msg, cooldownMinutes, opts });
        },
    };

    const apiClient = {
        isLocal: false, // REMOTE — pool mode
        acquire: async () => lease,
    };

    const session = new LinkedInSession({
        apiClient,
        launcher,
        maxConcurrency: 1,
        jitter: () => Promise.resolve(),
        // Enable single-flight re-login path (Task 2) so #borrowWithRelogin is used
        singleFlightRelogin: true,
        // readCookies + isAuthed inject the "not logged in" verdict
        readCookies: (ctx) => ctx.cookies(),
        isAuthed: (cookies) => cookies.some((c) => c.name === 'li_at'),
        maxLeaseRetries: 1,
        leaseRetryDelayMs: 0,
    });

    return { session, calls, lease };
}

test('NEEDS_RELOGIN: withPage rejects with NEEDS_RELOGIN error code', async () => {
    const { session } = makeNeedsReloginSession();

    await assert.rejects(
        () => session.withPage('sid', async () => 'x'),
        (err) => err instanceof AuthError && err.code === 'NEEDS_RELOGIN',
        'withPage must propagate the NEEDS_RELOGIN error',
    );
});

test('NEEDS_RELOGIN: reportFailure called exactly once with authDead: true', async () => {
    const { session, calls } = makeNeedsReloginSession();

    await assert.rejects(
        () => session.withPage('sid', async () => 'x'),
        (err) => err.code === 'NEEDS_RELOGIN',
    );

    assert.equal(calls.reportFailure.length, 1, 'reportFailure called exactly once');
    assert.deepEqual(
        calls.reportFailure[0].opts,
        { authDead: true },
        'reportFailure 3rd arg must be { authDead: true }',
    );
    assert.equal(
        calls.reportFailure[0].cooldownMinutes,
        0,
        'cooldownMinutes must be 0 (backend drives the cooldown)',
    );
});

test('NEEDS_RELOGIN: launcher invoked only ONCE — no rotate/retry', async () => {
    const { session, calls } = makeNeedsReloginSession();

    await assert.rejects(
        () => session.withPage('sid', async () => 'x'),
        (err) => err.code === 'NEEDS_RELOGIN',
    );

    assert.equal(calls.launches, 1, 'launcher must be called exactly once (no rotate storm)');
});
