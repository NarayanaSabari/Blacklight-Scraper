// Observability contract: the fix must not blind the alerts, and must not
// make them cry wolf.
//
// This change deliberately makes a HEALTHY steady-state sweep return zero
// jobs, which is the same surface shape as a blocked scraper. Production has
// alerts watching exactly that shape, so both directions matter:
//
//   FALSE POSITIVE  a healthy sweep must not inflate the zero-result ratio,
//                   or scraper-zero-result-ratio-high (fires above 0.8) pages
//                   the on-call channel every hour of normal operation.
//   FALSE NEGATIVE  a genuinely blocked scraper must still be visible, or the
//                   fix quietly converts a loud outage into a silent one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BaseScraper } from '../../src/core/base-scraper.js';
import { CanaryTracker } from '../../src/scrapers/linkedin-rsc/canary.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { paginate } from '../../src/scrapers/linkedin-rsc/client.js';

const NO_RESULTS = fs.readFileSync(
    path.join(import.meta.dirname, '../fixtures/linkedin-rsc-no-results.txt'), 'utf8',
);
const TEMPLATE = { url: 'https://x', headers: { 'user-agent': 'x' }, postData: '{}' };

// Minimal metrics spy with the same surface base-scraper.js calls.
function metricsSpy() {
    const calls = { zeroJobs: 0, sessions: [], jobsScraped: [] };
    return {
        calls,
        recordSession: (p, r) => calls.sessions.push(`${p}:${r}`),
        recordJobsScraped: (p, n) => calls.jobsScraped.push(n),
        noteZeroJobs: () => { calls.zeroJobs += 1; },
        recordUrlQuality: () => {},
    };
}

function linkedinScraper(metrics) {
    const s = new BaseScraper('linkedin', scrapeLinkedInRsc, { strictEmpty: true });
    s._metrics = metrics;
    return s;
}

function opts({ mark, body = NO_RESULTS }) {
    const lease = {
        credential: { profile_key: 'obs' },
        reportSuccess: async () => {},
        reportFailure: async () => {},
    };
    return {
        session: {
            async withCookies(_id, fn) {
                return fn([{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"ajax:1"' }], lease);
            },
        },
        template: TEMPLATE,
        highWater: { get: () => mark, advance: () => {} },
        canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
        pacer: null,
        paginateImpl: (args) => paginate({
            ...args,
            fetchImpl: async () => ({ status: 200, text: async () => body }),
            delay: async () => {},
        }),
    };
}

test('a healthy known-ground sweep does NOT inflate the zero-result ratio', async () => {
    // scraper_zero_result_sessions_total feeds
    // alerts/scraper-zero-result-ratio-high.json, which fires when the ratio of
    // zero-result to successful sessions exceeds 0.8 over an hour. After this
    // change most healthy LinkedIn sweeps yield zero jobs, so if they counted
    // here the alert would fire continuously during perfectly normal operation
    // and be muted within a day — costing us the detector entirely.
    const metrics = metricsSpy();
    const scraper = linkedinScraper(metrics);

    for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scraper.executeWithMeta('Business Analyst', 'US', 's', opts({ mark: '7487914656553025536' }));
    }

    assert.equal(metrics.calls.zeroJobs, 0, 'healthy zeros must not count as zero-result sessions');
    assert.equal(metrics.calls.sessions.length, 20);
    assert.ok(
        metrics.calls.sessions.every((s) => s === 'linkedin:success'),
        'every known-ground sweep is a success',
    );
});

test('a genuinely unconfirmed zero DOES still count, so the alert keeps working', async () => {
    // The other direction. A zero with no no-results marker is the silent-block
    // signature: it must still increment the counter AND raise, or a broken
    // parser reads as a quiet healthy day forever.
    const metrics = metricsSpy();
    const scraper = linkedinScraper(metrics);

    await assert.rejects(
        () => scraper.executeWithMeta('Business Analyst', 'US', 's', {
            ...opts({ mark: null }),
            paginateImpl: async () => ({ posts: [], emptyConfirmed: false, pages: [] }),
        }),
    );
    assert.equal(metrics.calls.zeroJobs, 1, 'an unexplained zero must still be counted for the alert');
});

test('jobs_scraped is still recorded, so the 6h no-jobs safety net survives', async () => {
    // alerts/scraper-no-nonzero-scrape.json watches
    // scraper_last_nonzero_scrape_timestamp_seconds and pages when a platform
    // has produced nothing for 6h while up. That gauge only advances on a
    // scrape with > 0 jobs, so it is the backstop that still catches a REAL
    // outage even though healthy zeros are now silent. Confirm the metric path
    // is still driven on every scrape.
    const metrics = metricsSpy();
    const scraper = linkedinScraper(metrics);
    await scraper.executeWithMeta('Business Analyst', 'US', 's', opts({ mark: '7487914656553025536' }));

    assert.deepEqual(metrics.calls.jobsScraped, [0], 'jobs count must be reported even when zero');
});
