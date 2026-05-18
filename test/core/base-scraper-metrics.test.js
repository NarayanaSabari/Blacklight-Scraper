import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';
import { getMetrics, resetMetricsForTest } from '../../src/metrics/registry.js';
import { resetConfigForTest } from '../../src/config/env.js';

function freshRealRegistry() {
    resetConfigForTest();
    resetMetricsForTest();
    return getMetrics();
}

test('a >0 scrape sets gauge + last-nonzero via the real registry', async () => {
    const m = freshRealRegistry();
    const s = new BaseScraper('indeed', async () => [{ id: 1 }, { id: 2 }], { metrics: m });
    await s.execute('node', 'remote', 'sX');
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="indeed"[^}]*\}\s+2\b/);
    assert.match(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="indeed"/);
});

test('an unconfirmed-empty scrape (default) sets gauge 0 + zero-result counter, NOT last-nonzero', async () => {
    const m = freshRealRegistry();
    const s = new BaseScraper('glassdoor', async () => [], { metrics: m });
    const out = await s.execute('node', 'remote', 'sY');
    assert.deepEqual(out, []);
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="glassdoor"[^}]*\}\s+0\b/);
    assert.match(text, /scraper_zero_result_sessions_total\{[^}]*platform="glassdoor"[^}]*\}\s+1\b/);
    assert.doesNotMatch(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="glassdoor"/);
});

test('a confirmed-empty scrape sets gauge 0 but does NOT increment the zero-result counter', async () => {
    const m = freshRealRegistry();
    const s = new BaseScraper('dice', async () => ({ jobs: [], emptyConfirmed: true }), { metrics: m });
    await s.execute('node', 'remote', 'sZ');
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="dice"[^}]*\}\s+0\b/);
    assert.doesNotMatch(text, /scraper_zero_result_sessions_total\{[^}]*platform="dice"/);
});
