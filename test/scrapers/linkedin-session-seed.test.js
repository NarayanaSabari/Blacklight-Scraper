import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../src/scrapers/linkedin-session.js';

const SEED_COOKIES = [{ name: 'li_at', value: 'SEED-AQEDAT', domain: '.linkedin.com', path: '/' }];

// Build a fake context whose stored cookie jar is configurable, recording any
// addCookies() calls so the seed decision is observable.
function fakeContext(initialJar = []) {
    const ctx = {
        _jar: initialJar.slice(),
        addCookiesCalls: [],
        cookies: async () => ctx._jar.slice(),
        addCookies: async (cks) => { ctx.addCookiesCalls.push(cks); ctx._jar.push(...cks); },
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
        browser: () => null,
    };
    return ctx;
}

// Records the launch options the session threads through, returns a fake ctx.
function harness({ credential, contextJar = [] } = {}) {
    const launchOpts = [];
    const ctx = fakeContext(contextJar);
    const apiClient = {
        acquire: async () => ({
            credential,
            reportSuccess: async () => {}, reportFailure: async () => {}, release: async () => {},
        }),
    };
    const launcher = async (opts) => { launchOpts.push(opts); return ctx; };
    return { apiClient, launcher, ctx, launchOpts };
}

test('SEED: per-account lease (cookies + profile_key) + unauthed context → addCookies + profileKey/proxy threaded', async () => {
    const credential = {
        id: 42, profile_key: 'acct-42', proxy: 'http://u:p@host:8080', cookies: SEED_COOKIES,
    };
    const h = harness({ credential, contextJar: [] }); // empty/unauthed context
    const s = new LinkedInSession({ apiClient: h.apiClient, launcher: h.launcher });
    await s.ensureReady('sess-seed');

    // profile_key + proxy threaded into the launch
    assert.equal(h.launchOpts.length, 1);
    assert.deepEqual(h.launchOpts[0], { profileKey: 'acct-42', proxy: 'http://u:p@host:8080' });
    // unauthed → seeded exactly once with the lease cookies
    assert.equal(h.ctx.addCookiesCalls.length, 1);
    assert.deepEqual(h.ctx.addCookiesCalls[0], SEED_COOKIES);
});

test('REUSE: per-account lease but context already has li_at → NO addCookies (age the context)', async () => {
    const credential = {
        id: 43, profile_key: 'acct-43', proxy: null, cookies: SEED_COOKIES,
    };
    const authedJar = [{ name: 'li_at', value: 'EXISTING-VALID', domain: '.linkedin.com', path: '/' }];
    const h = harness({ credential, contextJar: authedJar });
    const s = new LinkedInSession({ apiClient: h.apiClient, launcher: h.launcher });
    await s.ensureReady('sess-reuse');

    assert.deepEqual(h.launchOpts[0], { profileKey: 'acct-43', proxy: null });
    assert.equal(h.ctx.addCookiesCalls.length, 0, 'authed context must NOT be reseeded');
});

test('LEGACY: no profile_key → exact current behavior (fixed dir, no proxy, no addCookies)', async () => {
    // Current/local accounts: email+password only, no cookies, no profile_key.
    const credential = { id: 11, email: 'a@b.c', password: 'p' };
    const h = harness({ credential, contextJar: [] });
    const s = new LinkedInSession({ apiClient: h.apiClient, launcher: h.launcher });
    await s.ensureReady('sess-legacy');

    // launched with NO args (byte-identical legacy path) → undefined opts
    assert.equal(h.launchOpts.length, 1);
    assert.equal(h.launchOpts[0], undefined);
    assert.equal(h.ctx.addCookiesCalls.length, 0, 'legacy path never seeds cookies');
});

test('LEGACY: profile_key present but cookies absent → legacy path (no addCookies, no per-account launch)', async () => {
    const credential = { id: 12, profile_key: 'acct-12', proxy: 'http://p', cookies: null };
    const h = harness({ credential, contextJar: [] });
    const s = new LinkedInSession({ apiClient: h.apiClient, launcher: h.launcher });
    await s.ensureReady('sess-half-1');

    assert.equal(h.launchOpts[0], undefined, 'no cookies → must not activate per-account launch');
    assert.equal(h.ctx.addCookiesCalls.length, 0);
});

test('LEGACY: cookies present but profile_key absent → legacy path (no addCookies, no per-account launch)', async () => {
    const credential = { id: 13, profile_key: null, proxy: 'http://p', cookies: SEED_COOKIES };
    const h = harness({ credential, contextJar: [] });
    const s = new LinkedInSession({ apiClient: h.apiClient, launcher: h.launcher });
    await s.ensureReady('sess-half-2');

    assert.equal(h.launchOpts[0], undefined, 'no profile_key → must not activate per-account launch');
    assert.equal(h.ctx.addCookiesCalls.length, 0);
});
