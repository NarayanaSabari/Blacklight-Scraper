import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { paginate } from '../../src/scrapers/linkedin-rsc/client.js';
import { CanaryTracker, runCanary } from '../../src/scrapers/linkedin-rsc/canary.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { querySha256 } from '../../src/scrapers/linkedin-rsc/observability.js';
import { LinkedInRscSession } from '../../src/scrapers/linkedin-rsc/session.js';
import { AuthError } from '../../src/core/errors.js';

const NO_RESULTS = fs.readFileSync(
    path.join(import.meta.dirname, '../fixtures/linkedin-rsc-no-results.txt'), 'utf8',
);
const RAW_QUERY = 'UNIQUE RAW QUERY: payroll data engineer';
const TEMPLATE = {
    url: 'https://private.example.invalid/pagination?secret=do-not-log',
    headers: { 'user-agent': 'UA' },
    postData: '{"private":"POSTDATA_DO_NOT_LOG"}',
};
const COOKIES = [
    { name: 'li_at', value: 'COOKIE_DO_NOT_LOG' },
    { name: 'JSESSIONID', value: 'COOKIE_2_DO_NOT_LOG' },
];

function fakeSession(lease) {
    return {
        isAlive: () => true,
        templateStatus: () => ({ stale: false, lag: 0, ageMs: 100, liveUnknown: false }),
        async withCookies(_sessionId, fn) { return fn(COOKIES, lease); },
    };
}

test('pagination emits response aggregates only for a confirmed-empty fixture', async () => {
    const details = [];
    const result = await paginate({
        template: TEMPLATE,
        cookies: COOKIES,
        keywords: RAW_QUERY,
        fetchImpl: async () => ({ status: 200, text: async () => NO_RESULTS }),
        delay: async () => {},
        onPage: (detail) => details.push(detail),
    });

    assert.equal(result.emptyConfirmed, true);
    assert.equal(result.stopReason, 'extracted_zero');
    assert.deepEqual(details, [{
        pageIndex: 1,
        httpStatus: 200,
        utf8Bytes: Buffer.byteLength(NO_RESULTS, 'utf8'),
        extractedCount: 0,
        addedCount: 0,
        confirmedEmptySignal: true,
    }]);
});

test('normal RSC runtime logs correlate safely and cap page detail', async (t) => {
    const lines = [];
    t.mock.method(console, 'log', (line) => lines.push(String(line)));
    t.mock.method(console, 'warn', (line) => lines.push(String(line)));

    const lease = {
        credential: { id: 123, profile_key: 'private-profile-do-not-log' },
        reportSuccess: async () => {},
    };
    await scrapeLinkedInRsc('private role do not log', 'US', 'session-99', {
        session: fakeSession(lease),
        template: TEMPLATE,
        candidateQuery: RAW_QUERY,
        canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
        quotaTracker: { recordEmpty: () => ({ tripped: false, pauseMs: 0, streak: 1 }), snapshot: () => ({ threshold: 25 }) },
        paginateImpl: async ({ onPage }) => {
            for (let page = 1; page <= 9; page += 1) {
                onPage({
                    pageIndex: page,
                    httpStatus: 200,
                    utf8Bytes: page * 100,
                    extractedCount: 1,
                    addedCount: 1,
                    confirmedEmptySignal: false,
                });
            }
            return {
                posts: [], emptyConfirmed: true, upToDate: false, pages: Array(9).fill({}),
                newestActivityId: null, stopReason: 'page_cap', budgetExhausted: false,
            };
        },
    });

    const output = lines.join('\n');
    assert.match(output, /"sessionId":"session-99"/);
    assert.match(output, /"credentialId":123/);
    assert.match(output, new RegExp(`"querySha256":"${querySha256(RAW_QUERY)}"`));
    assert.match(output, /"candidateScoped":true/);
    assert.match(output, /"stopReason":"page_cap"/);
    assert.match(output, /RSC page detail log cap reached/);
    assert.equal(lines.filter((line) => line.includes('RSC page response')).length, 8);

    for (const secret of [
        RAW_QUERY, 'private role do not log', 'private.example.invalid', 'POSTDATA_DO_NOT_LOG',
        'COOKIE_DO_NOT_LOG', 'private-profile-do-not-log',
    ]) {
        assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});

test('normal RSC quota trip logs a requested platform pause without changing the trigger', async (t) => {
    const lines = [];
    t.mock.method(console, 'error', (line) => lines.push(String(line)));
    const lease = { credential: { id: 44 }, reportSuccess: async () => {} };
    const pauseCalls = [];
    await scrapeLinkedInRsc('role', 'US', 'quota-session', {
        session: fakeSession(lease),
        template: TEMPLATE,
        candidateQuery: RAW_QUERY,
        canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
        quotaTracker: {
            recordEmpty: () => ({ tripped: true, pauseMs: 1_800_000, streak: 25 }),
            snapshot: () => ({ threshold: 25 }),
        },
        applyQuotaPauseImpl: (args) => { pauseCalls.push(args); return true; },
        paginateImpl: async () => ({
            posts: [], emptyConfirmed: true, upToDate: false, pages: [], newestActivityId: null,
            stopReason: 'extracted_zero', budgetExhausted: false,
        }),
    });

    assert.equal(pauseCalls.length, 1);
    const output = lines.join('\n');
    assert.match(output, /linkedin_search_quota/);
    assert.match(output, /"consecutiveEmpty":25/);
    assert.match(output, /"threshold":25/);
    assert.match(output, /"requestedPauseMs":1800000/);
    assert.match(output, /"markerWritten":true/);
    assert.doesNotMatch(output, new RegExp(RAW_QUERY));
});

test('normal RSC canary conviction logs a requested credential cooldown without raw control text', async (t) => {
    const lines = [];
    t.mock.method(console, 'error', (line) => lines.push(String(line)));
    t.mock.method(console, 'warn', (line) => lines.push(String(line)));
    const reports = [];
    const lease = {
        credential: { id: 45 },
        reportSuccess: async () => {},
        reportFailure: async (...args) => { reports.push(args); return { ok: true }; },
    };
    await scrapeLinkedInRsc('role', 'US', 'canary-session', {
        session: fakeSession(lease),
        template: TEMPLATE,
        candidateQuery: RAW_QUERY,
        canaryTracker: new CanaryTracker({ threshold: 1, probeIntervalMs: 0 }),
        quotaTracker: { recordEmpty: () => ({ tripped: false, pauseMs: 0, streak: 1 }), snapshot: () => ({ threshold: 25 }) },
        paginateImpl: async () => ({
            posts: [], emptyConfirmed: true, upToDate: false, pages: [], newestActivityId: null,
            stopReason: 'extracted_zero', budgetExhausted: false,
        }),
        runCanaryImpl: (args) => runCanary({ ...args, strikes: 1, cooldownMinutes: 240, rng: () => 0 }),
    });

    assert.equal(reports.length, 1);
    assert.equal(reports[0][1], 240);
    const output = lines.join('\n');
    assert.match(output, /linkedin_shadow_ban/);
    assert.match(output, /"requestedCooldownMinutes":240/);
    assert.match(output, /"backendAcknowledged":true/);
    assert.match(output, /"persistedCooldownConfirmed":false/);
    assert.doesNotMatch(output, new RegExp(`${RAW_QUERY}|hiring`));
});

test('auth failure logs an attempted report rather than treating an unacknowledged result as complete', async (t) => {
    const lines = [];
    t.mock.method(console, 'error', (line) => lines.push(String(line)));
    t.mock.method(console, 'warn', (line) => lines.push(String(line)));
    const lease = {
        credential: { id: 46, profile_key: 'p' },
        reportFailure: async () => ({ ok: false, reason: 'error' }),
        release: async () => {},
    };
    const cooldown = {
        defaultWriteFile: () => () => {}, defaultRename: () => () => {},
        defaultReadFile: () => () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
        cooldownMs: () => 1_800_000, cooldownPath: () => '/safe-marker', writeCooldownMarker: () => {},
    };
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => lease },
        cookieReader: async () => COOKIES,
        cooldown,
        metrics: null,
        templateHealth: null,
    });
    await assert.rejects(
        () => session.withCookies('auth-session', async () => {
            throw new AuthError('PRIVATE AUTH MESSAGE', { platform: 'linkedin', code: 'NEEDS_RELOGIN' });
        }),
        AuthError,
    );

    const output = lines.join('\n');
    assert.match(output, /"trigger":"auth_failure"/);
    assert.match(output, /"requestedAuthDead":true/);
    assert.match(output, /"reportAttempted":true/);
    assert.match(output, /"backendAcknowledged":false/);
    assert.match(output, /"persistedCooldownConfirmed":false/);
    assert.doesNotMatch(output, /PRIVATE AUTH MESSAGE/);
});
