import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLinkedinUrl, cookieToPlaywright, verifyLocal, verifyRemote }
    from '../../src/setup/verify.js';

test('classifyLinkedinUrl', () => {
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/feed/'), 'authed');
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/uas/login?x'), 'login');
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/checkpoint/lg/'), 'login');
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/authwall'), 'login');
    assert.equal(classifyLinkedinUrl('https://example.com/'), 'unknown');
});

test('cookieToPlaywright (mirrors production): sameSite no passthrough; expiry parsing', () => {
    const base = { name: 'a', value: 'b', domain: '.x' };

    // sameSite: lowercase variants map correctly
    assert.equal(cookieToPlaywright({ ...base, sameSite: 'no_restriction' }).sameSite, 'None');
    assert.equal(cookieToPlaywright({ ...base, sameSite: 'strict' }).sameSite, 'Strict');
    assert.equal(cookieToPlaywright({ ...base, sameSite: 'lax' }).sameSite, 'Lax');

    // sameSite: 'unspecified' and missing → 'Lax'
    assert.equal(cookieToPlaywright({ ...base, sameSite: 'unspecified' }).sameSite, 'Lax');
    assert.equal(cookieToPlaywright({ ...base }).sameSite, 'Lax');

    // sameSite: capitalized 'None'/'Strict'/'Lax' → 'Lax' (no passthrough — production bug fix)
    assert.equal(cookieToPlaywright({ ...base, sameSite: 'None' }).sameSite, 'Lax');
    assert.equal(cookieToPlaywright({ ...base, sameSite: 'Strict' }).sameSite, 'Lax');
    assert.equal(cookieToPlaywright({ ...base, sameSite: 'Lax' }).sameSite, 'Lax');

    // expires: fractional number → floored
    assert.equal(cookieToPlaywright({ ...base, expirationDate: 1794651453.8 }).expires, 1794651453);

    // expires: numeric string → floored
    assert.equal(cookieToPlaywright({ ...base, expirationDate: '1794651453' }).expires, 1794651453);

    // expires: empty string → expires key ABSENT
    assert.equal('expires' in cookieToPlaywright({ ...base, expirationDate: '' }), false);

    // expires: missing expirationDate → expires key ABSENT
    assert.equal('expires' in cookieToPlaywright({ ...base }), false);

    // expires: ISO-8601 string → Date.parse(raw) / 1000, floored (same as production)
    const isoStr = '2026-09-14T10:00:00.000Z';
    const expectedIso = Math.floor(Date.parse(isoStr) / 1000);
    assert.equal(cookieToPlaywright({ ...base, expirationDate: isoStr }).expires, expectedIso);
});

test('verifyLocal: authed page → ok; login page → bad; launch throw → warn', async () => {
    const okBrowser = { newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }) }), close: async () => {} };
    const r1 = await verifyLocal({ launch: async () => okBrowser, cookies: [{ name: 'li_at', value: 'x', domain: '.www.linkedin.com' }], headless: true });
    assert.equal(r1.status, 'ok');

    const loginBrowser = { newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/uas/login' }) }), close: async () => {} };
    const r2 = await verifyLocal({ launch: async () => loginBrowser, cookies: [{ name: 'li_at', value: 'x' }], headless: true });
    assert.equal(r2.status, 'bad');

    const r3 = await verifyLocal({ launch: async () => { throw new Error('no display'); }, cookies: [], headless: false });
    assert.equal(r3.status, 'warn');
});

test('verifyRemote: 200 → ok; 401 → bad; network throw → warn', async () => {
    const ok = await verifyRemote({ fetchFn: async () => ({ status: 200 }), blacklight: { apiUrl: 'https://b', apiKey: 'k' }, scraperCredentials: { apiUrl: 'https://c', apiKey: 'k' } });
    assert.equal(ok.status, 'ok');
    const bad = await verifyRemote({ fetchFn: async () => ({ status: 401 }), blacklight: { apiUrl: 'https://b', apiKey: 'k' }, scraperCredentials: { apiUrl: 'https://c', apiKey: 'k' } });
    assert.equal(bad.status, 'bad');
    const warn = await verifyRemote({ fetchFn: async () => { throw new Error('ECONN'); }, blacklight: { apiUrl: 'https://b', apiKey: 'k' }, scraperCredentials: { apiUrl: 'https://c', apiKey: 'k' } });
    assert.equal(warn.status, 'warn');
});
