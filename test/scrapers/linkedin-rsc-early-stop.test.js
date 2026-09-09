// Early-stop on already-seen posts (the `sinceActivityId` high-water mark).
//
// This is the mechanism that makes higher LinkedIn cadence affordable: without
// it every sweep re-walks the same 24h window, which is why the measured import
// rate sat at 0.30–2.85% with `duplicate_title_company_location` as the top skip
// reason. These tests pin the request saving and, just as importantly, that a
// no-new-posts sweep is never mistaken for a block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../../src/scrapers/linkedin-rsc/client.js';

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
                payload: { startIndex: 3, count: 3, keywords: 'old query', datePosted: ['past-week'] },
            },
        },
    }),
};
const COOKIES = [
    { name: 'li_at', value: 'AQEDAT-session-token', domain: '.www.linkedin.com' },
    { name: 'JSESSIONID', value: '"ajax:8695764573883137377"', domain: '.www.linkedin.com' },
];

function okResponse(body) {
    return { status: 200, text: async () => body };
}

function card(activityId, handle, text) {
    const url = `https://www.linkedin.com/posts/${handle}_hiring-share-${activityId}-AbCd`;
    return ['$', 'div', null, {
        componentkey: 'expandedHASHFeedType_FLAGSHIP_SEARCH',
        children: [
            url,
            ['$', 'span', 'text-attr-0', { children: [['$', 'span', '0', { children: [null, text] }]] }],
        ],
    }];
}

function pageOf(...cards) {
    return cards.map((c, i) => `${i}:${JSON.stringify(c)}\n`).join('');
}

// Ascending ids = ascending post times. Ids are 19 digits on purpose.
const P1 = '7487914656553025531';
const P2 = '7487914656553025532';
const P3 = '7487914656553025533';

function run({ pages, sinceActivityId, maxPages = 10 }) {
    let calls = 0;
    const fetchImpl = async () => okResponse(pages[Math.min(calls++, pages.length - 1)]);
    return paginate({
        template: TEMPLATE, cookies: COOKIES, keywords: 'data engineer',
        maxPosts: 100, count: 1, maxPages, fetchImpl, delay: async () => {},
        sinceActivityId,
    }).then((r) => ({ ...r, calls: () => calls }));
}

test('no mark: every post is returned and nothing reports up-to-date', async () => {
    const r = await run({
        pages: [pageOf(card(P3, 'a', 'Hiring a Data Engineer on W2 now'))],
        sinceActivityId: null,
    });
    assert.equal(r.posts.length, 1);
    assert.equal(r.upToDate, false);
});

test('posts at or below the mark are dropped, newer ones kept', async () => {
    const r = await run({
        pages: [pageOf(
            card(P3, 'new', 'Hiring a Senior Data Engineer remote'),
            card(P2, 'mark', 'Hiring a Data Engineer on W2 now'),
            card(P1, 'old', 'Hiring a Junior Data Engineer today'),
        )],
        sinceActivityId: P2,
    });
    assert.deepEqual(r.posts.map((p) => p.author_handle), ['new']);
});

test('a page of entirely known posts stops the walk after one request', async () => {
    // The saving that pays for higher cadence: ten pages become one.
    const known = pageOf(card(P1, 'old', 'Hiring a Data Engineer on W2 contract now'));
    const r = await run({ pages: [known, known, known], sinceActivityId: P2, maxPages: 10 });
    assert.equal(r.calls(), 1, 'must not keep paging through known ground');
    assert.equal(r.posts.length, 0);
});

test('nothing new is reported up-to-date, NOT confirmed-empty', async () => {
    // The distinction the block detector depends on. LinkedIn served results;
    // we simply already hold them. Claiming emptyConfirmed here would assert
    // something LinkedIn never said.
    const r = await run({
        pages: [pageOf(card(P1, 'old', 'Hiring a Data Engineer on W2 contract now'))],
        sinceActivityId: P2,
    });
    assert.equal(r.upToDate, true);
    assert.equal(r.emptyConfirmed, false);
});

test('a genuinely empty response is still empty, not up-to-date', async () => {
    // No cards and no no-results flag: the silent-block signature. The mark
    // must not launder it into a healthy outcome.
    const r = await run({ pages: ['0:[]\n'], sinceActivityId: P2 });
    assert.equal(r.posts.length, 0);
    assert.equal(r.upToDate, false);
    assert.equal(r.emptyConfirmed, false);
});

test('an old post above a new one does not end the walk prematurely', async () => {
    // LinkedIn orders content search by relevance as well as recency, so a
    // known post can sit above unknown ones. Stopping at the first known post
    // would silently lose the newer ones below it.
    const r = await run({
        pages: [pageOf(
            card(P1, 'old', 'Hiring a Junior Data Engineer today'),
            card(P3, 'new', 'Hiring a Senior Data Engineer remote'),
        )],
        sinceActivityId: P2,
    });
    assert.deepEqual(r.posts.map((p) => p.author_handle), ['new']);
    assert.equal(r.upToDate, false);
});

test('newestActivityId reports the max seen, including filtered-out posts', async () => {
    // The mark must advance even on a sweep that forwarded nothing, or a role
    // whose newest post is already known would re-scan it forever.
    const r = await run({
        pages: [pageOf(card(P2, 'mark', 'Hiring a Data Engineer on W2 now'))],
        sinceActivityId: P2,
    });
    assert.equal(r.posts.length, 0);
    assert.equal(r.newestActivityId, P2);
});
