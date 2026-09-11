import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectObservedGroupDom, groupPaginationCursor, GROUP_QUERY_ID } from '../../src/scrapers/linkedin-group/scraper.js';

const checkpoint = { version: 1, cursor: null, oldest_activity_id: null, watermark_posted_at: null, history_complete: false };
const groupFor = (id) => ({ source_id: id, id, url: `https://www.linkedin.com/groups/${id}/`, checkpoint });
const requestUrl = (id, token = 'head-token') => `https://www.linkedin.com/voyager/api/graphql?queryId=${GROUP_QUERY_ID}&variables=${encodeURIComponent(`(start:2,count:10,groupId:${id},paginationToken:${token})`)}`;

async function responseFor(id, activityId) {
    const fixture = JSON.parse(await readFile(new URL('../fixtures/linkedin-group-response-element.sanitized.json', import.meta.url), 'utf8'));
    const feed = fixture.data.feedDashGroupsUpdatesByGroupsFeed;
    feed.elements[0].entityUrn = `urn:li:activity:${activityId}`;
    feed.elements[0].metadata.backendUrn = `urn:li:activity:${activityId}`;
    feed.elements[0].metadata.shareUrn = `urn:li:groupPost:${id}-${activityId}`;
    feed.metadata.paginationToken = `next-${id}`;
    feed.metadata.paginationTokenExpiryTime = 9999999999999;
    return fixture;
}

test('configured groups use their own feed and ignore responses for another group', async () => {
    for (const id of [10472901, 23456789]) {
        const otherId = id === 10472901 ? 23456789 : 10472901;
        const own = await responseFor(id, String(7504055760767811584n + BigInt(id)));
        const other = await responseFor(otherId, '7504055760767811500');
        let onResponse;
        let visited;
        const result = await collectObservedGroupDom({
            group: groupFor(id),
            sessionId: `group-${id}`,
            session: { withCookies: async (_id, fn) => fn([], { credential: {} }) },
            browserLauncher: async () => ({
                newPage: async () => ({
                    on: (event, handler) => { if (event === 'response') onResponse = handler; },
                    goto: async (url) => {
                        visited = url;
                        onResponse({ url: () => requestUrl(otherId), status: () => 200, json: async () => other });
                        onResponse({ url: () => requestUrl(id), status: () => 200, json: async () => own });
                    },
                }),
                close: async () => {},
            }),
            maxScrolls: 0,
            timeBudgetMs: 0,
        });
        assert.equal(visited, groupFor(id).url);
        assert.equal(result.posts.length, 1);
        assert.equal(result.posts[0].group_id, String(id));
        assert.equal(JSON.parse(result.groupProgress.checkpoint.cursor).token, `next-${id}`);
    }
});

test('saved pagination for a second group replays only that assigned group', async () => {
    const id = 23456789;
    const capture = await responseFor(id, '7504055760767811584');
    const replayRequests = [];
    const result = await collectObservedGroupDom({
        group: groupFor(id),
        checkpoint: { ...checkpoint, cursor: JSON.stringify({ token: 'saved-second', start: 32 }) },
        sessionId: 'second-group',
        session: { withCookies: async (_id, fn) => fn([], { credential: {} }) },
        browserLauncher: async () => ({
            newPage: async () => ({
                on: () => {}, goto: async () => {},
                evaluate: async (_fn, args) => {
                    replayRequests.push(args.requestUrl);
                    return { status: 200, body: capture };
                },
            }),
            close: async () => {},
        }),
        maxPosts: 1, maxScrolls: 1, timeBudgetMs: 0,
    });
    assert.equal(replayRequests.length, 1);
    const variables = new URL(replayRequests[0]).searchParams.get('variables');
    assert.match(variables, /groupId:23456789,/);
    assert.match(variables, /start:32,/);
    assert.equal(result.posts[0].group_id, String(id));
});

test('group request matching and source validation retain their origin and identity boundaries', async () => {
    assert.equal(groupPaginationCursor(requestUrl(23456789), 23456789), 'head-token');
    assert.equal(groupPaginationCursor(requestUrl(10472901), 23456789), null);
    assert.equal(groupPaginationCursor(requestUrl(23456789).replace('www.linkedin.com', 'evil.example'), 23456789), null);
    for (const group of [
        { ...groupFor(23456789), url: groupFor(10472901).url },
        { ...groupFor(23456789), url: 'https://evil.example/groups/23456789/' },
        groupFor('1,groupId:2'), groupFor(-1), groupFor(Number.MAX_SAFE_INTEGER + 1),
    ]) {
        await assert.rejects(collectObservedGroupDom({ group, session: { withCookies: () => assert.fail('invalid source leased a credential') } }), /group/i);
    }
});
