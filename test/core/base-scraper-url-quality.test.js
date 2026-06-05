import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';

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
