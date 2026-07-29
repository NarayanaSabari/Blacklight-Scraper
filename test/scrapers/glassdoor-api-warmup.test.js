import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeGlassdoorViaApi, hasSessionCookie } from '../../scrapers/glassdoor-api.js';

// Glassdoor's /graph endpoint is Cloudflare-fronted and rejects a cold POST with
// HTTP 403 no matter how valid the CSRF token is. Verified 2026-07-28 against
// live Glassdoor: a warm-up GET that clears Cloudflare returns gdsid/gdId and
// the POST then returns 200 with 30 listings; a warm-up that gets the Cloudflare
// challenge page returns __cf_bm alone and the POST is always 403. These guard
// the warm-up, the cookie check that tells those two apart, and the fail-fast
// that stops us spending a request on a POST we know is doomed.

const LISTING = {
    jobview: { header: { jobTitleText: 'Java Developer', employerNameFromSearch: 'Acme', locationName: 'Austin, TX', jobLink: '/job/1', ageInDays: 1 } },
};
const GOOD_COOKIES = ['gdsid=abc; Path=/', 'gdId=xyz; Path=/', '__cf_bm=q; Path=/'];
const CHALLENGE_COOKIES = ['__cf_bm=q; Path=/'];

function fakeSessionClass(calls, { warmCookies = GOOD_COOKIES, warmStatus = 200, graphStatus = 200, warmThrows = false } = {}) {
    return class FakeSession {
        async get(url) {
            calls.push({ method: 'GET', url });
            if (warmThrows) throw new Error('warmup transport boom');
            return { status: warmStatus, headers: { 'set-cookie': warmCookies }, text: async () => '<html/>' };
        }
        async post(url) {
            calls.push({ method: 'POST', url });
            return {
                status: graphStatus,
                text: async () => JSON.stringify([{ data: { jobListings: { jobListings: [LISTING], paginationCursors: [] } } }]),
            };
        }
        async close() {}
    };
}

function deps(calls, opts, blocked = []) {
    return {
        Session: fakeSessionClass(calls, opts),
        // Stubbed so these stay offline-runnable: the real initTLS() fetches the
        // tls-client binary version from GitHub.
        ensureTLS: async () => {},
        getProxyPool: () => ({
            acquire: () => null,
            reportBlocked: (p) => blocked.push(p),
            reportOk: () => {},
        }),
        // Stubbed so these stay offline-runnable: the real enrichDescriptions()
        // launches a browser and fetches each listing's live page.
        enrichDescriptions: async () => new Map(),
    };
}

test('hasSessionCookie: only true for Glassdoor session cookies', () => {
    assert.equal(hasSessionCookie({ headers: { 'set-cookie': GOOD_COOKIES } }), true);
    assert.equal(hasSessionCookie({ headers: { 'set-cookie': CHALLENGE_COOKIES } }), false);
    assert.equal(hasSessionCookie({ headers: { 'set-cookie': 'gdsid=one; Path=/' } }), true);
    assert.equal(hasSessionCookie({ headers: {} }), false);
    assert.equal(hasSessionCookie(null), false);
});

test('warms the session with a GET before POSTing /graph', async () => {
    const calls = [];
    const res = await scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps(calls));
    const firstGet = calls.findIndex((c) => c.method === 'GET');
    const firstPost = calls.findIndex((c) => c.method === 'POST');
    assert.notEqual(firstGet, -1, 'expected a warm-up GET before hitting /graph');
    assert.ok(firstGet < firstPost, 'warm-up GET must precede the first /graph POST');
    assert.match(calls[firstPost].url, /\/graph$/);
    assert.equal(res.jobs.length, 1);
});

test('a challenged warm-up fails fast without spending a /graph POST', async () => {
    const calls = [];
    const blocked = [];
    await assert.rejects(
        () => scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps(calls, { warmCookies: CHALLENGE_COOKIES, warmStatus: 403 }, blocked)),
        /warm-up challenged/,
    );
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'must not POST without session cookies');
    assert.ok(calls.filter((c) => c.method === 'GET').length > 1, 'should retry the warm-up');
    assert.ok(blocked.includes('glassdoor'), 'should cool the challenged IP so the next attempt rotates');
});

test('a warm-up transport error is retried, then reported as blocked', async () => {
    const calls = [];
    await assert.rejects(
        () => scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps(calls, { warmThrows: true })),
        /warm-up challenged/,
    );
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.ok(calls.filter((c) => c.method === 'GET').length > 1);
});

test('still surfaces a blocked /graph POST as an error', async () => {
    const calls = [];
    await assert.rejects(
        () => scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps(calls, { graphStatus: 403 })),
        /HTTP 403/,
    );
});
