// SCR-15: the Blacklight queue API and the credentials API live on the
// same host, so a burst of failures on one must not open the circuit for
// the other — and submit/complete must never be blocked by either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir, readFile } from 'fs/promises';
import path from 'path';
import { BlacklightApiClient } from '../../src/api/blacklight.js';
import { CredentialsClient } from '../../src/api/credentials.js';

function mockFetch(t, impl) {
    t.mock.method(globalThis, 'fetch', impl);
}

// These integration-level tests exercise the real retry/backoff path (the
// public API methods don't expose a `retries` override), so zero out the
// jitter to keep the suite fast without changing retry/backoff behavior
// under test — only how long each attempt sleeps between retries.
function disableBackoffJitter(t) {
    t.mock.method(Math, 'random', () => 0);
}

const alwaysFails = () => Promise.reject(new Error('simulated 500'));

test('5 consecutive credential-endpoint failures do NOT block a submit', async (t) => {
    disableBackoffJitter(t);
    const blacklight = new BlacklightApiClient('https://blacklight.example.com', 'key-1');
    const credentials = new CredentialsClient({ apiUrl: 'https://blacklight.example.com', apiKey: 'key-1' });

    // Hammer the credentials API with failures — same host as the queue
    // API, so pre-SCR-15 this would have opened the shared host circuit.
    mockFetch(t, alwaysFails);
    for (let i = 0; i < 5; i += 1) {
        await assert.rejects(() => credentials.acquire('linkedin', 'sess-1'));
    }

    // A submit against the SAME host must still go through.
    mockFetch(t, (url, opts) => {
        assert.match(String(url), /\/api\/scraper\/queue\/jobs$/);
        return Promise.resolve(new Response(JSON.stringify({ progress: '1/1' }), { status: 200 }));
    });

    const result = await blacklight.submitJobs('sess-1', 'linkedin', [{ title: 'Engineer' }], 'success');
    assert.deepEqual(result, { progress: '1/1' });
});

test('telemetry-labeled failures do not block queue traffic (checkActiveSession)', async (t) => {
    const blacklight = new BlacklightApiClient('https://blacklight.example.com', 'key-1');

    // Simulate a telemetry-class outage sharing the same client machinery
    // (no dedicated telemetry API client exists yet — push.js/loki-transport.js
    // use raw fetch, not requestWithRetry — but the isolation guarantee
    // must hold for any circuitKey other than 'queue').
    const { requestWithRetry } = await import('../../src/http/client.js');
    mockFetch(t, alwaysFails);
    for (let i = 0; i < 5; i += 1) {
        await assert.rejects(() => requestWithRetry(
            'https://blacklight.example.com/api/scraper/telemetry/metrics',
            { method: 'POST' },
            { circuitKey: 'telemetry', retries: 1 },
        ));
    }

    mockFetch(t, () => Promise.resolve(new Response(null, { status: 204 })));
    const session = await blacklight.checkActiveSession();
    assert.deepEqual(session, { _empty: true });
});

test('submitJobs and completeSession bypass the breaker entirely — 5 prior queue failures do not block them', async (t) => {
    disableBackoffJitter(t);
    const blacklight = new BlacklightApiClient('https://blacklight.example.com', 'key-1');

    // Open the 'queue' circuit via a non-exempt call (getNextRole).
    mockFetch(t, alwaysFails);
    for (let i = 0; i < 5; i += 1) {
        await assert.rejects(() => blacklight.getNextRole());
    }
    // Confirm the circuit really is open for ordinary queue calls.
    await assert.rejects(() => blacklight.checkActiveSession(), /Circuit breaker open/);

    // submitJobs / completeSession must still go through.
    mockFetch(t, () => Promise.resolve(new Response(JSON.stringify({ progress: '1/1' }), { status: 200 })));
    const submitResult = await blacklight.submitJobs('sess-2', 'indeed', [{ title: 'Dev' }], 'success');
    assert.deepEqual(submitResult, { progress: '1/1' });

    mockFetch(t, () => Promise.resolve(new Response(JSON.stringify({ duration_seconds: 5, jobs: {} }), { status: 200 })));
    const completeResult = await blacklight.completeSession('sess-2');
    assert.deepEqual(completeResult, { duration_seconds: 5, jobs: {} });
});

test('an undeliverable submit is spooled to disk with a scraper_alert, not silently dropped', async (t) => {
    disableBackoffJitter(t);
    const spoolDir = path.join('results', 'spool');
    await rm(spoolDir, { recursive: true, force: true });
    process.env.SPOOL_DIR = spoolDir;
    t.after(async () => {
        delete process.env.SPOOL_DIR;
        await rm(spoolDir, { recursive: true, force: true });
    });

    const blacklight = new BlacklightApiClient('https://blacklight.example.com', 'key-1');
    mockFetch(t, alwaysFails);

    await assert.rejects(() => blacklight.submitJobs('sess-spool', 'dice', [{ title: 'Analyst' }], 'success'));

    const files = await readdir(spoolDir);
    assert.equal(files.length, 1, 'exactly one spool file should be written');
    const record = JSON.parse(await readFile(path.join(spoolDir, files[0]), 'utf8'));
    assert.equal(record.sessionId, 'sess-spool');
    assert.equal(record.platform, 'dice');
    assert.equal(record.jobs.length, 1);
    assert.ok(record.deliveryError);
});
