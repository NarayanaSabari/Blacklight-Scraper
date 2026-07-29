// The LinkedIn RSC scraper as the orchestrator sees it: same signature and
// return contract as the DOM scraper, so BaseScraper and formatJobForBlacklight
// need no changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    scrapeLinkedInRsc,
    postToJob,
} from '../../src/scrapers/linkedin-rsc/scraper.js';
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

test('postToJob: recruiter contact details are preserved', () => {
    // The DOM scraper discards these entirely; they are the point of the rebuild.
    const job = postToJob(POST, 'United States');
    assert.deepEqual(job.recruiter.contact, ['naren@caritatech.com']);
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
