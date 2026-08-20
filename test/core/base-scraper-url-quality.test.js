import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';
import { normalizeJobData } from '../../src/core/normalize.js';

function fakeMetrics() {
    const calls = [];
    return {
        recordSession() {},
        recordJobsScraped() {},
        recordFailure() {},
        noteZeroJobs() {},
        recordUrlQuality(platform, quality) { calls.push([platform, quality]); },
        _calls: calls,
    };
}

test('BaseScraper.execute: emits one url-quality sample per job', async () => {
    const metrics = fakeMetrics();
    const scraper = new BaseScraper('linkedin', async () => ([
        { url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' },
        { url: 'https://www.linkedin.com/in/someone' },
        { url: '' },
    ]), { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(metrics._calls, [
        ['linkedin', 'permalink'],
        ['linkedin', 'profile_in'],
        ['linkedin', 'empty'],
    ]);
});

test('BaseScraper.execute: emits nothing on a zero-jobs result', async () => {
    const metrics = fakeMetrics();
    const scraper = new BaseScraper('indeed', async () => ([]), { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(metrics._calls, []);
});

test('BaseScraper.execute: still emits when scraper returns {jobs} shape', async () => {
    const metrics = fakeMetrics();
    const scraper = new BaseScraper('linkedin', async () => ({
        jobs: [{ url: 'https://www.indeed.com/jobs/view/42' }],
        emptyConfirmed: false,
    }), { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(metrics._calls, [['linkedin', 'permalink']]);
});

// --- the 2026-08-20 shape-mismatch incident ---------------------------------
//
// scraper_url_quality_total read 6148/6148 'empty' for every LinkedIn job ever
// submitted. The permalinks were correct end to end (confirmed against a
// spooled production payload) - the metric was reading `job.url`, but every
// real scraper's jobs pass through normalizeJobData() first, which nests the
// url under `job.job.url`. `job.url` on that shape is always undefined, so
// EVERY platform's url-quality metric was a permanent false positive, not
// just LinkedIn's. These tests use the real nested shape so a future
// normalizeJobData refactor that moves the field fails here, loudly, instead
// of silently reintroducing the incident.

test('BaseScraper.execute: reads the url out of the NESTED normalizeJobData shape, not job.url', async () => {
    const metrics = fakeMetrics();
    const normalized = normalizeJobData({
        url: 'https://www.linkedin.com/posts/ayaan15_seniorjavadeveloper-javajobs-share-7488632142269186048-abcd',
    }, 'LinkedIn');
    // Guard the fixture itself: if this ever stops being nested, the test
    // below would pass for the wrong reason.
    assert.equal(normalized.url, undefined, 'the top level must NOT carry url directly');
    assert.match(normalized.job.url, /^https:\/\//, 'url must live at job.job.url');

    const scraper = new BaseScraper('linkedin', async () => [normalized], { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(
        metrics._calls,
        [['linkedin', 'permalink']],
        'must classify the real permalink, not misread it as empty',
    );
});

test('BaseScraper.execute: a normalized job with genuinely no source url classifies empty, not other', async () => {
    // coreJob() defaults a missing url to the string 'N/A', not null/empty.
    const metrics = fakeMetrics();
    const normalized = normalizeJobData({}, 'Indeed');
    assert.equal(normalized.job.url, 'N/A');

    const scraper = new BaseScraper('indeed', async () => [normalized], { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(metrics._calls, [['indeed', 'empty']]);
});

test('BaseScraper.execute: a broken extractor across a normalized-shape batch raises scraper_alert once', async (t) => {
    const errorLogs = [];
    t.mock.method(console, 'error', (line) => { errorLogs.push(line); });

    const metrics = fakeMetrics();
    // Mirrors the incident: every job normalized, every job with no real url.
    const jobs = Array.from({ length: 10 }, () => normalizeJobData({}, 'LinkedIn'));
    const scraper = new BaseScraper('linkedin', async () => jobs, { metrics });
    await scraper.execute('SRE', 'US', 'session-1');

    assert.equal(metrics._calls.filter(([, q]) => q === 'empty').length, 10);
    const alertLines = errorLogs.filter((l) => l.includes('url_quality_degraded'));
    assert.equal(alertLines.length, 1, 'exactly one alert per scrape, not one per job');
    assert.match(alertLines[0], /"jobCount":10/);
    assert.match(alertLines[0], /"emptyCount":10/);
});

test('BaseScraper.execute: a healthy normalized-shape batch raises no alert', async (t) => {
    const errorLogs = [];
    t.mock.method(console, 'error', (line) => { errorLogs.push(line); });

    const metrics = fakeMetrics();
    const jobs = Array.from({ length: 10 }, (_, i) => normalizeJobData({
        url: `https://www.linkedin.com/posts/person${i}_role-share-748863214226918604${i}-abcd`,
    }, 'LinkedIn'));
    const scraper = new BaseScraper('linkedin', async () => jobs, { metrics });
    await scraper.execute('SRE', 'US', 'session-1');

    assert.equal(metrics._calls.filter(([, q]) => q === 'empty').length, 0);
    assert.equal(errorLogs.filter((l) => l.includes('url_quality_degraded')).length, 0);
});

