// posted_date on the wire must keep the time when the scraper found one.
//
// This is the first link in the "every LinkedIn job shows the same time" chain.
// linkedin-rsc/extract.js decodes an EXACT instant from the activity id, and
// format.js then did `postedDate.split('T')[0]` — discarding it. The backend
// parsed the date-only string to midnight UTC and, because LinkedIn is the one
// platform exempted from date-only time enrichment (on the grounds that it
// "already has exact times"), nothing put a time back. Prod ended up with
// 2,420/2,420 LinkedIn rows on exactly one timestamp per calendar day.
//
// MATCHED PAIR: server/tests/unit/test_linkedin_posted_date.py pins the backend
// half — that an ISO instant survives parse_posted_date with its time intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJobForBlacklight } from '../../src/core/format.js';
import { postToJob } from '../../src/scrapers/linkedin-rsc/scraper.js';

const base = (postedDate) => ({
    job: { title: 'SRE', description: 'x'.repeat(80), jobId: 'abc', postedDate },
});

test('an ISO instant reaches the wire with its time intact', () => {
    const wire = formatJobForBlacklight(base('2026-08-03T08:01:07.956Z'), 'linkedin');
    assert.equal(wire.posted_date, '2026-08-03T08:01:07.956Z');
});

test('two posts made on the same day get DIFFERENT posted_date values', () => {
    // The actual user-visible symptom: same day => same rendered time.
    const a = formatJobForBlacklight(base('2026-08-03T06:56:19.631Z'), 'linkedin');
    const b = formatJobForBlacklight(base('2026-08-03T08:01:07.956Z'), 'linkedin');
    assert.notEqual(a.posted_date, b.posted_date);
});

test('a date-only value still passes through unchanged', () => {
    // Every other platform reports only a date; this must not invent a time.
    const wire = formatJobForBlacklight(base('2026-08-03'), 'indeed');
    assert.equal(wire.posted_date, '2026-08-03');
});

test('posted_date stays within the 32-char cap the ingest schema enforces', () => {
    const wire = formatJobForBlacklight(base('2026-08-03T08:01:07.956123456789+05:30'), 'linkedin');
    assert.ok(wire.posted_date.length <= 32, `got ${wire.posted_date.length} chars`);
});

test('a missing or junk posted_date omits the key rather than sending garbage', () => {
    assert.equal('posted_date' in formatJobForBlacklight(base(null), 'linkedin'), false);
    assert.equal('posted_date' in formatJobForBlacklight(base('2 days ago'), 'linkedin'), false);
    assert.equal('posted_date' in formatJobForBlacklight(base('N/A'), 'linkedin'), false);
});

test('end to end: a decoded LinkedIn post keeps its exact time through postToJob', () => {
    // 7220983512345678901 >> 22 is the post's epoch-ms.
    const postedAt = new Date(Number(7220983512345678901n >> 22n)).toISOString();
    const post = {
        activity_id: '7220983512345678901',
        post_url: 'https://www.linkedin.com/posts/jane_hiring-activity-7220983512345678901-Ab1c',
        posted_at: postedAt,
        author_handle: 'jane',
        hashtags: [],
        text: 'Job Title: Senior Data Engineer\nLocation: Austin, TX\n' + 'x'.repeat(80),
        contact_emails: [],
        contact_phones: [],
    };

    const wire = formatJobForBlacklight(postToJob(post, 'United States'), 'linkedin');

    assert.equal(wire.posted_date, postedAt);
    assert.ok(!wire.posted_date.endsWith('T00:00:00.000Z'), 'must not collapse to midnight');
});
