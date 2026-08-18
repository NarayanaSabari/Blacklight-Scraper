// The LinkedIn RSC scraper as the orchestrator sees it: same signature and
// return contract as the DOM scraper. The formatter carries recruiter contacts
// through to the backend payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    scrapeLinkedInRsc,
    postToJob,
} from '../../src/scrapers/linkedin-rsc/scraper.js';
import { CanaryTracker } from '../../src/scrapers/linkedin-rsc/canary.js';
import { formatJobForBlacklight } from '../../src/core/format.js';

const POST = {
    activity_id: '7487914656553025536',
    post_url: 'https://www.linkedin.com/posts/b-naren_dataengineer-share-7487914656553025536-hWl2',
    posted_at: '2026-07-28T16:59:32.849Z',
    author_handle: 'b-naren',
    hashtags: ['dataengineer'],
    text: 'W2 contract - Data Engineer, Chicago, IL\n8+ years Python, AWS, SQL\n'
        + 'Please share your resume at naren@caritatech.com',
    text_length: 110,
    contact_emails: ['naren@caritatech.com'],
    contact_phones: [],
};

// --- postToJob --------------------------------------------------------------

test('postToJob: the permalink becomes the job url, nested where the importer reads it', () => {
    // formatJobForBlacklight reads jobData.url from the nested `job` block. An
    // earlier revision checked the top-level field and dropped every LinkedIn post.
    const job = postToJob(POST, 'United States');
    assert.equal(job.job.url, POST.post_url);
});

test('postToJob: post body becomes the description, verbatim', () => {
    const job = postToJob(POST, 'United States');
    assert.equal(job.job.description, POST.text);
});

test('postToJob: exact posted_at is carried through as the posted date', () => {
    // Decoded from the activity id, so it beats the DOM scraper's relative "2d".
    const job = postToJob(POST, 'United States');
    assert.equal(job.job.postedDate, '2026-07-28T16:59:32.849Z');
});

test('postToJob: external id reaching the backend is the activity id, so dedup is stable', () => {
    // Asserted through the real wire formatter rather than an internal field:
    // platform_job_id is what the backend dedupes on, so that is the contract.
    const wire = formatJobForBlacklight(postToJob(POST, 'United States'), 'linkedin');
    assert.equal(wire.platform_job_id, '7487914656553025536');
});

test('postToJob: the wire record carries the permalink, body and posted date', () => {
    const wire = formatJobForBlacklight(postToJob(POST, 'United States'), 'linkedin');
    assert.equal(wire.url, POST.post_url);
    assert.equal(wire.description, POST.text);
    assert.match(wire.posted_date, /^2026-07-28/);
});

test('postToJob: recruiter contact details are preserved, emails and phones separate', () => {
    // The DOM scraper discards these entirely; they are the point of the rebuild.
    const job = postToJob(POST, 'United States');
    assert.deepEqual(job.recruiter.emails, ['naren@caritatech.com']);
    assert.deepEqual(job.recruiter.phones, []);
});

test('postToJob → formatJobForBlacklight: recruiter emails/phones reach the wire payload', () => {
    const wire = formatJobForBlacklight(postToJob(POST, 'United States'), 'linkedin');
    assert.deepEqual(wire.recruiter, {
        name: 'B Naren',
        profile_url: null,
        emails: ['naren@caritatech.com'],
        phones: [],
    });
});

test('postToJob → formatJobForBlacklight: no recruiter key when a post has no contacts', () => {
    const noContact = { ...POST, contact_emails: [], contact_phones: [] };
    const wire = formatJobForBlacklight(postToJob(noContact, 'United States'), 'linkedin');
    assert.equal('recruiter' in wire, false);
});

test('postToJob: title is derived from the body and stays within the column bound', () => {
    const longPost = { ...POST, text: 'A'.repeat(500) };
    const job = postToJob(longPost, 'United States');
    assert.ok(job.job.title.length > 0);
    assert.ok(job.job.title.length <= 200, `title was ${job.job.title.length} chars`);
});

// --- scrapeLinkedInRsc ------------------------------------------------------

function fakeSession(cookies = [{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }]) {
    return {
        calls: [],
        async withCookies(sessionId, fn) {
            this.calls.push(sessionId);
            return fn(cookies, { credential: { id: 7, email: 'a@b.c' } });
        },
    };
}

test('scrapeLinkedInRsc: returns the BaseScraper contract shape', async () => {
    const result = await scrapeLinkedInRsc('Data Engineer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        paginateImpl: async () => ({ posts: [POST], emptyConfirmed: false, pages: [] }),
    });
    assert.ok(Array.isArray(result.jobs));
    assert.equal(result.jobs.length, 1);
    assert.equal(result.emptyConfirmed, false);
});

test('scrapeLinkedInRsc: runs exactly ONE query variant per session', async () => {
    // LinkedIn invalidates an automated session after roughly one query, so the
    // scraper must not walk every AI variant in a single run.
    const seen = [];
    await scrapeLinkedInRsc('Data Engineer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        searchQueries: ['variant one', 'variant two', 'variant three'],
        paginateImpl: async ({ keywords }) => {
            seen.push(keywords);
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
    });
    assert.equal(seen.length, 1);
    assert.ok(['variant one', 'variant two', 'variant three'].includes(seen[0]));
});

test('scrapeLinkedInRsc: falls back to the boolean template when no variants are given', async () => {
    let used = null;
    await scrapeLinkedInRsc('Data Engineer', 'United States', null, {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        paginateImpl: async ({ keywords }) => {
            used = keywords;
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
    });
    assert.equal(used, '"Data Engineer" AND (c2c OR W2 OR 1099)');
});

test('scrapeLinkedInRsc: propagates a confirmed empty instead of inventing success', async () => {
    const result = await scrapeLinkedInRsc('Nothing', 'United States', null, {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        paginateImpl: async () => ({ posts: [], emptyConfirmed: true, pages: [] }),
    });
    assert.deepEqual(result.jobs, []);
    assert.equal(result.emptyConfirmed, true);
});

test('scrapeLinkedInRsc: an unconfirmed empty is NOT reported as confirmed', async () => {
    const result = await scrapeLinkedInRsc('Nothing', 'United States', null, {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        paginateImpl: async () => ({ posts: [], emptyConfirmed: false, pages: [] }),
    });
    assert.equal(result.emptyConfirmed, false);
});

test('scrapeLinkedInRsc: reports scrape liveness against the held lease', async () => {
    // The orchestrator's availability gate depends on the lease being touched.
    let reported = null;
    const session = fakeSession();
    session.withCookies = async (sessionId, fn) => fn(
        [{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }],
        { credential: { id: 7 }, reportSuccess: async (msg) => { reported = msg; } },
    );
    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session,
        template: { url: 'https://x', headers: {}, postData: '{}' },
        paginateImpl: async () => ({ posts: [POST], emptyConfirmed: false, pages: [] }),
    });
    assert.match(String(reported), /1/);
});

// --- candidate boolean queries ----------------------------------------------

const CANDIDATE_QUERY = '("Java" OR "Kotlin") AND ("AWS" OR "Azure") NOT junior';

test('scrapeLinkedInRsc: a candidate query is sent verbatim', async () => {
    // A recruiter typed this exact boolean. Any rewriting on our side makes the
    // results unexplainable to the person tuning it.
    let used = null;
    await scrapeLinkedInRsc('Senior Java Developer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        candidateQuery: CANDIDATE_QUERY,
        paginateImpl: async ({ keywords }) => {
            used = keywords;
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
    });
    assert.equal(used, CANDIDATE_QUERY);
});

test('scrapeLinkedInRsc: a candidate query beats the role variant pick', async () => {
    // Randomising across variants is right for a role and wrong for a
    // hand-written query: it would run only some of the time, with no way for
    // the recruiter to tell why.
    const seen = [];
    for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('Senior Java Developer', 'United States', 'sess-1', {
            session: fakeSession(),
            template: { url: 'https://x', headers: {}, postData: '{}' },
            searchQueries: ['variant one', 'variant two', 'variant three'],
            candidateQuery: CANDIDATE_QUERY,
            // Pinned so the shared module-level tracker cannot reach its
            // threshold and fire a canary probe mid-loop; the probe's control
            // query is not a variant pick and would otherwise show up here.
            canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
            paginateImpl: async ({ keywords }) => {
                seen.push(keywords);
                return { posts: [], emptyConfirmed: true, pages: [] };
            },
        });
    }
    assert.deepEqual([...new Set(seen)], [CANDIDATE_QUERY]);
});

test('scrapeLinkedInRsc: still ONE query per session when candidate-scoped', async () => {
    // The anti-bot constraint does not relax just because the query is bespoke.
    const seen = [];
    await scrapeLinkedInRsc('Senior Java Developer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        candidateQuery: CANDIDATE_QUERY,
        paginateImpl: async ({ keywords }) => {
            seen.push(keywords);
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
    });
    assert.equal(seen.length, 1);
});

test('scrapeLinkedInRsc: an empty candidate query falls back, never searches ""', async () => {
    // A blank string is falsy on purpose — `??` would have passed it straight
    // through and searched LinkedIn for nothing.
    let used = null;
    await scrapeLinkedInRsc('Data Engineer', 'United States', null, {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        candidateQuery: '',
        searchQueries: ['variant one'],
        paginateImpl: async ({ keywords }) => {
            used = keywords;
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
    });
    assert.equal(used, 'variant one');
});

test('scrapeLinkedInRsc: role path is untouched when no candidate query is given', async () => {
    let used = null;
    await scrapeLinkedInRsc('Data Engineer', 'United States', null, {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        candidateQuery: null,
        paginateImpl: async ({ keywords }) => {
            used = keywords;
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
    });
    assert.equal(used, '"Data Engineer" AND (c2c OR W2 OR 1099)');
});

// --- candidate queries run to exhaustion ------------------------------------

function countingPaginate(pagesOfPosts) {
    // Serves one page per call, then goes empty — mirrors LinkedIn's real
    // behaviour where an exhausted result set stops adding new posts.
    const calls = [];
    let i = 0;
    return {
        calls,
        impl: async (args) => {
            calls.push(args);
            const posts = pagesOfPosts[i] ?? [];
            i += 1;
            return { posts, emptyConfirmed: false, pages: [{ page: i }] };
        },
    };
}

test('scrapeLinkedInRsc: a candidate query lifts the post cap', async () => {
    // 100 was discarding ~3.4x the available results on real recruiter queries.
    const { calls, impl } = countingPaginate([[POST]]);
    await scrapeLinkedInRsc('Data Engineer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        candidateQuery: '"Data Engineer" AND (c2c OR W2)',
        paginateImpl: impl,
    });
    assert.equal(calls[0].maxPosts, Number.MAX_SAFE_INTEGER);
});

test('scrapeLinkedInRsc: a ROLE sweep keeps the 100 cap', async () => {
    // Role sweeps run ~135/hour; lifting the cap there multiplies steady-state
    // load for a different purpose and is deliberately not part of this change.
    const { calls, impl } = countingPaginate([[POST]]);
    await scrapeLinkedInRsc('Data Engineer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        paginateImpl: impl,
    });
    assert.equal(calls[0].maxPosts, 100);
    assert.equal(calls[0].timeBudgetMs, 0, 'role sweeps get no time budget');
});

test('scrapeLinkedInRsc: candidate queries do NOT raise the page size', async () => {
    // DEFAULT_COUNT is small on purpose — a large page size is the most obvious
    // automation tell in this transport, and the LinkedIn account is worth more
    // than the saved requests. Lifting the post cap must not smuggle that in.
    const { calls, impl } = countingPaginate([[POST]]);
    await scrapeLinkedInRsc('Data Engineer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        candidateQuery: '"Data Engineer"',
        count: 10,
        paginateImpl: impl,
    });
    assert.equal(calls[0].count, 10);
    assert.ok(calls[0].count <= 10, 'page size must stay modest for anti-detection');
});

test('scrapeLinkedInRsc: candidate queries carry a wall-clock safety valve', async () => {
    const { calls, impl } = countingPaginate([[POST]]);
    await scrapeLinkedInRsc('Data Engineer', 'United States', 'sess-1', {
        session: fakeSession(),
        template: { url: 'https://x', headers: {}, postData: '{}' },
        candidateQuery: '"Data Engineer"',
        paginateImpl: impl,
    });
    // Must stay comfortably under the backend's 600s orphan window, or a long
    // scrape lets a second scraper claim the same platform and double-scrape.
    assert.ok(calls[0].timeBudgetMs > 0);
    assert.ok(
        calls[0].timeBudgetMs < 600_000,
        `budget ${calls[0].timeBudgetMs}ms must stay under INFLIGHT_GRACE_SECONDS (600s)`,
    );
});
