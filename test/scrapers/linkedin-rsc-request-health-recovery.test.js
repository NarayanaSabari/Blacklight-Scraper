// Regression for the 2026-09 LinkedIn RSC false credential cooldown.
//
// A well-formed zero-result response is not enough to prove a credential ban.
// Request-version evidence may be current, refused, or unknown. Unknown must
// never be promoted into account-failure evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LinkedInRscSession } from '../../src/scrapers/linkedin-rsc/session.js';
import { CanaryTracker, runCanary, safeCanaryDiagnostics } from '../../src/scrapers/linkedin-rsc/canary.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { SearchQuotaTracker, DEFAULT_BASE_PAUSE_MS } from '../../src/scrapers/linkedin-rsc/search-quota.js';
import * as realTemplateHealth from '../../src/scrapers/linkedin-rsc/template-health.js';

const TEMPLATE = {
    url: 'https://example.invalid/rsc',
    headers: { 'x-li-application-version': '0.2.6815' },
    postData: '{}',
};

function lease() {
    const held = {
        credential: { id: 71, profile_key: 'fixture-account' },
        failures: [],
        successes: 0,
    };
    held.reportFailure = async (...args) => held.failures.push(args);
    held.reportSuccess = async () => { held.successes += 1; };
    return held;
}

function sessionFor(templateHealth, template = TEMPLATE) {
    return new LinkedInRscSession({
        apiClient: { isLocal: false },
        templateLoader: () => template,
        templateHealth,
        recaptureTemplate: async () => TEMPLATE,
        scheduler: { setInterval: () => null, clearInterval: () => {} },
    });
}

test('request health is explicit for current, refused, unknown, thrown, and missing capability evidence', async () => {
    const current = sessionFor({
        fetchLiveClientVersion: async () => '0.2.6815',
        assessTemplate: () => ({ stale: false, reason: 'version_current', live: '0.2.6815', captured: '0.2.6815', lag: 0 }),
    });
    const refused = sessionFor({
        fetchLiveClientVersion: async () => '0.2.7000',
        assessTemplate: () => ({ stale: true, reason: 'version_lag', live: '0.2.7000', captured: '0.2.6815', lag: 185 }),
    });
    const unknown = sessionFor({
        fetchLiveClientVersion: async () => null,
        assessTemplate: () => { throw new Error('must not assess unknown live version'); },
    });
    const thrown = sessionFor({
        fetchLiveClientVersion: async () => { throw new Error('response body must stay private'); },
        assessTemplate: () => ({ stale: false }),
    });
    const missing = sessionFor(null);
    const nonComparable = sessionFor({
        fetchLiveClientVersion: async () => '0.2.6815',
        assessTemplate: realTemplateHealth.assessTemplate,
    }, { ...TEMPLATE, headers: {} });

    assert.equal(await current.isRequestHealthy(), 'version_current');
    assert.equal(await refused.isRequestHealthy(), 'request_refused');
    assert.equal(await unknown.isRequestHealthy(), 'unknown');
    assert.equal(await thrown.isRequestHealthy(), 'unknown');
    assert.equal(await missing.isRequestHealthy(), 'unknown');
    assert.equal(await nonComparable.isRequestHealthy(), 'unknown',
        'a non-null but uncomparable version cannot prove the request is current');
});

test('unknown or refused evidence clears account strikes but keeps the corroboration clock', async () => {
    for (const uncertainState of ['unknown', 'request_refused']) {
        const held = lease();
        const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
        const probe = async (requestHealth) => {
            tracker.recordEmpty(held);
            return runCanary({
                tracker,
                lease: held,
                template: TEMPLATE,
                cookies: [],
                paginateImpl: async () => ({ posts: [] }),
                verifyRequestHealth: async () => requestHealth,
            });
        };

        assert.equal(await probe('version_current'), 'suspected');
        assert.equal(tracker.suspicion(held), 1);
        assert.equal(await probe(uncertainState), uncertainState === 'unknown' ? 'request_unknown' : 'request_refused');
        assert.equal(tracker.suspicion(held), 0, `${uncertainState} must clear account evidence`);
        assert.equal(await probe('version_current'), 'suspected',
            'one fresh current probe after uncertain evidence is only the first account strike');
        assert.equal(held.failures.length, 0);
        assert.equal(await probe('version_current'), 'shadow_banned');
        assert.equal(held.failures.length, 1, 'a fresh second current probe reaches only policy suspicion');
    }
});

test('unknown request health is paced, logged as a gate result, and never reports an account failure', async () => {
    const held = lease();
    const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
    const pacing = [];
    const pacer = {
        pace: async (passedLease) => { pacing.push(passedLease); },
    };
    let probeStartedAfterPacing = false;

    for (let i = 0; i < 2; i += 1) {
        tracker.recordEmpty(held);
        // eslint-disable-next-line no-await-in-loop
        const verdict = await runCanary({
            tracker,
            lease: held,
            template: TEMPLATE,
            cookies: [],
            pacer,
            paginateImpl: async () => {
                probeStartedAfterPacing = pacing.length === i + 1;
                return { posts: [] };
            },
            verifyRequestHealth: async () => 'unknown',
            diagnostics: {
                querySha256: 'safe-hash',
                rawQuery: 'must-not-be-logged',
                cookies: 'must-not-be-logged',
                body: 'must-not-be-logged',
            },
        });
        assert.equal(verdict, 'request_unknown');
    }

    assert.equal(probeStartedAfterPacing, true);
    assert.deepEqual(pacing, [held, held], 'the canary must use the held credential clock');
    assert.deepEqual(held.failures, [], 'unknown is not account-failure evidence');
    assert.deepEqual(
        safeCanaryDiagnostics({
            querySha256: 'a'.repeat(64), rawQuery: 'must-not-be-logged', cookies: 'secret', body: 'body',
        }),
        { sessionId: null, credentialId: null, querySha256: 'a'.repeat(64), datePosted: null, candidateScoped: false },
        'canary logs retain only safe correlation fields',
    );
});

test('a missing session request-health capability is unknown in the scraper path', async () => {
    const held = lease();
    const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
    const sessionWithoutCapability = {
        async withCookies(_sessionId, fn) { return fn([], held); },
    };

    for (let i = 0; i < 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('fixture search', 'US', null, {
            session: sessionWithoutCapability,
            template: TEMPLATE,
            highWater: { get: () => null, advance: () => {} },
            canaryTracker: tracker,
            quotaTracker: new SearchQuotaTracker({ threshold: 100 }),
            pacer: null,
            paginateImpl: async () => ({ posts: [], emptyConfirmed: true, pages: [] }),
            applyQuotaPauseImpl: () => true,
        });
    }

    assert.deepEqual(held.failures, []);
});

test('12 broad empties and two unknown probes pause the platform without a 240-minute credential report or quota reset', async () => {
    const held = lease();
    let clock = 0;
    const tracker = new CanaryTracker({
        threshold: 10,
        probeIntervalMs: 1_000,
        corroborationIntervalMs: 10,
        now: () => clock,
    });
    const quota = new SearchQuotaTracker({ threshold: 100 });
    const pauses = [];
    const paced = [];
    const session = {
        isRequestHealthy: async () => 'unknown',
        async withCookies(_sessionId, fn) {
            return fn([], held);
        },
    };

    for (let i = 0; i < 12; i += 1) {
        if (i === 10) clock += 11; // allow the corroborating second probe only
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('fixture search', 'US', null, {
            session,
            template: TEMPLATE,
            highWater: { get: () => null, advance: () => {} },
            canaryTracker: tracker,
            quotaTracker: quota,
            pacer: { pace: async (passedLease) => paced.push(passedLease) },
            paginateImpl: async () => ({ posts: [], emptyConfirmed: true, pages: [] }),
            applyQuotaPauseImpl: ({ pauseMs }) => { pauses.push(pauseMs); return true; },
        });
    }

    assert.deepEqual(held.failures, [], 'unknown request health must not cool the credential for 240 minutes');
    assert.deepEqual(pauses, [DEFAULT_BASE_PAUSE_MS], 'two unknown probes must apply one bounded base platform pause');
    assert.equal(quota.snapshot().consecutiveEmpty, 12, 'request-health uncertainty must not reset quota evidence');
    assert.equal(paced.length, 14, 'normal requests and both probes share the supplied lease pacer');
    assert.equal(held.successes, 10, 'uncertain probe scrapes skip explicit reportSuccess');
});
