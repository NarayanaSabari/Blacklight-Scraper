import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAuthenticated, authSettleTimeoutMs } from '../../scrapers/linkedin.js';

const FEED = 'https://www.linkedin.com/feed/';
const LOGIN = 'https://www.linkedin.com/login';

test('authSettleTimeoutMs: default ~15s; env override; junk → default', () => {
    assert.equal(authSettleTimeoutMs({}), 15000);
    assert.equal(authSettleTimeoutMs({ LINKEDIN_AUTH_SETTLE_MS: '20000' }), 20000);
    assert.equal(authSettleTimeoutMs({ LINKEDIN_AUTH_SETTLE_MS: '0' }), 15000);
    assert.equal(authSettleTimeoutMs({ LINKEDIN_AUTH_SETTLE_MS: 'abc' }), 15000);
    assert.equal(authSettleTimeoutMs({ LINKEDIN_AUTH_SETTLE_MS: '' }), 15000);
});

test('waitForAuthenticated: returns true immediately when already on the feed (no waiting)', async () => {
    let sleeps = 0;
    const page = { url: () => FEED };
    const ok = await waitForAuthenticated(page, {
        timeoutMs: 15000, pollMs: 100, sleep: async () => { sleeps++; }, now: () => 0,
    });
    assert.equal(ok, true);
    assert.equal(sleeps, 0, 'a healthy session is recognized instantly — no added latency');
});

test('waitForAuthenticated: waits out the 5–10s sign-in redirect, returns true once it settles', async () => {
    // The page sits on /login for the first 3 polls, then LinkedIn hydrates the
    // cookie session and lands on /feed/ — the exact behavior that the old fixed
    // 3–5s check missed.
    let checks = 0;
    const page = { url: () => (++checks <= 3 ? LOGIN : FEED) };
    let sleeps = 0;
    const ok = await waitForAuthenticated(page, {
        timeoutMs: 15000, pollMs: 1000, sleep: async () => { sleeps++; }, now: () => sleeps * 1000,
    });
    assert.equal(ok, true, 'recognized login AFTER the redirect settled');
    assert.ok(sleeps >= 3, 'kept polling while the page was still redirecting');
});

test('waitForAuthenticated: returns false only after the FULL settle window elapses', async () => {
    const page = { url: () => LOGIN }; // never settles
    let elapsed = 0;
    const ok = await waitForAuthenticated(page, {
        timeoutMs: 15000, pollMs: 1000, sleep: async (ms) => { elapsed += ms; }, now: () => elapsed,
    });
    assert.equal(ok, false, 'declared not-authenticated only after waiting the window');
    assert.ok(elapsed >= 15000, 'waited the full settle window before giving up (not a premature 3–5s check)');
});
