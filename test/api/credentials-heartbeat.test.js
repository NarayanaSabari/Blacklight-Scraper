// SCR-4/SCR-22: CredentialsClient.heartbeat() keeps a long-lived lease alive
// by pinging POST /queue/<id>/heartbeat with the lease_token (falling back
// to session_id). Hermetic — mocks globalThis.fetch, no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialsClient } from '../../src/api/credentials.js';

function mockFetch(t, impl) {
    t.mock.method(globalThis, 'fetch', impl);
}

function jsonResponse(body, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

async function acquireLease(t, client, { leaseTokenFromServer = 'lt-abc123' } = {}) {
    mockFetch(t, () => jsonResponse({
        id: 42, platform: 'linkedin', name: 'Acct 1', email: 'a@b.c', password: 'p',
        lease_token: leaseTokenFromServer,
    }));
    return client.acquire('linkedin', 'sess-1');
}

test('heartbeat posts to the right endpoint with lease_token + session_id', async (t) => {
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    const lease = await acquireLease(t, client);
    assert.equal(lease.leaseToken, 'lt-abc123');

    let capturedUrl = null;
    let capturedBody = null;
    mockFetch(t, (url, opts) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(opts.body);
        return jsonResponse({ status: 'ok', credential_id: 42 });
    });

    const result = await lease.heartbeat();
    assert.equal(result.ok, true);
    assert.equal(capturedUrl, 'https://blacklight.example.com/api/scraper-credentials/queue/42/heartbeat');
    assert.deepEqual(capturedBody, { lease_token: 'lt-abc123', session_id: 'sess-1' });
});

test('non-terminal success records the role without forgetting the lease', async (t) => {
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    const lease = await acquireLease(t, client);
    let body;
    mockFetch(t, (_url, opts) => {
        body = JSON.parse(opts.body);
        return jsonResponse({ status: 'ok', credential_id: 42 });
    });

    await lease.reportSuccess('role complete', { release: false });

    assert.equal(body.terminal, false);
    assert.equal(body.lease_token, 'lt-abc123');
    assert.equal(client._hasActiveLease(lease.leaseKey), true);
});

test('non-terminal success on 409 marks the lease superseded', async (t) => {
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    const lease = await acquireLease(t, client);
    mockFetch(t, () => Promise.resolve(new Response(
        JSON.stringify({ error: 'superseded' }), { status: 409 },
    )));

    const result = await lease.reportSuccess('role complete', { release: false });

    assert.deepEqual(result, { ok: false, reason: 'superseded' });
    assert.equal(lease.lost, true);
    assert.equal(client._hasActiveLease(lease.leaseKey), false);
});

test('terminal failure exposes that the lease was released', async (t) => {
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    const lease = await acquireLease(t, client);
    mockFetch(t, () => jsonResponse({ status: 'ok', credential_id: 42 }));

    const result = await lease.reportFailure('auth dead', 0, { authDead: true });

    assert.equal(result.ok, true);
    assert.equal(lease.released, true);
    assert.equal(client._hasActiveLease(lease.leaseKey), false);
});

test('heartbeat on 409 drops the lease locally and reports superseded', async (t) => {
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    const lease = await acquireLease(t, client);

    mockFetch(t, () => Promise.resolve(new Response(
        JSON.stringify({ error: 'superseded', message: 'gone' }), { status: 409 },
    )));

    const result = await lease.heartbeat();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'superseded');

    // The lease must be forgotten — a subsequent action on the same key
    // finds nothing to act on rather than silently retrying a dead lease.
    assert.equal(client._hasActiveLease(lease.leaseKey), false);
});

test('heartbeat on a non-409 network error is best-effort — lease is kept', async (t) => {
    t.mock.method(Math, 'random', () => 0); // zero out retry backoff jitter
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    const lease = await acquireLease(t, client);

    mockFetch(t, () => Promise.reject(new Error('ECONNRESET')));

    const result = await lease.heartbeat();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
    assert.equal(client._hasActiveLease(lease.leaseKey), true);
});

test('heartbeat with no active lease reports no_lease and makes no HTTP call', async (t) => {
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    let called = false;
    mockFetch(t, () => { called = true; return jsonResponse({}); });

    const result = await client.heartbeat('linkedin:9999:1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_lease');
    assert.equal(called, false);
});

test('heartbeat on a local (credentials.json) lease is a no-op ok:true, no HTTP', async (t) => {
    const client = new CredentialsClient({ apiUrl: null, apiKey: null });
    let called = false;
    mockFetch(t, () => { called = true; return jsonResponse({}); });

    const lease = client._issueLeaseForTest('linkedin', 'local-linkedin', { id: 'local-linkedin' }, 'sess-1');
    const result = await lease.heartbeat();
    assert.equal(result.ok, true);
    assert.equal(result.local, true);
    assert.equal(called, false);
});

test('acquire with no lease_token in the response leaves leaseToken null (legacy server)', async (t) => {
    const client = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });
    mockFetch(t, () => jsonResponse({ id: 7, platform: 'linkedin', email: 'a@b.c', password: 'p' }));
    const lease = await client.acquire('linkedin', 'sess-1');
    assert.equal(lease.leaseToken, null);
});
