import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestWithRetry } from '../../src/http/client.js';

// All requests in this file target the same host — the point of SCR-15
// is that the breaker no longer keys on hostname, so distinct
// circuitKeys on the same host must not interfere with each other.
const URL = 'https://blacklight.example.com/api/x';

function mockFetch(t, impl) {
    t.mock.method(globalThis, 'fetch', impl);
}

function alwaysFails() {
    return Promise.reject(new Error('boom'));
}

async function openCircuit(t, circuitKey, { failures = 5 } = {}) {
    mockFetch(t, alwaysFails);
    for (let i = 0; i < failures; i += 1) {
        await assert.rejects(() => requestWithRetry(URL, {}, { circuitKey, retries: 1 }));
    }
}

test('5 consecutive failures on one circuitKey do not open a different circuitKey on the same host', async (t) => {
    const key = `credentials-${Date.now()}`;
    await openCircuit(t, key);

    // The 'credentials' circuit is now open — same host, different key
    // ('queue') must still be able to get through.
    let calls = 0;
    mockFetch(t, () => { calls += 1; return Promise.resolve(new Response('ok', { status: 200 })); });

    const otherKey = `queue-${Date.now()}`;
    const response = await requestWithRetry(URL, {}, { circuitKey: otherKey, retries: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 1, 'request for the unrelated circuitKey must actually hit fetch, not be blocked');
});

test('the failing circuitKey itself is open and rejects fast (no fetch call)', async (t) => {
    const key = `credentials-${Date.now()}`;
    await openCircuit(t, key);

    let calls = 0;
    mockFetch(t, () => { calls += 1; return Promise.resolve(new Response('ok', { status: 200 })); });

    await assert.rejects(
        () => requestWithRetry(URL, {}, { circuitKey: key, retries: 1 }),
        /Circuit breaker open/,
    );
    assert.equal(calls, 0, 'an open circuit must short-circuit before calling fetch');
});

test('telemetry failures do not open the circuit for queue traffic', async (t) => {
    const telemetryKey = `telemetry-${Date.now()}`;
    await openCircuit(t, telemetryKey);

    let calls = 0;
    mockFetch(t, () => { calls += 1; return Promise.resolve(new Response('ok', { status: 200 })); });

    const queueKey = `queue-${Date.now()}`;
    const response = await requestWithRetry(URL, {}, { circuitKey: queueKey, retries: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
});

test('config.bypassCircuit skips the breaker even when that same key is open', async (t) => {
    const key = `queue-bypass-${Date.now()}`;
    await openCircuit(t, key);

    // Without bypass, this key is open and must reject fast.
    await assert.rejects(() => requestWithRetry(URL, {}, { circuitKey: key, retries: 1 }));

    // With bypass, the same key's open circuit must not block the call.
    let calls = 0;
    mockFetch(t, () => { calls += 1; return Promise.resolve(new Response('ok', { status: 200 })); });
    const response = await requestWithRetry(URL, {}, { circuitKey: key, retries: 1, bypassCircuit: true });
    assert.equal(response.status, 200);
    assert.equal(calls, 1, 'bypassCircuit must still perform the fetch, ignoring the open circuit');
});

test('bypassCircuit calls never contribute failures to their own circuitKey', async (t) => {
    const key = `submit-${Date.now()}`;
    mockFetch(t, alwaysFails);

    for (let i = 0; i < 10; i += 1) {
        await assert.rejects(
            () => requestWithRetry(URL, {}, { circuitKey: key, retries: 1, bypassCircuit: true }),
        );
    }

    // Even after 10 failures, a non-bypass call under the same key must
    // still be allowed through (the breaker never opened for this key).
    let calls = 0;
    mockFetch(t, () => { calls += 1; return Promise.resolve(new Response('ok', { status: 200 })); });
    const response = await requestWithRetry(URL, {}, { circuitKey: key, retries: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
});

test('omitting circuitKey falls back to hostname-keyed behaviour (backward compatible)', async (t) => {
    mockFetch(t, () => Promise.resolve(new Response('ok', { status: 200 })));
    const response = await requestWithRetry(URL, {}, { retries: 1 });
    assert.equal(response.status, 200);
});
