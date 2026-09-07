import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paginate, fetchPage } from '../../src/scrapers/linkedin-rsc/client.js';
import { diagnoseSearch } from '../../src/scrapers/linkedin-rsc/search-diagnostic.js';
import { SearchQuotaTracker } from '../../src/scrapers/linkedin-rsc/search-quota.js';
import { ScrapeArchive } from '../../src/scrapers/linkedin-rsc/archive.js';
import { AuthError } from '../../src/core/errors.js';

const secret = 'private-session-do-not-retain';
const cookies = [{ name: 'li_at', value: secret }, { name: 'JSESSIONID', value: '"ajax:private-csrf"' }];
const emptyBody = '0:["$","div",null,{"modelStates":[{"key":{"key":{"value":{"id":"SearchResultsSearchHasNoresultsBindingKey"}}},"value":{"booleanValue":true}}]}]\n';

async function harness(t, handler) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-evidence-'));
    t.after(async () => { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
    const template = { url: `http://127.0.0.1:${server.address().port}/search/results/content/?private=${secret}`,
        headers: {}, postData: '{}' };
    const tracker = new SearchQuotaTracker({ startupProbe: true });
    const reports = [];
    const options = { tracker, template, cookies, paginateImpl: paginate, archive: new ScrapeArchive({ directory }),
        session: { verifySearchSession: async () => true, isRequestHealthy: async () => true },
        lease: { credential: { id: 12 }, reportFailure: async (...args) => reports.push(args) },
        sessionId: 'diagnostic-test', trigger: 'startup' };
    return { options, reports, template, read: async () => {
        const files = await readdir(directory);
        assert.equal(files.length, 1);
        const raw = await readFile(path.join(directory, files[0]), 'utf8');
        for (const value of [secret, 'ajax:private-csrf', 'Set-Cookie', 'private-response-header', 'private-cause']) {
            assert.equal(raw.includes(value), false, `archive leaked ${value}`);
        }
        return JSON.parse(raw);
    } };
}

// These catch evidence dropped by fetchPage/paginate/error handling or by archive serialization.
for (const fixture of [
    { label: 'confirmed empty', status: 200, body: emptyBody, outcome: 'empty', confirmed: true, auth: true },
    { label: 'unknown response', status: 200, body: `<html>${secret} café</html>`, outcome: 'response_unknown', confirmed: false, auth: false },
    { label: 'rate limit', status: 429, body: secret, outcome: 'rate_limited', confirmed: false, auth: false },
    { label: 'auth rejection', status: 403, body: secret, outcome: 'auth_failed', confirmed: false, auth: false },
]) {
    test(`actual ${fixture.label} HTTP response evidence survives into its archive`, async (t) => {
        const h = await harness(t, (_req, res) => {
            res.writeHead(fixture.status, { 'Content-Type': 'Text/HTML; charset=utf-8; private=' + secret,
                'Set-Cookie': secret, 'X-Private': 'private-response-header' });
            res.end(fixture.body);
        });
        if (fixture.status === 403) await assert.rejects(diagnoseSearch(h.options), AuthError);
        else await diagnoseSearch(h.options);
        const record = await h.read();
        assert.equal(record.outcome, `diagnostic_${fixture.outcome}`);
        assert.equal(record.diagnostic.searchVerified, false);
        assert.equal(record.diagnostic.authVerified, fixture.auth);
        assert.equal(record.diagnostic.templateFresh, fixture.auth ? true : null);
        assert.equal(record.diagnostic.templateCheck, 'freshness_only');
        const response = record.pages[0]?.response;
        assert.equal(response?.status, fixture.status);
        assert.equal(response.contentType, 'text/html');
        assert.equal(response.redirected, false);
        assert.equal(response.destination, 'search');
        assert.deepEqual(record.diagnostic.responses, [response]);
        if (fixture.status === 200) {
            assert.equal(response.bodyBytes, Buffer.byteLength(fixture.body));
            assert.equal(response.bodySha256, createHash('sha256').update(fixture.body).digest('hex'));
            assert.equal(response.noResultsSignal, fixture.confirmed);
        } else {
            assert.equal(response.bodyBytes, null, 'rejected bodies are not read');
            assert.equal(response.bodySha256, null);
        }
        assert.equal(h.reports.length, fixture.status === 429 ? 1 : 0);
    });
}

test('redirect destination is categorized without retaining its query or echoed response', async (t) => {
    const h = await harness(t, (req, res) => {
        if (req.url.startsWith('/search/')) {
            res.writeHead(302, { Location: `/checkpoint/challenge?token=${secret}` }); res.end();
        } else {
            res.writeHead(200, { 'Content-Type': `application/${secret}` }); res.end(secret);
        }
    });
    await diagnoseSearch(h.options);
    const record = await h.read();
    assert.equal(record.diagnostic.responses[0].redirected, true);
    assert.equal(record.diagnostic.responses[0].destination, 'checkpoint');
    assert.equal(record.diagnostic.responses[0].contentType, 'other');
});

test('an observed error retains metadata without copying error messages or arbitrary response fields', async (t) => {
    const h = await harness(t, (_req, res) => { res.writeHead(429); res.end(secret); });
    let observedError;
    try { await paginate({ template: h.template, cookies, keywords: 'original private query', maxPages: 1 }); }
    catch (error) { observedError = error; }
    assert.ok(observedError);
    observedError.message = 'private-cause';
    if (observedError.pages?.[0]?.response) observedError.pages[0].response.headers = { cookie: secret };
    await diagnoseSearch({ ...h.options, observedError });
    const record = await h.read();
    assert.equal(record.diagnostic.responses[0].status, 429);
    assert.equal(record.keywords, null);
});

test('a rejected response with an endless body is archived without waiting for its body', { timeout: 1000 }, async (t) => {
    const h = await harness(t, (_req, res) => { res.writeHead(403); res.write(secret); });
    await assert.rejects(fetchPage({ template: h.template, cookies, params: { keywords: 'hiring' }, timeoutMs: 100 }), AuthError);
    await assert.rejects(diagnoseSearch(h.options), AuthError);
    assert.equal((await h.read()).diagnostic.responses[0].status, 403);
});

test('successful search verifies serving and preserves extracted posts', async (t) => {
    const card = ['$', 'div', null, { componentkey: 'expandedHASHFeedType_FLAGSHIP_SEARCH', children: [
        'https://www.linkedin.com/posts/test_hiring-share-7487914656553025536-AbCd',
        ['$', 'span', 'text-attr-0', { children: [['$', 'span', '0', { children: [null, 'Hiring engineer for remote work'] }]] }],
    ] }];
    const h = await harness(t, (_req, res) => { res.end(`0:${JSON.stringify(card)}\n`); });
    await diagnoseSearch(h.options);
    const record = await h.read();
    assert.equal(record.diagnostic.searchVerified, true);
    assert.equal(record.diagnostic.posts, 1);
    assert.equal(record.outcome, 'diagnostic_healthy');
    assert.equal(record.posts.length, 1);
});


test('a stalled successful response keeps status evidence when the body deadline expires', async (t) => {
    const h = await harness(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write(secret); });
    await diagnoseSearch({ ...h.options, paginateImpl: (args) => paginate({ ...args, timeBudgetMs: 100 }) });
    const record = await h.read();
    assert.equal(record.outcome, 'diagnostic_network_unknown');
    assert.equal(record.diagnostic.responses[0].status, 200);
    assert.equal(record.diagnostic.responses[0].bodyBytes, null);
    assert.equal(record.diagnostic.responses[0].bodySha256, null);
    assert.equal(h.reports.length, 0);
});

test('observed long walks retain a bounded tail including the rejected response', async (t) => {
    let requests = 0;
    const h = await harness(t, (_req, res) => {
        requests++;
        if (requests === 12) { res.writeHead(429); res.end(secret); return; }
        const card = ['$', 'div', null, { componentkey: 'expandedHASHFeedType_FLAGSHIP_SEARCH', children: [
            `https://www.linkedin.com/posts/test_hiring-share-${7487914656553025500n + BigInt(requests)}-AbCd`,
            ['$', 'span', 'text-attr-0', { children: [['$', 'span', '0', { children: [null, 'Hiring engineer for remote work'] }]] }],
        ] }];
        res.end(`0:${JSON.stringify(card)}\n`);
    });
    let observedError;
    try {
        await paginate({ template: h.template, cookies, keywords: 'private original query', maxPages: 12,
            count: 1, delay: async () => {} });
    } catch (error) { observedError = error; }
    assert.equal(requests, 12);
    await diagnoseSearch({ ...h.options, observedError });
    const record = await h.read();
    assert.equal(record.pages.length, 10);
    assert.equal(record.pages[0].page, 3);
    assert.equal(record.pages.at(-1).page, 12);
    assert.equal(record.diagnostic.responses.at(-1).status, 429);
});
