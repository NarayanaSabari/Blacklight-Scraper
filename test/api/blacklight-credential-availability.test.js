// SCR-25: checkCredentialAvailability() used to bypass BlacklightApiClient's
// #request wrapper (hand-rolled fetch + response check), so its latency,
// status distribution, and failures never reached
// scraper_blacklight_api_requests_total — the one call most worth measuring,
// since its failure silently disables the local-cooldown filter (SCR-10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlacklightApiClient } from '../../src/api/blacklight.js';
import { NetworkError } from '../../src/core/errors.js';
import { getMetrics, resetMetricsForTest } from '../../src/metrics/registry.js';
import { resetConfigForTest } from '../../src/config/env.js';

function freshMetrics() {
    resetConfigForTest();
    resetMetricsForTest();
    return getMetrics();
}

function stubFetch(handler) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    return () => { globalThis.fetch = original; };
}

test('checkCredentialAvailability records a metric on scraper_blacklight_api_requests_total', async () => {
    const m = freshMetrics();
    const restore = stubFetch(async () => new Response(JSON.stringify({ indeed: 2 }), { status: 200 }));
    try {
        const client = new BlacklightApiClient('https://scr25-success.test', 'k');
        const availability = await client.checkCredentialAvailability();
        assert.deepEqual(availability, { indeed: 2 });
    } finally {
        restore();
    }
    const text = await m.snapshot();
    assert.match(
        text,
        /scraper_blacklight_api_requests_total\{[^}]*endpoint="GET \/api\/scraper-credentials\/queue\/availability"[^}]*\}\s+1\b/,
    );
});

test('checkCredentialAvailability on a non-ok response still records the metric and throws NetworkError with statusCode', async () => {
    const m = freshMetrics();
    // 404 is non-retryable (shouldRetryStatus only backs off on 408/429/5xx),
    // so this stays fast and still exercises the failure path.
    const restore = stubFetch(async () => new Response('not found', { status: 404, statusText: 'Not Found' }));
    try {
        const client = new BlacklightApiClient('https://scr25-failure.test', 'k');
        await assert.rejects(
            () => client.checkCredentialAvailability(),
            (err) => {
                assert.ok(err instanceof NetworkError);
                assert.equal(err.statusCode, 404);
                return true;
            },
        );
    } finally {
        restore();
    }
    const text = await m.snapshot();
    assert.match(
        text,
        /scraper_blacklight_api_requests_total\{[^}]*endpoint="GET \/api\/scraper-credentials\/queue\/availability"[^}]*\}\s+1\b/,
    );
});
