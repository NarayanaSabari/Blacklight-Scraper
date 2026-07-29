// Browserless HTTP client for LinkedIn's content-search pagination endpoint.
//
//   POST /flagship-web/rsc-action/actions/pagination
//        ?sduiid=com.linkedin.sdui.search.contentSearchResults
//
// The request body is a captured template with the search parameters swapped in.
// Auth is cookie-based: `li_at` plus `JSESSIONID` echoed as the csrf-token
// header. Without both, the endpoint answers 403 "CSRF validation failed."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPaginationBody,
    buildHeaders,
    fetchPage,
    paginate,
    MAX_COUNT_PER_REQUEST,
} from '../../src/scrapers/linkedin-rsc/client.js';
import { AuthError, BlockedError, NetworkError } from '../../src/core/errors.js';

const TEMPLATE = {
    url: 'https://www.linkedin.com/flagship-web/rsc-action/actions/pagination'
        + '?sduiid=com.linkedin.sdui.search.contentSearchResults',
    headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh)',
        'x-li-application-version': '0.2.6510',
        'x-li-track': '{"clientVersion":"0.2.6510"}',
        'x-li-page-instance': 'urn:li:page:d_flagship3_search_srp_content;abc==',
    },
    postData: JSON.stringify({
        pagerId: 'com.linkedin.sdui.search.contentSearchResults',
        clientArguments: {
            payload: {
                startIndex: 3, count: 3, keywords: 'old query', datePosted: ['past-week'],
                sortBy: [], contentType: [], searchId: 'seed-search-id',
            },
            screenId: 'com.linkedin.sdui.flagshipnav.search.SearchResultsContent',
        },
        paginationRequest: {
            pagerId: 'com.linkedin.sdui.search.contentSearchResults',
            requestedArguments: {
                payload: {
                    startIndex: 3, count: 3, keywords: 'old query', datePosted: ['past-week'],
                },
            },
        },
    }),
};

const COOKIES = [
    { name: 'li_at', value: 'AQEDAT-session-token', domain: '.www.linkedin.com' },
    { name: 'JSESSIONID', value: '"ajax:8695764573883137377"', domain: '.www.linkedin.com' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com' },
];

// --- buildPaginationBody ----------------------------------------------------

test('buildPaginationBody: applies search params to BOTH payload sites', () => {
    // The endpoint reads clientArguments.payload, but paginationRequest carries
    // its own copy. Updating only one silently returns the template's query.
    const body = JSON.parse(buildPaginationBody(TEMPLATE, {
        keywords: '"Data Engineer" AND (c2c OR W2)',
        datePosted: 'past-24h',
        startIndex: 50,
        count: 10,
    }));
    for (const payload of [
        body.clientArguments.payload,
        body.paginationRequest.requestedArguments.payload,
    ]) {
        assert.equal(payload.keywords, '"Data Engineer" AND (c2c OR W2)');
        assert.deepEqual(payload.datePosted, ['past-24h']);
        assert.equal(payload.startIndex, 50);
        assert.equal(payload.count, 10);
    }
});

test('buildPaginationBody: preserves unrelated template fields', () => {
    const body = JSON.parse(buildPaginationBody(TEMPLATE, { keywords: 'x', count: 5 }));
    assert.equal(body.pagerId, 'com.linkedin.sdui.search.contentSearchResults');
    assert.equal(
        body.clientArguments.screenId,
        'com.linkedin.sdui.flagshipnav.search.SearchResultsContent',
    );
    // searchId is a tracking correlation id, not a token — carried through as-is.
    assert.equal(body.clientArguments.payload.searchId, 'seed-search-id');
});

test('buildPaginationBody: caps count at the server limit', () => {
    // Asking for more than 50 makes LinkedIn answer with its no-results flag and
    // zero posts, so a larger request is silently useless.
    assert.equal(MAX_COUNT_PER_REQUEST, 50);
    const body = JSON.parse(buildPaginationBody(TEMPLATE, { keywords: 'x', count: 100 }));
    assert.equal(body.clientArguments.payload.count, 50);
});

// --- buildHeaders -----------------------------------------------------------

test('buildHeaders: echoes JSESSIONID as csrf-token with quotes stripped', () => {
    const headers = buildHeaders(TEMPLATE, COOKIES, { keywords: 'data engineer' });
    assert.equal(headers['csrf-token'], 'ajax:8695764573883137377');
});

test('buildHeaders: sends the linkedin cookie jar', () => {
    const headers = buildHeaders(TEMPLATE, COOKIES, { keywords: 'x' });
    assert.match(headers.cookie, /li_at=AQEDAT-session-token/);
    assert.match(headers.cookie, /JSESSIONID=/);
});

test('buildHeaders: carries the client version headers from the template', () => {
    const headers = buildHeaders(TEMPLATE, COOKIES, { keywords: 'x' });
    assert.equal(headers['x-li-application-version'], '0.2.6510');
    assert.equal(headers['x-li-rsc-stream'], 'true');
    assert.equal(headers['user-agent'], 'Mozilla/5.0 (Macintosh)');
});

test('buildHeaders: throws when the jar has no session cookies', () => {
    assert.throws(
        () => buildHeaders(TEMPLATE, [{ name: 'lang', value: 'en' }], { keywords: 'x' }),
        AuthError,
    );
});

// --- fetchPage --------------------------------------------------------------

const okResponse = (body) => ({
    status: 200,
    headers: { get: () => null },
    text: async () => body,
});

test('fetchPage: returns the raw flight body on success', async () => {
    const fetchImpl = async () => okResponse('1:{"ok":true}\n');
    const body = await fetchPage({ template: TEMPLATE, cookies: COOKIES, params: { keywords: 'x' }, fetchImpl });
    assert.equal(body, '1:{"ok":true}\n');
});

test('fetchPage: 403 becomes AuthError so the credential is cooled, not the platform', async () => {
    const fetchImpl = async () => ({
        status: 403, headers: { get: () => null }, text: async () => 'CSRF validation failed.',
    });
    await assert.rejects(
        () => fetchPage({ template: TEMPLATE, cookies: COOKIES, params: { keywords: 'x' }, fetchImpl }),
        AuthError,
    );
});

test('fetchPage: 429 becomes BlockedError', async () => {
    const fetchImpl = async () => ({
        status: 429, headers: { get: () => null }, text: async () => 'rate limited',
    });
    await assert.rejects(
        () => fetchPage({ template: TEMPLATE, cookies: COOKIES, params: { keywords: 'x' }, fetchImpl }),
        BlockedError,
    );
});

test('fetchPage: other non-2xx becomes NetworkError carrying the status', async () => {
    const fetchImpl = async () => ({
        status: 503, headers: { get: () => null }, text: async () => 'unavailable',
    });
    await assert.rejects(
        () => fetchPage({ template: TEMPLATE, cookies: COOKIES, params: { keywords: 'x' }, fetchImpl }),
        (err) => err instanceof NetworkError && err.statusCode === 503,
    );
});

// --- paginate ---------------------------------------------------------------

// Minimal flight payload containing one card with a permalink and a body.
function fakePage(activityId, handle, text) {
    const url = `https://www.linkedin.com/posts/${handle}_hiring-share-${activityId}-AbCd`;
    const card = ['$', 'div', null, {
        componentkey: 'expandedHASHFeedType_FLAGSHIP_SEARCH',
        children: [
            url,
            ['$', 'span', 'text-attr-0', { children: [['$', 'span', '0', { children: [null, text] }]] }],
        ],
    }];
    return `0:${JSON.stringify(card)}\n`;
}

test('paginate: aggregates posts across pages, deduping by activity id', async () => {
    const pages = [
        fakePage('7487914656553025536', 'alpha', 'Hiring a Data Engineer on W2 contract now'),
        fakePage('7487935663393185793', 'beta', 'Hiring a Senior Data Engineer, remote role'),
        // Repeat of page 1 — LinkedIn re-serves overlapping windows.
        fakePage('7487914656553025536', 'alpha', 'Hiring a Data Engineer on W2 contract now'),
    ];
    let call = 0;
    const fetchImpl = async () => okResponse(pages[call++]);
    const { posts } = await paginate({
        template: TEMPLATE, cookies: COOKIES,
        keywords: 'data engineer', maxPosts: 100, count: 1, maxPages: 3,
        fetchImpl, delay: async () => {},
    });
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map((p) => p.author_handle), ['alpha', 'beta']);
});

test('paginate: stops early when a page yields nothing new', async () => {
    const page = fakePage('7487914656553025536', 'alpha', 'Hiring a Data Engineer on W2 contract');
    let calls = 0;
    const fetchImpl = async () => { calls++; return okResponse(page); };
    await paginate({
        template: TEMPLATE, cookies: COOKIES, keywords: 'x',
        maxPosts: 100, count: 1, maxPages: 10, fetchImpl, delay: async () => {},
    });
    // Page 1 yields a post, page 2 repeats it and adds nothing -> stop.
    assert.equal(calls, 2);
});

test('paginate: stops at maxPosts without requesting further pages', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        return okResponse(fakePage(`748791465655302553${calls}`, `h${calls}`, `Hiring engineer number ${calls} now`));
    };
    const { posts } = await paginate({
        template: TEMPLATE, cookies: COOKIES, keywords: 'x',
        maxPosts: 2, count: 1, maxPages: 10, fetchImpl, delay: async () => {},
    });
    assert.equal(posts.length, 2);
    assert.equal(calls, 2);
});

test('paginate: paces requests through the injected delay', async () => {
    const waits = [];
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        return okResponse(fakePage(`748791465655302553${calls}`, `h${calls}`, `Hiring engineer ${calls} today`));
    };
    await paginate({
        template: TEMPLATE, cookies: COOKIES, keywords: 'x',
        maxPosts: 3, count: 1, maxPages: 3,
        fetchImpl, delay: async (ms) => { waits.push(ms); },
    });
    // Paced BETWEEN requests, so one fewer wait than requests.
    assert.equal(waits.length, calls - 1);
    assert.ok(waits.every((ms) => ms > 0), `expected positive waits, got ${waits}`);
});

test('paginate: reports a confirmed empty when LinkedIn signals no results', async () => {
    const noResults = '0:[[["$","$L1",null,{"modelStates":[{"key":{"key":{"value":{"$case":"id",'
        + '"id":"SearchResultsSearchHasNoresultsBindingKey"}}},"value":{"$case":"booleanValue",'
        + '"booleanValue":true}}]}]]]\n';
    const { posts, emptyConfirmed } = await paginate({
        template: TEMPLATE, cookies: COOKIES, keywords: 'nothing matches this',
        maxPosts: 50, count: 10, maxPages: 3,
        fetchImpl: async () => okResponse(noResults), delay: async () => {},
    });
    assert.equal(posts.length, 0);
    assert.equal(emptyConfirmed, true);
});

test('paginate: an empty page with NO no-results signal is not a confirmed empty', async () => {
    // This is the silent-block signature and must not be recorded as success.
    const { posts, emptyConfirmed } = await paginate({
        template: TEMPLATE, cookies: COOKIES, keywords: 'x',
        maxPosts: 50, count: 10, maxPages: 3,
        fetchImpl: async () => okResponse('0:{"unexpected":"shape"}\n'), delay: async () => {},
    });
    assert.equal(posts.length, 0);
    assert.equal(emptyConfirmed, false);
});
