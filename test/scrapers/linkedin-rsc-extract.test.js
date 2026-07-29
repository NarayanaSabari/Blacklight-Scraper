// Extracting post records from a LinkedIn content-search flight payload.
//
// Each post is one "card" row carrying
//   componentkey":"expanded<hash>FeedType_FLAGSHIP_SEARCH
// which holds the post's permalink. Cards are emitted TWICE (virtual-scroll
// buffer), and a post's commentary can live in a row the card references or in
// a row that merely follows one it references.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    extractPosts,
    isConfirmedEmpty,
    postedAtFromActivityId,
} from '../../src/scrapers/linkedin-rsc/extract.js';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// --- postedAtFromActivityId -------------------------------------------------

test('postedAtFromActivityId: decodes the creation time from the id high bits', () => {
    // LinkedIn activity ids embed epoch-ms in the top bits (id >> 22). This is an
    // exact timestamp, unlike the UI's relative "2d".
    assert.equal(postedAtFromActivityId('7487914656553025536'), '2026-07-28T16:59:32.849Z');
});

test('postedAtFromActivityId: null for ids that are not plausible activity ids', () => {
    assert.equal(postedAtFromActivityId(''), null);
    assert.equal(postedAtFromActivityId('123'), null);
    assert.equal(postedAtFromActivityId('not-a-number'), null);
});

// --- extractPosts -----------------------------------------------------------

test('extractPosts: returns one record per post, collapsing the double-render', () => {
    // 2 personal-feed posts (one emitted twice) plus 1 group post that rode along
    // in the captured rows. Every card must appear exactly once.
    const posts = extractPosts(readFixture('linkedin-rsc-search.txt'));
    assert.equal(posts.length, 3);
    assert.equal(new Set(posts.map((p) => p.post_url)).size, 3);
    assert.deepEqual(
        posts.map((p) => p.source).sort(),
        ['feed', 'feed', 'group'],
    );
});

test('extractPosts: every record carries a permalink, activity id and exact posted_at', () => {
    const posts = extractPosts(readFixture('linkedin-rsc-search.txt'));
    for (const post of posts) {
        // Both permalink shapes are valid post identities.
        assert.match(
            post.post_url,
            /^https:\/\/www\.linkedin\.com\/(posts\/|feed\/update\/urn:li:groupPost:)/,
        );
        assert.match(post.activity_id, /^\d{15,}$/);
        assert.match(post.posted_at, /^\d{4}-\d{2}-\d{2}T/);
    }
});

test('extractPosts: recovers the post body text', () => {
    const posts = extractPosts(readFixture('linkedin-rsc-search.txt'));
    const naren = posts.find((p) => p.author_handle === 'b-naren');
    assert.ok(naren, 'expected the b-naren post');
    assert.match(naren.text, /W2 contract/i);
    assert.match(naren.text, /Data Engineer/i);
    // Line structure must survive, not collapse into one run-on line.
    assert.ok(naren.text.includes('\n'), 'expected line breaks in the body');
});

test('extractPosts: pulls the recruiter contact email out of the body', () => {
    const posts = extractPosts(readFixture('linkedin-rsc-search.txt'));
    const naren = posts.find((p) => p.author_handle === 'b-naren');
    assert.deepEqual(naren.contact_emails, ['naren@caritatech.com']);
});

test('extractPosts: derives the author handle and hashtags from the permalink slug', () => {
    const posts = extractPosts(readFixture('linkedin-rsc-search.txt'));
    const naren = posts.find((p) => p.author_handle === 'b-naren');
    assert.deepEqual(naren.hashtags, ['dataengineer', 'dataengineer', 'data']);
});

test('extractPosts: excludes LinkedIn UI copy from the body', () => {
    // The comment-composer toast rides along in every card subtree and was
    // appended to all 108 bodies in an earlier revision.
    const posts = extractPosts(readFixture('linkedin-rsc-search.txt'));
    for (const post of posts) {
        assert.doesNotMatch(post.text, /Failed to post comment/i);
        assert.doesNotMatch(post.text, /Try again/i);
        assert.doesNotMatch(post.text, /Are these results helpful/i);
    }
});

test('extractPosts: recovers bodies emitted without a text-attr wrapper', () => {
    // This post's commentary uses the bare numeric-keyed render path AND its row
    // is reachable only by emission proximity, so it exercises both fallbacks.
    const posts = extractPosts(readFixture('linkedin-rsc-bare-textgroup.txt'));
    const bare = posts.find((p) => p.activity_id === '7487886887282704385');
    assert.ok(bare, 'expected the wrapper-less post');
    assert.match(bare.text, /Senior Data Engineer/i);
    assert.match(bare.text, /Remote/i);
});

test('extractPosts: no posts from a no-results payload', () => {
    assert.deepEqual(extractPosts(readFixture('linkedin-rsc-no-results.txt')), []);
});

// --- isConfirmedEmpty -------------------------------------------------------

test('isConfirmedEmpty: true when LinkedIn positively signals no results', () => {
    // Distinguishing "genuinely empty" from "silently blocked" is what keeps a
    // block from being recorded as a successful zero-job scrape.
    assert.equal(isConfirmedEmpty(readFixture('linkedin-rsc-no-results.txt')), true);
});

test('isConfirmedEmpty: false for a payload that carried results', () => {
    assert.equal(isConfirmedEmpty(readFixture('linkedin-rsc-search.txt')), false);
});

// --- attribution guard ------------------------------------------------------

// Two cards where the FIRST resolves its body through a `$L` reference and the
// SECOND resolves nothing, with the first card's text row sitting close enough in
// row-id space for the proximity fallback to reach it. The fallback must refuse a
// row that is already spoken for, otherwise one recruiter's body is attached to
// another recruiter's permalink.
function twoCardPayload() {
    const card = (hash, url, ref) => JSON.stringify(['$', 'div', null, {
        componentkey: `expanded${hash}FeedType_FLAGSHIP_SEARCH`,
        children: [url, ref],
    }]);
    const textRow = (body) => JSON.stringify(['$', 'span', 'text-attr-0', {
        children: [['$', 'span', '0', { children: [null, body] }]],
    }]);
    return [
        `10:${card('AAA', 'https://www.linkedin.com/posts/alpha_hiring-share-7487914656553025536-aaaa', '$L20')}`,
        `20:${textRow('Alpha is hiring a Data Engineer on a W2 contract, share resumes')}`,
        `11:${card('BBB', 'https://www.linkedin.com/posts/beta_hiring-share-7487935663393185793-bbbb', '$L21')}`,
        `21:${JSON.stringify(['$', 'div', null, { children: ['x'] }])}`,
        '',
    ].join('\n');
}

test('extractPosts: the proximity fallback will not steal a row another post already used', () => {
    const posts = extractPosts(twoCardPayload());
    assert.equal(posts.length, 2);
    const alpha = posts.find((p) => p.author_handle === 'alpha');
    const beta = posts.find((p) => p.author_handle === 'beta');
    assert.match(alpha.text, /Alpha is hiring/);
    assert.equal(beta.text, '', "beta has no body of its own and must not inherit alpha's");
});

test('extractPosts: a text row is never attributed to two different posts', () => {
    const bodies = extractPosts(readFixture('linkedin-rsc-search.txt'))
        .map((p) => p.text)
        .filter((t) => t.length > 0);
    assert.equal(new Set(bodies).size, bodies.length, 'two posts share the same body text');
});

// --- group posts ------------------------------------------------------------
//
// A large share of bench-sales content is posted inside LinkedIn GROUPS, not on
// personal feeds. Group posts have no /posts/<handle>_… permalink; they are
// identified by urn:li:groupPost:<groupId>-<activityId> and linked as
// /feed/update/urn:li:groupPost:… . Keying post identity solely on /posts/ made
// every group result invisible, which both lost data and made genuinely
// non-empty searches look empty.

test('extractPosts: extracts LinkedIn group posts', () => {
    const posts = extractPosts(readFixture('linkedin-rsc-group-post.txt'));
    assert.equal(posts.length, 1);
});

test('extractPosts: a group post is linked by its feed/update groupPost URL', () => {
    const [post] = extractPosts(readFixture('linkedin-rsc-group-post.txt'));
    assert.equal(
        post.post_url,
        'https://www.linkedin.com/feed/update/urn:li:groupPost:10529815-7487954097531207681',
    );
});

test('extractPosts: a group post activity id decodes to its posted time', () => {
    const [post] = extractPosts(readFixture('linkedin-rsc-group-post.txt'));
    assert.equal(post.activity_id, '7487954097531207681');
    assert.equal(post.posted_at, '2026-07-28T19:36:16.311Z');
});

test('extractPosts: a group post carries its body and recruiter contact', () => {
    const [post] = extractPosts(readFixture('linkedin-rsc-group-post.txt'));
    assert.match(post.text, /Test Lead/);
    assert.match(post.text, /Washington, DC/);
    assert.deepEqual(post.contact_emails, ['jhansi@transcendit.io']);
});

test('isConfirmedEmpty: false when LinkedIn reports HasNoresults=false', () => {
    // This payload has one group result. Reading the flag's presence rather than
    // its VALUE would wrongly call it a confirmed empty.
    assert.equal(isConfirmedEmpty(readFixture('linkedin-rsc-group-post.txt')), false);
});
