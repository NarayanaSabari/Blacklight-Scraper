import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveLoginProfileDir, openLoginBrowser, captureSession, validateSession, closeLoginBrowser,
} from '../../src/core/linkedin-login-flow.js';
import { linkedInProfileDir, profileDirFor } from '../../src/core/linkedin-profile.js';

function fakePage({ finalUrl, gotoError } = {}) {
    return {
        _finalUrl: finalUrl ?? 'https://www.linkedin.com/feed/',
        goto: async () => { if (gotoError) throw gotoError; },
        url() { return this._finalUrl; },
    };
}

function fakeContext({ page, cookies, cookiesError, closeError } = {}) {
    const p = page ?? fakePage();
    const ctx = {
        closed: false,
        pages: () => [p],
        newPage: async () => p,
        cookies: async () => { if (cookiesError) throw cookiesError; return cookies ?? [{ name: 'li_at', value: 'x' }]; },
        close: async () => { if (closeError) throw closeError; ctx.closed = true; },
    };
    return ctx;
}

test('resolveLoginProfileDir: matches profileDirFor exactly, for both a key and no key', () => {
    assert.equal(resolveLoginProfileDir({}), profileDirFor(null));
    assert.equal(resolveLoginProfileDir({}), linkedInProfileDir());
    assert.equal(resolveLoginProfileDir({ profileKey: 'li-acct-1' }), profileDirFor('li-acct-1'));
    assert.notEqual(resolveLoginProfileDir({ profileKey: 'li-acct-1' }), linkedInProfileDir());
});

test('openLoginBrowser: no profileKey uses the legacy launcher with the base profile dir', async () => {
    let receivedOpts;
    const context = fakeContext();
    const legacyLauncher = async (opts) => { receivedOpts = opts; return context; };
    const { context: gotContext, page } = await openLoginBrowser({}, { legacyLauncher });
    assert.equal(gotContext, context);
    assert.ok(page);
    assert.equal(receivedOpts.userDataDir, linkedInProfileDir());
    assert.equal(receivedOpts.headless, false);
});

test('openLoginBrowser: a profileKey routes through the per-account profile launcher', async () => {
    let receivedArgs;
    const context = fakeContext();
    const profileLauncher = async (args) => { receivedArgs = args; return context; };
    const { context: gotContext } = await openLoginBrowser({ profileKey: 'li-acct-1', proxy: 'host:1:u:p' }, { profileLauncher });
    assert.equal(gotContext, context);
    assert.deepEqual(receivedArgs, { profileKey: 'li-acct-1', proxy: 'host:1:u:p' });
});

test('captureSession: returns cookies on success, never throws on failure', async () => {
    const ok = await captureSession({ context: fakeContext({ cookies: [{ name: 'li_at' }] }) });
    assert.deepEqual(ok, { cookies: [{ name: 'li_at' }], error: null });

    const failed = await captureSession({ context: fakeContext({ cookiesError: new Error('closed') }) });
    assert.deepEqual(failed, { cookies: [], error: 'closed' });
});

test('validateSession: landing on the feed is a pass', async () => {
    const verdict = await validateSession({ page: fakePage({ finalUrl: 'https://www.linkedin.com/feed/' }) });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, null);
});

test('validateSession: a redirect to /login is a fail with a clear reason', async () => {
    const verdict = await validateSession({ page: fakePage({ finalUrl: 'https://www.linkedin.com/login' }) });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'redirected_to_login');
});

test('validateSession: /checkpoint and /authwall also fail', async () => {
    assert.equal((await validateSession({ page: fakePage({ finalUrl: 'https://www.linkedin.com/checkpoint/challenge' }) })).ok, false);
    assert.equal((await validateSession({ page: fakePage({ finalUrl: 'https://www.linkedin.com/authwall?x=1' }) })).ok, false);
});

test('validateSession: a navigation failure is a fail, not a throw', async () => {
    const verdict = await validateSession({ page: fakePage({ gotoError: new Error('net::ERR_TIMED_OUT') }) });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'navigation_failed');
    assert.equal(verdict.error, 'net::ERR_TIMED_OUT');
});

test('closeLoginBrowser: closes when a context is present, no-ops on an empty handle', async () => {
    let closed = false;
    await closeLoginBrowser({ context: { close: async () => { closed = true; } } });
    assert.equal(closed, true);
    await assert.doesNotReject(closeLoginBrowser({}));
    await assert.doesNotReject(closeLoginBrowser());
});
