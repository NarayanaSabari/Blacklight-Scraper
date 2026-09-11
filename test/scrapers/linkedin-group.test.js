import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BlacklightApiClient } from '../../src/api/blacklight.js';
import { QueueOrchestrator } from '../../src/queue/orchestrator.js';
import { NetworkError, TimeoutError } from '../../src/core/errors.js';
import {
    extractGroupPosts,
    parseGroupGraphqlResponse,
    paginateGroupFeed,
} from '../../src/scrapers/linkedin-group/feed.js';
import {
    GROUP_QUERY_ID,
    collectObservedGroupDom,
    groupPaginationCursor,
} from '../../src/scrapers/linkedin-group/scraper.js';

const GROUP = {
    source_id: 7,
    id: 10472901,
    url: 'https://www.linkedin.com/groups/10472901/',
    checkpoint: {
        version: 1,
        cursor: null,
        oldest_activity_id: null,
        watermark_posted_at: null,
        history_complete: false,
    },
};

const PROGRESS = {
    checkpoint: {
        version: 1,
        cursor: 'cursor-2',
        oldest_activity_id: 'activity-2',
        watermark_posted_at: '2026-09-11T08:00:00.000Z',
        history_complete: true,
    },
    traversal: 'complete',
    stop_reason: 'exhausted',
    posts_seen: 2,
};

function observedGroupUrl({ token = 'input-token', start = 2, count = 10 } = {}) {
    const variables = encodeURIComponent(
        `(start:${start},count:${count},groupId:10472901,paginationToken:${token})`,
    );
    return `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${GROUP_QUERY_ID}`;
}

test('the sanitized live capture keeps the activity id distinct from the group id', async () => {
    const capture = JSON.parse(await readFile(
        path.join(process.cwd(), 'test/fixtures/linkedin-group-first-post.sanitized.json'),
        'utf8',
    ));
    const post = extractGroupPosts(capture)[0];
    assert.equal(post.activityId, capture.activityId);
    assert.notEqual(post.activityId, capture.groupId);
    assert.match(post.url, /linkedin\.com\/feed\/update\/urn:li:activity:/);
    assert.equal(post.text, capture.bodyText);
});

test('the observed response uses entityUrn activity identity over a different groupPost share urn', async () => {
    const capture = JSON.parse(await readFile(
        path.join(process.cwd(), 'test/fixtures/linkedin-group-response-element.sanitized.json'),
        'utf8',
    ));
    const parsed = parseGroupGraphqlResponse(capture);
    assert.equal(parsed.posts.length, 1);
    assert.equal(parsed.posts[0].activity_id, '7504055760767811584');
    assert.equal(parsed.posts[0].post_url, 'https://www.linkedin.com/feed/update/urn:li:activity:7504055760767811584');
    assert.equal(parsed.posts[0].group_post_urn, 'urn:li:groupPost:10472901-7504055759815708672');
    assert.equal(parsed.nextCursor, '<opaque-pagination-token>');
    assert.equal(parsed.exhausted, false);
});

test('the observed GraphQL request exposes an opaque resumable cursor', async () => {
    const capture = JSON.parse(await readFile(
        path.join(process.cwd(), 'test/fixtures/linkedin-group-pagination.sanitized.json'),
        'utf8',
    ));
    const { variables, queryId } = capture.request;
    const encoded = encodeURIComponent(
        `(start:${variables.start},count:${variables.count},groupId:${variables.groupId},paginationToken:${variables.paginationToken})`,
    );
    const url = `https://www.linkedin.com/voyager/api/graphql?variables=${encoded}&queryId=${queryId}`;
    assert.equal(groupPaginationCursor(url), '<opaque-pagination-token>');
    assert.equal(queryId, GROUP_QUERY_ID);
    assert.equal(groupPaginationCursor(url.replace('https://www.linkedin.com', 'https://evil.example')), null);
    assert.equal(groupPaginationCursor(url.replace('https://', 'http://')), null);
    assert.equal(groupPaginationCursor(url.replace('/voyager/api/graphql', '/other/voyager/api/graphql')), null);
});

test('the observed browser collector reuses profile/proxy capacity and never calls a scroll stall exhausted', async () => {
    const html = '<div class="occludable-update">'
        + '<div data-view-name="feed-full-update">'
        + '<div data-urn="urn:li:activity:7504081637186543616">'
        + '<div class="update-components-update-v2__commentary">Title: Senior Engineer</div>'
        + '</div></div></div>';
    let browserOptions;
    let closeCalls = 0;
    const page = {
        locator: () => ({ count: async () => 0 }),
        on: () => {},
        goto: async () => {},
        content: async () => html,
        url: () => GROUP.url,
        evaluate: async () => {},
        waitForTimeout: async () => {},
    };
    const context = {
        newPage: async () => page,
        close: async () => { closeCalls += 1; },
    };
    const session = {
        withCookies: async (_sessionId, fn) => fn([], {
            credential: { profile_key: 'profile-1', proxy: 'proxy.example:8080:user:pass' },
        }),
    };
    const result = await collectObservedGroupDom({
        group: GROUP,
        sessionId: 'group-session',
        session,
        browserLauncher: async (options) => { browserOptions = options; return context; },
        maxScrolls: 3,
        timeBudgetMs: 0,
    });
    assert.deepEqual(browserOptions, { profileKey: 'profile-1', proxy: 'proxy.example:8080:user:pass' });
    assert.equal(closeCalls, 1);
    assert.equal(result.posts.length, 1);
    assert.equal(result.groupProgress.traversal, 'incomplete');
    assert.equal(result.groupProgress.stop_reason, 'page_budget');
    assert.equal(result.groupProgress.checkpoint.history_complete, false);
});

test('requests without observed response bodies cannot advance a fresh checkpoint', async () => {
    let requestHandler;
    const page = {
        on: (event, handler) => { if (event === 'request') requestHandler = handler; },
        goto: async () => {
            for (const start of [2, 20]) {
                const variables = encodeURIComponent(`(start:${start},count:10,groupId:10472901,paginationToken:token-${start})`);
                requestHandler({ url: () => `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${GROUP_QUERY_ID}` });
            }
        },
    };
    const result = await collectObservedGroupDom({
        group: GROUP,
        sessionId: 'group-session',
        session: { withCookies: async (_id, fn) => fn([], { credential: {} }) },
        browserLauncher: async () => ({ newPage: async () => page, close: async () => {} }),
        maxScrolls: 0,
        timeBudgetMs: 0,
    });
    assert.equal(result.groupProgress.checkpoint.cursor, null);
    assert.equal(result.groupProgress.traversal, 'incomplete');
});

test('a resumed DOM walk keeps the durable cursor until it replays that cursor', async () => {
    const html = '<div class="occludable-update">'
        + '<div data-view-name="feed-full-update">'
        + '<div data-urn="urn:li:activity:7504081637186543616">'
        + '<div class="update-components-update-v2__commentary">Title: Senior Engineer</div>'
        + '</div></div></div>';
    const requestUrl = (cursor) => {
        const variables = encodeURIComponent(
            `(start:32,count:10,groupId:10472901,paginationToken:${cursor})`,
        );
        return `https://www.linkedin.com/voyager/api/graphql?variables=${variables}&queryId=${GROUP_QUERY_ID}`;
    };
    let requestHandler;
    let scrolls = 0;
    const page = {
        locator: () => ({ count: async () => 0 }),
        on: (event, handler) => { if (event === 'request') requestHandler = handler; },
        goto: async () => {},
        content: async () => html,
        url: () => GROUP.url,
        evaluate: async () => {
            scrolls += 1;
            if (scrolls === 1) requestHandler({ url: () => requestUrl('resume-cursor') });
        },
        waitForTimeout: async () => {},
    };
    const session = {
        withCookies: async (_sessionId, fn) => fn([], { credential: {} }),
    };
    const result = await collectObservedGroupDom({
        group: GROUP,
        checkpoint: { ...GROUP.checkpoint, cursor: 'resume-cursor' },
        sessionId: 'group-session',
        session,
        browserLauncher: async () => ({
            newPage: async () => page,
            close: async () => {},
        }),
        maxScrolls: 3,
        timeBudgetMs: 0,
    });
    assert.equal(result.groupProgress.checkpoint.cursor, 'resume-cursor');
});

test('the response transport caps a page without advancing past its unconsumed remainder', async () => {
    const capture = JSON.parse(await readFile(
        path.join(process.cwd(), 'test/fixtures/linkedin-group-response-element.sanitized.json'),
        'utf8',
    ));
    const feed = capture.data.feedDashGroupsUpdatesByGroupsFeed;
    const second = JSON.parse(JSON.stringify(feed.elements[0]));
    second.entityUrn = 'urn:li:fsd_update:(urn:li:activity:7504055760767811585,PUBLIC_GROUP_FEED,DEBUG_REASON,DEFAULT,false)';
    second.metadata.backendUrn = 'urn:li:activity:7504055760767811585';
    second.metadata.shareUrn = 'urn:li:groupPost:10472901-7504055759815708673';
    second.commentary.text.text = 'Second observed post';
    feed.elements.push(second);
    const responseUrl = observedGroupUrl({ token: 'input-token', start: 2 });
    let responseHandler;
    const page = {
        locator: () => ({ count: async () => 0 }),
        on: (event, handler) => { if (event === 'response') responseHandler = handler; },
        goto: async () => {
            responseHandler({
                url: () => responseUrl,
                status: () => 200,
                json: async () => capture,
            });
            // A second prefetched response must not replace the first
            // page's cursor after its unconsumed remainder hits the cap.
            responseHandler({
                url: () => observedGroupUrl({ token: 'later-page', start: 12 }),
                status: () => 200,
                json: async () => capture,
            });
        },
        content: async () => '<div class="occludable-update"></div>',
        url: () => GROUP.url,
        evaluate: async () => {},
        waitForTimeout: async () => {},
    };
    const result = await collectObservedGroupDom({
        group: GROUP,
        sessionId: 'group-session',
        session: {
            withCookies: async (_id, fn) => fn([], { credential: {} }),
        },
        browserLauncher: async () => ({
            newPage: async () => page,
            close: async () => {},
        }),
        maxPosts: 1,
        maxScrolls: 3,
        timeBudgetMs: 0,
    });
    assert.equal(result.posts.length, 1);
    assert.equal(result.groupProgress.stop_reason, 'page_budget');
    assert.deepEqual(JSON.parse(result.groupProgress.checkpoint.cursor), {
        token: 'input-token',
        start: 2,
        skip: 1,
    });
});

test('delayed earlier response bodies stay ahead of later responses at the post cap', async () => {
    const capture = JSON.parse(await readFile(
        path.join(process.cwd(), 'test/fixtures/linkedin-group-response-element.sanitized.json'),
        'utf8',
    ));
    const first = structuredClone(capture);
    const firstFeed = first.data.feedDashGroupsUpdatesByGroupsFeed;
    firstFeed.elements[0].entityUrn = 'urn:li:fsd_update:(urn:li:activity:200,PUBLIC_GROUP_FEED,DEBUG_REASON,DEFAULT,false)';
    firstFeed.elements[0].metadata.backendUrn = 'urn:li:activity:200';
    firstFeed.elements[0].metadata.shareUrn = 'urn:li:groupPost:10472901-200';
    firstFeed.elements[0].commentary.text.text = 'Title: first observed post';
    firstFeed.paging.start = 2;
    firstFeed.paging.count = 18;
    firstFeed.metadata.paginationToken = 'next-token';
    firstFeed.metadata.paginationTokenExpiryTime = null;

    const second = structuredClone(first);
    const secondFeed = second.data.feedDashGroupsUpdatesByGroupsFeed;
    secondFeed.elements[0].entityUrn = 'urn:li:fsd_update:(urn:li:activity:201,PUBLIC_GROUP_FEED,DEBUG_REASON,DEFAULT,false)';
    secondFeed.elements[0].metadata.backendUrn = 'urn:li:activity:201';
    secondFeed.elements[0].metadata.shareUrn = 'urn:li:groupPost:10472901-201';
    secondFeed.elements[0].commentary.text.text = 'Title: later observed post';
    secondFeed.paging.start = 20;
    secondFeed.metadata.paginationToken = null;
    secondFeed.endOfFeed = true;

    const firstUrl = observedGroupUrl({ token: 'first-token', start: 2, count: 18 });
    const secondUrl = observedGroupUrl({ token: 'next-token', start: 20 });
    let requestHandler;
    let responseHandler;
    let resolveFirstBody;
    const firstBody = new Promise((resolve) => { resolveFirstBody = resolve; });
    const page = {
        locator: () => ({ count: async () => 0 }),
        on: (event, handler) => {
            if (event === 'request') requestHandler = handler;
            if (event === 'response') responseHandler = handler;
        },
        goto: async () => {
            requestHandler({ url: () => firstUrl });
            requestHandler({ url: () => secondUrl });
            responseHandler({
                url: () => firstUrl,
                status: () => 200,
                json: async () => firstBody,
            });
            responseHandler({
                url: () => secondUrl,
                status: () => 200,
                json: async () => second,
            });
            await new Promise((resolve) => setImmediate(() => {
                resolveFirstBody(first);
                resolve();
            }));
        },
        content: async () => '<div class="occludable-update"></div>',
        url: () => GROUP.url,
        evaluate: async () => {},
        waitForTimeout: async () => {},
    };
    const result = await collectObservedGroupDom({
        group: GROUP,
        sessionId: 'group-session',
        session: {
            withCookies: async (_id, fn) => fn([], { credential: {} }),
        },
        browserLauncher: async () => ({
            newPage: async () => page,
            close: async () => {},
        }),
        maxPosts: 1,
        maxScrolls: 1,
        timeBudgetMs: 0,
        now: () => 0,
    });

    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].activity_id, '200');
    assert.equal(result.groupProgress.stop_reason, 'page_budget');
    assert.deepEqual(JSON.parse(result.groupProgress.checkpoint.cursor), {
        token: 'next-token',
        start: 20,
    });
});

test('a capped page resumes its unconsumed posts before new head responses', async () => {
    const capture = JSON.parse(await readFile(
        path.join(process.cwd(), 'test/fixtures/linkedin-group-response-element.sanitized.json'), 'utf8',
    ));
    const feed = capture.data.feedDashGroupsUpdatesByGroupsFeed;
    const second = structuredClone(feed.elements[0]);
    second.entityUrn = 'urn:li:fsd_update:(urn:li:activity:7504055760767811585,PUBLIC_GROUP_FEED,DEBUG_REASON,DEFAULT,false)';
    second.metadata.backendUrn = 'urn:li:activity:7504055760767811585';
    second.commentary.text.text = 'Another eligible job post';
    feed.elements.push(second);
    const responseUrl = observedGroupUrl({ token: 'input-token', start: 2 });
    const options = {
        group: GROUP,
        sessionId: 'group-session',
        session: { withCookies: async (_id, fn) => fn([], { credential: {} }) },
        browserLauncher: async () => {
            let onResponse;
            return {
                newPage: async () => ({
                    locator: () => ({ count: async () => 0 }),
                    on: (event, handler) => { if (event === 'response') onResponse = handler; },
                    goto: async () => onResponse({ url: () => responseUrl, status: () => 200, json: async () => capture }),
                    evaluate: async (_fn, args) => args?.requestUrl ? { status: 200, body: capture } : undefined,
                    content: async () => '<div class="occludable-update"></div>',
                    url: () => GROUP.url,
                    waitForTimeout: async () => {},
                }),
                close: async () => {},
            };
        },
        maxPosts: 1,
        maxScrolls: 1,
        timeBudgetMs: 0,
    };
    const first = await collectObservedGroupDom(options);
    const resumed = await collectObservedGroupDom({
        ...options, checkpoint: first.groupProgress.checkpoint,
    });
    assert.equal(first.posts[0].activity_id, '7504055760767811584');
    assert.equal(resumed.posts.length, 1);
    assert.equal(resumed.posts[0].activity_id, '7504055760767811585');
    assert.notEqual(resumed.groupProgress.checkpoint.cursor, first.groupProgress.checkpoint.cursor);
});

test('the durable cursor replay follows observed paging offsets through the backlog', async () => {
    const first = JSON.parse(await readFile(
        path.join(process.cwd(), 'test/fixtures/linkedin-group-response-element.sanitized.json'),
        'utf8',
    ));
    const second = JSON.parse(JSON.stringify(first));
    const secondFeed = second.data.feedDashGroupsUpdatesByGroupsFeed;
    secondFeed.elements[0].entityUrn = 'urn:li:fsd_update:(urn:li:activity:7504055760767811585,PUBLIC_GROUP_FEED,DEBUG_REASON,DEFAULT,false)';
    secondFeed.elements[0].metadata.backendUrn = 'urn:li:activity:7504055760767811585';
    secondFeed.elements[0].metadata.shareUrn = 'urn:li:groupPost:10472901-7504055759815708673';
    secondFeed.elements[0].commentary.text.text = 'Second observed post';
    secondFeed.paging.start = 12;
    secondFeed.metadata.paginationToken = null;
    secondFeed.endOfFeed = true;
    const starts = [];
    const page = {
        locator: () => ({ count: async () => 0 }),
        on: () => {},
        goto: async () => {},
        content: async () => '<div class="occludable-update"></div>',
        url: () => GROUP.url,
        evaluate: async (_fn, args) => {
            if (!args?.requestUrl) return undefined;
            const decoded = decodeURIComponent(args.requestUrl);
            starts.push(Number(decoded.match(/start:(\d+)/)?.[1]));
            return decoded.includes('resume-token')
                ? { status: 200, body: first }
                : { status: 200, body: second };
        },
        waitForTimeout: async () => {},
    };
    const checkpoint = {
        ...GROUP.checkpoint,
        cursor: JSON.stringify({ token: 'resume-token', start: 2 }),
    };
    const result = await collectObservedGroupDom({
        group: GROUP,
        checkpoint,
        sessionId: 'group-session',
        session: {
            withCookies: async (_id, fn) => fn([{ name: 'JSESSIONID', value: 'csrf' }], { credential: {} }),
        },
        browserLauncher: async () => ({
            newPage: async () => page,
            close: async () => {},
        }),
        maxScrolls: 2,
        timeBudgetMs: 0,
        now: () => 0,
    });
    assert.deepEqual(starts, [2, 12]);
    assert.equal(result.groupProgress.traversal, 'complete');
    assert.equal(result.groupProgress.stop_reason, 'exhausted');
    assert.equal(result.groupProgress.checkpoint.cursor, null);
    assert.equal(result.groupProgress.checkpoint.history_complete, true);
});

test('a generic cursor HTTP 400 is failed without silently restarting from the head', async () => {
    const checkpoint = {
        ...GROUP.checkpoint,
        cursor: JSON.stringify({ token: 'resume-token', start: 12 }),
    };
    let contentCalls = 0;
    await assert.rejects(
        () => collectObservedGroupDom({
            group: GROUP,
            checkpoint,
            sessionId: 'group-session',
            session: {
                withCookies: async (_id, fn) => fn([{ name: 'JSESSIONID', value: 'csrf' }], { credential: {} }),
            },
            browserLauncher: async () => ({
                newPage: async () => ({
                    locator: () => ({ count: async () => 0 }),
                    on: () => {},
                    goto: async () => {},
                    content: async () => { contentCalls += 1; return '<div class="occludable-update"></div>'; },
                    url: () => GROUP.url,
                    evaluate: async (_fn, args) => args?.requestUrl
                        ? { status: 400, body: { error: 'bad start parameter' } }
                        : undefined,
                    waitForTimeout: async () => {},
                }),
                close: async () => {},
            }),
            maxScrolls: 2,
            timeBudgetMs: 0,
        }),
        (error) => {
            assert.equal(error.code, 'NETWORK_ERROR');
            assert.equal(error.groupProgress.stop_reason, 'failed');
            assert.deepEqual(error.groupProgress.checkpoint, checkpoint);
            assert.equal(contentCalls, 0);
            return true;
        },
    );
});

function metrics() {
    return {
        recordQueueCheck() {},
        recordJobsSubmitted() {},
        recordSessionAllFailed() {},
    };
}

function groupScraper(result = { jobs: [], emptyConfirmed: true, groupProgress: PROGRESS }) {
    const calls = [];
    return {
        calls,
        executeWithMeta: async (...args) => {
            calls.push(args);
            return result;
        },
    };
}

function fakeQueueClient(overrides = {}) {
    const calls = { claims: 0, groupClaims: 0, submits: [], completes: [] };
    return {
        calls,
        checkCredentialAvailability: async () => ({ linkedin: 1, indeed: 1 }),
        getNextRole: async () => {
            calls.claims += 1;
            return { assignments: [] };
        },
        claimLinkedInGroup: async () => {
            calls.groupClaims += 1;
            return calls.groupClaims === 1
                ? { session_id: 'group-session', group: GROUP, platforms: [{ name: 'linkedin' }] }
                : null;
        },
        submitJobs: async (sessionId, platform, jobs, status, errorMessage, meta) => {
            calls.submits.push({ sessionId, platform, jobs, status, errorMessage, meta });
            return { progress: '1/1' };
        },
        completeSession: async (sessionId) => {
            calls.completes.push(sessionId);
            return { duration_seconds: 1, jobs: {} };
        },
        ...overrides,
    };
}

function groupPost(id, postedAt = '2026-09-11T08:00:00.000Z', text = `Title: Engineer ${id}`) {
    return {
        activity_id: String(id),
        activityId: String(id),
        post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
        url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
        posted_at: postedAt,
        text,
    };
}

test('pagination deduplicates pinned/out-of-order cards and requires an explicit end marker', async () => {
    const requested = [];
    const pages = new Map([
        [null, {
            posts: [groupPost('200'), groupPost('100')],
            nextCursor: 'cursor-1',
        }],
        ['cursor-1', {
            posts: [groupPost('200'), groupPost('150')],
            nextCursor: 'cursor-2',
        }],
        ['cursor-2', {
            posts: [],
            nextCursor: null,
            exhausted: true,
            emptyConfirmed: false,
        }],
    ]);
    const result = await paginateGroupFeed({
        checkpoint: GROUP.checkpoint,
        maxPosts: 10,
        timeBudgetMs: 0,
        fetchPage: async ({ cursor }) => {
            requested.push(cursor);
            return pages.get(cursor);
        },
    });
    assert.deepEqual(requested, [null, 'cursor-1', 'cursor-2']);
    assert.deepEqual(result.posts.map((post) => post.activity_id), ['200', '100', '150']);
    assert.equal(result.groupProgress.traversal, 'complete');
    assert.equal(result.groupProgress.stop_reason, 'exhausted');
    assert.equal(result.groupProgress.checkpoint.history_complete, true);
    assert.equal(result.groupProgress.checkpoint.oldest_activity_id, '100');
});

test('a batch cap never advances past the unvisited remainder of its current page', async () => {
    let calls = 0;
    const result = await paginateGroupFeed({
        checkpoint: GROUP.checkpoint,
        maxPosts: 2,
        timeBudgetMs: 0,
        fetchPage: async () => {
            calls += 1;
            return {
                posts: [groupPost('300'), groupPost('299'), groupPost('298')],
                nextCursor: 'cursor-after-page',
            };
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result.posts.map((post) => post.activity_id), ['300', '299']);
    assert.equal(result.groupProgress.traversal, 'incomplete');
    assert.equal(result.groupProgress.stop_reason, 'page_budget');
    assert.equal(result.groupProgress.checkpoint.cursor, null, 'first page remainder must be replayed');
});

test('a cursorless page without positive exhaustion evidence remains incomplete', async () => {
    const result = await paginateGroupFeed({
        checkpoint: GROUP.checkpoint,
        timeBudgetMs: 0,
        fetchPage: async () => ({ posts: [], nextCursor: null }),
    });
    assert.equal(result.emptyConfirmed, false);
    assert.equal(result.groupProgress.traversal, 'incomplete');
    assert.equal(result.groupProgress.stop_reason, 'page_budget');
    assert.equal(result.groupProgress.checkpoint.history_complete, false);
});

test('incremental scans retain conservative overlap for backend activity-id deduplication', async () => {
    const result = await paginateGroupFeed({
        checkpoint: {
            ...GROUP.checkpoint,
            history_complete: true,
            watermark_posted_at: '2026-09-11T10:00:00.000Z',
        },
        timeBudgetMs: 0,
        fetchPage: async () => ({
            posts: [
                groupPost('400', '2026-09-11T09:00:00.000Z'),
                groupPost('401', '2026-09-11T11:00:00.000Z'),
            ],
            exhausted: true,
        }),
    });
    assert.deepEqual(result.posts.map((post) => post.activity_id), ['400', '401']);
    assert.equal(result.groupProgress.checkpoint.history_complete, true);
    assert.equal(result.groupProgress.checkpoint.watermark_posted_at, '2026-09-11T11:00:00.000Z');
});

test('access denial carries non-advancing progress for delivery diagnostics', async () => {
    await assert.rejects(
        () => paginateGroupFeed({
            checkpoint: GROUP.checkpoint,
            timeBudgetMs: 0,
            fetchPage: async () => ({ accessDenied: true }),
        }),
        (error) => {
            assert.equal(error.code, 'BLOCKED');
            assert.equal(error.kind, 'access_denied');
            assert.equal(error.groupProgress.traversal, 'incomplete');
            assert.equal(error.groupProgress.stop_reason, 'access_denied');
            assert.equal(error.groupProgress.checkpoint.history_complete, false);
            return true;
        },
    );
});

test('BlacklightApiClient claims the group and treats 204 as no work', async (t) => {
    const api = new BlacklightApiClient('https://blacklight.example.com', 'key');
    const responses = [
        new Response(JSON.stringify({ session_id: 's', group: GROUP, platforms: [{ name: 'linkedin' }] }), { status: 200 }),
        new Response(null, { status: 204 }),
    ];
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift();
    });

    const claimed = await api.claimLinkedInGroup();
    assert.equal(claimed.group.id, 10472901);
    assert.equal(await api.claimLinkedInGroup(), null);
    assert.equal(requests[0].url, 'https://blacklight.example.com/api/scraper/groups/claim');
    assert.equal(requests[0].init.method, 'POST');
});

test('BlacklightApiClient can select the source during orphan recovery', async (t) => {
    const api = new BlacklightApiClient('https://blacklight.example.com', 'key');
    let requestedUrl;
    t.mock.method(globalThis, 'fetch', async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ has_active_session: false, session: null }), { status: 200 });
    });

    await api.checkActiveSession({ source: 'group' });

    assert.equal(
        requestedUrl,
        'https://blacklight.example.com/api/scraper/queue/current-session?source=group',
    );
});

test('old backends returning 404 leave group work unavailable without breaking queue use', async (t) => {
    const api = new BlacklightApiClient('https://blacklight.example.com', 'key');
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
        calls += 1;
        if (String(url).endsWith('/api/scraper/groups/claim')) {
            return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify({ assignments: [] }), { status: 200 });
    });

    assert.equal(await api.claimLinkedInGroup(), null);
    assert.equal(await api.claimLinkedInGroup(), null);
    assert.equal(await api.claimLinkedInGroup(), null);
    assert.equal(await api.getNextRole({ platforms: ['linkedin'] }).then((r) => r?.assignments?.length), 0);
    assert.equal(calls, 4, 'optional 404 probes must not retry or poison normal queue polling');
});

test('group progress is carried on the jobs wire body', async (t) => {
    const api = new BlacklightApiClient('https://blacklight.example.com', 'key');
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });

    await api.submitJobs('group-session', 'linkedin', [], 'success', null, {
        emptyConfirmed: true,
        groupProgress: PROGRESS,
    });

    assert.deepEqual(body.group_progress, PROGRESS);
    assert.equal(body.empty_confirmed, true);
});

test('group claim is scheduled through the existing queue cycle', async () => {
    const client = fakeQueueClient();
    const group = groupScraper();
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        groupScraper: group,
        platformOverrides: { pausedList: () => [], intervalMinutes: () => null },
        cooldownCheck: () => [],
    });

    const result = await orchestrator.runOnce();
    assert.deepEqual(result, { batched: 1, roles: ['LinkedIn group 10472901'] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.calls.groupClaims, 1);
    assert.equal(group.calls.length, 1);
    assert.deepEqual(client.calls.submits[0].meta.groupProgress, PROGRESS);
    assert.deepEqual(client.calls.completes, ['group-session']);
});

test('a normal LinkedIn assignment suppresses a same-cycle group claim', async () => {
    let served = false;
    const client = fakeQueueClient({
        getNextRole: async () => {
            if (served) return { assignments: [] };
            served = true;
            return {
                assignments: [{
                    session_id: 'normal-session',
                    role: { name: 'Data Engineer', search_queries: null },
                    platforms: [{ name: 'linkedin' }],
                }],
            };
        },
        claimLinkedInGroup: async () => {
            throw new Error('group claim should not run while LinkedIn is assigned');
        },
    });
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        scraperResolver: () => ({ executeWithMeta: async () => ({ jobs: [], emptyConfirmed: true }) }),
        groupScraper: groupScraper(),
        platformOverrides: { pausedList: () => [], intervalMinutes: () => null },
        cooldownCheck: () => [],
    });

    await orchestrator.runOnce();
    assert.equal(client.calls.groupClaims, 0);
});

test('a due normal LinkedIn queue cannot starve the bounded group turn', async () => {
    let roleClaims = 0;
    const client = fakeQueueClient({
        checkCredentialAvailability: async () => ({ linkedin: 1 }),
        getNextRole: async () => {
            roleClaims += 1;
            return roleClaims === 1
                ? {
                    assignments: [{
                        session_id: 'normal-session',
                        role: { name: 'Data Engineer', search_queries: null },
                        platforms: [{ name: 'linkedin' }],
                    }],
                }
                : { assignments: [] };
        },
    });
    const group = groupScraper();
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        scraperResolver: () => ({ executeWithMeta: async () => ({ jobs: [], emptyConfirmed: true }) }),
        groupScraper: group,
        platformOverrides: { pausedList: () => [], intervalMinutes: () => null },
        cooldownCheck: () => [],
    });
    // Keep the assignment's completion poll from changing the turn order while
    // this test drives two explicit cycles.
    orchestrator._pollScheduled = true;

    await orchestrator.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.calls.groupClaims, 0, 'normal LinkedIn work gets the first turn');

    await orchestrator.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.calls.groupClaims, 1, 'the next eligible cycle gives the group a turn');
    assert.equal(roleClaims, 1, 'a successful group claim removes LinkedIn from the role claim');
    assert.equal(group.calls.length, 1);
});

test('an active group lease blocks normal LinkedIn work while Indeed continues', async () => {
    let releaseGroup;
    const groupGate = new Promise((resolve) => { releaseGroup = resolve; });
    let roleClaims = 0;
    const client = fakeQueueClient({
        checkCredentialAvailability: async () => ({ linkedin: 1, indeed: 1 }),
        getNextRole: async ({ platforms }) => {
            roleClaims += 1;
            if (roleClaims === 1) return { assignments: [] };
            assert.deepEqual(platforms, ['indeed']);
            return {
                assignments: [{
                    session_id: 'indeed-session',
                    role: { name: 'Analyst', search_queries: null },
                    platforms: [{ name: 'indeed' }],
                }],
            };
        },
    });
    const group = groupScraper({
        jobs: [],
        emptyConfirmed: true,
        groupProgress: PROGRESS,
    });
    group.executeWithMeta = async (...args) => {
        group.calls.push(args);
        await groupGate;
        return { jobs: [], emptyConfirmed: true, groupProgress: PROGRESS };
    };
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        scraperResolver: () => ({ executeWithMeta: async () => ({ jobs: [], emptyConfirmed: true }) }),
        groupScraper: group,
        platformOverrides: { pausedList: () => [], intervalMinutes: () => null },
        cooldownCheck: () => [],
    });
    orchestrator._pollScheduled = true;
    orchestrator._preferGroupNext = true;

    await orchestrator.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(group.calls.length, 1);

    await orchestrator.runOnce();
    assert.equal(roleClaims, 2);
    assert.equal(client.calls.groupClaims, 1, 'active group work must not be claimed again');
    releaseGroup();
    await new Promise((resolve) => setImmediate(resolve));
});

test('a timed-out group claim resumes the recovered group session', async () => {
    const client = fakeQueueClient({
        checkCredentialAvailability: async () => ({ linkedin: 1 }),
        getNextRole: async () => {
            throw new Error('normal role claim should not run after group recovery');
        },
        claimLinkedInGroup: async () => {
            throw new TimeoutError('group claim timed out after 30000ms');
        },
        checkActiveSession: async () => ({
            has_active_session: true,
            session: {
                session_id: 'recovered-group-session',
                role_name: null,
                group: GROUP,
                platforms: [{ name: 'linkedin' }],
            },
        }),
    });
    const group = groupScraper();
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        groupScraper: group,
        platformOverrides: { pausedList: () => [], intervalMinutes: () => null },
        cooldownCheck: () => [],
    });
    orchestrator._pollScheduled = true;
    orchestrator._preferGroupNext = true;

    const result = await orchestrator.runOnce();
    assert.deepEqual(result, { batched: 1, roles: ['LinkedIn group 10472901'] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(group.calls.length, 1);
    assert.deepEqual(client.calls.completes, ['recovered-group-session']);
});

test('an ambiguous group claim 5xx resumes only a group orphan', async () => {
    const client = fakeQueueClient({
        checkCredentialAvailability: async () => ({ linkedin: 1 }),
        getNextRole: async () => {
            throw new Error('normal role claim must not replace group recovery');
        },
        claimLinkedInGroup: async () => {
            throw new NetworkError('group claim returned 503 after commit', { statusCode: 503 });
        },
        checkActiveSession: async ({ source } = {}) => {
            assert.equal(source, 'group');
            return {
                has_active_session: true,
                session: {
                    session_id: 'recovered-group-503',
                    role_name: null,
                    group: GROUP,
                    platforms: [{ name: 'linkedin' }],
                },
            };
        },
    });
    const group = groupScraper();
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        groupScraper: group,
        platformOverrides: { pausedList: () => [], intervalMinutes: () => null },
        cooldownCheck: () => [],
    });
    orchestrator._pollScheduled = true;
    orchestrator._preferGroupNext = true;

    const result = await orchestrator.runOnce();
    assert.deepEqual(result, { batched: 1, roles: ['LinkedIn group 10472901'] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(group.calls.length, 1);
    assert.deepEqual(client.calls.completes, ['recovered-group-503']);
});

test('unrelated normal platforms continue when an old backend has no group endpoint', async () => {
    let served = false;
    const client = fakeQueueClient({
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => {
            if (served) return { assignments: [] };
            served = true;
            return {
                assignments: [{
                    session_id: 'indeed-session',
                    role: { name: 'Analyst', search_queries: null },
                    platforms: [{ name: 'indeed' }],
                }],
            };
        },
        claimLinkedInGroup: async () => null,
    });
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        scraperResolver: () => ({ executeWithMeta: async () => ({ jobs: [], emptyConfirmed: true }) }),
        groupScraper: groupScraper(),
        platformOverrides: { pausedList: () => [], intervalMinutes: () => null },
        cooldownCheck: () => [],
    });

    const result = await orchestrator.runOnce();
    assert.deepEqual(result, { batched: 1, roles: ['Analyst'] });
});

test('a normal claim closes a begun sweep for a platform the backend did not return', async () => {
    const client = fakeQueueClient({
        checkCredentialAvailability: async () => ({ linkedin: 1, indeed: 1 }),
        getNextRole: async ({ platforms }) => {
            assert.deepEqual(platforms, ['linkedin', 'indeed']);
            return {
                assignments: [{
                    session_id: 'indeed-cadence-session',
                    role: { name: 'Analyst', search_queries: null },
                    platforms: [{ name: 'indeed' }],
                }],
            };
        },
        claimLinkedInGroup: async () => null,
    });
    const orchestrator = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1000 },
        client,
        metrics: metrics(),
        scraperResolver: () => ({ executeWithMeta: async () => ({ jobs: [], emptyConfirmed: true }) }),
        platformOverrides: {
            pausedList: () => [],
            intervalMinutes: (platform) => ['linkedin', 'indeed'].includes(platform) ? 60 : null,
        },
        cooldownCheck: () => [],
    });
    orchestrator._pollScheduled = true;

    await orchestrator.runOnce();

    const snapshot = orchestrator.sweepSnapshot();
    assert.equal(snapshot.linkedin?.inFlight, false, 'missing LinkedIn assignment must close its sweep');
    assert.equal(snapshot.indeed?.inFlight, true, 'returned Indeed assignment must keep its sweep open');
});

test('failed group delivery retains progress in the local spool record', async (t) => {
    const spoolDir = await mkdtemp(path.join(os.tmpdir(), 'linkedin-group-spool-'));
    t.after(() => rm(spoolDir, { recursive: true, force: true }));
    process.env.SPOOL_DIR = spoolDir;
    t.after(() => { delete process.env.SPOOL_DIR; });

    const api = new BlacklightApiClient('https://blacklight.example.com', 'key');
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
    await assert.rejects(() => api.submitJobs(
        'group-session', 'linkedin', [], 'success', null, { groupProgress: PROGRESS },
    ));

    const files = await readdir(spoolDir);
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(path.join(spoolDir, files[0]), 'utf8'));
    assert.deepEqual(record.groupProgress, PROGRESS);
});
