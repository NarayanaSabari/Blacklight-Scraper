import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRemote } from '../../src/setup/verify.js';

function fetchOk() {
    return async () => ({
        status: 200,
        headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
        json: async () => ({ ok: true }),
    });
}

test('verifyRemote: 200 + JSON + expected key → ok', async () => {
    const res = await verifyRemote({
        fetchFn: fetchOk(),
        blacklight: { apiUrl: 'https://b.example.com', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c.example.com', apiKey: 'K' },
    });
    assert.equal(res.status, 'ok');
});

test('verifyRemote: 401 → bad with explicit reason', async () => {
    let i = 0;
    const fetchFn = async () => ({
        status: i++ === 0 ? 200 : 401,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
    });
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'bad');
    assert.match(res.message, /rejected/i);
});

test('verifyRemote: 200 + text/html (captive portal) → bad', async () => {
    const fetchFn = async () => ({
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<html>Sign in to Wi-Fi</html>',
    });
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'bad');
    assert.match(res.message, /JSON|captive/i);
});

test('verifyRemote: 200 + JSON missing expected keys → bad', async () => {
    const fetchFn = async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ surprising: true }),
    });
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'bad');
    assert.match(res.message, /unexpected/i);
});

test('verifyRemote: network throw → warn (unchanged)', async () => {
    const fetchFn = async () => { throw new Error('ENOTFOUND'); };
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'warn');
});
