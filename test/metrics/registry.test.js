import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMetrics, resetMetricsForTest } from '../../src/metrics/registry.js';
import { resetConfigForTest } from '../../src/config/env.js';

function freshMetrics() {
    resetConfigForTest();
    resetMetricsForTest();
    return getMetrics();
}

test('recordJobsScraped sets the last-scraped gauge on every call, including 0', async () => {
    const m = freshMetrics();
    m.recordJobsScraped('indeed', 0);
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="indeed"[^}]*\}\s+0\b/);
});

test('a >0 scrape sets the gauge, increments the counter, and sets last-nonzero timestamp', async () => {
    const m = freshMetrics();
    m.recordJobsScraped('dice', 7);
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="dice"[^}]*\}\s+7\b/);
    assert.match(text, /scraper_jobs_scraped_total\{[^}]*platform="dice"[^}]*\}\s+7\b/);
    assert.match(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="dice"[^}]*\}\s+\d{10}/);
});

test('a 0 scrape does NOT set last-nonzero timestamp or bump the total counter', async () => {
    const m = freshMetrics();
    m.recordJobsScraped('glassdoor', 0);
    const text = await m.snapshot();
    assert.doesNotMatch(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="glassdoor"/);
    assert.doesNotMatch(text, /scraper_jobs_scraped_total\{[^}]*platform="glassdoor"/);
});

test('noteZeroJobs increments scraper_zero_result_sessions_total per platform', async () => {
    const m = freshMetrics();
    m.noteZeroJobs('indeed');
    m.noteZeroJobs('indeed');
    const text = await m.snapshot();
    assert.match(text, /scraper_zero_result_sessions_total\{[^}]*platform="indeed"[^}]*\}\s+2\b/);
});

test('recordSessionAllFailed increments scraper_sessions_all_failed_total', async () => {
    const m = freshMetrics();
    m.recordSessionAllFailed();
    const text = await m.snapshot();
    assert.match(text, /scraper_sessions_all_failed_total(\{[^}]*\})?\s+1\b/);
});

test('scraper_up help no longer claims to be a health signal', async () => {
    const m = freshMetrics();
    const text = await m.snapshot();
    assert.match(text, /# HELP scraper_up .*liveness/i);
    assert.match(text, /scraper_last_nonzero_scrape_timestamp_seconds/);
});
