import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('alerts.yml declares the silent-block alert set and references real metrics', () => {
    const y = readFileSync(join(root, 'observability', 'alerts.yml'), 'utf8');
    for (const name of [
        'ScraperZeroResultRatioHigh',
        'ScraperNoNonzeroScrape',
        'ScraperBlockedFailures',
        'ScraperAllFailedSessions',
    ]) {
        assert.ok(y.includes(name), `missing alert: ${name}`);
    }
    for (const metric of [
        'scraper_zero_result_sessions_total',
        'scraper_sessions_total',
        'scraper_last_nonzero_scrape_timestamp_seconds',
        'scraper_failures_total',
        'scraper_sessions_all_failed_total',
    ]) {
        assert.ok(y.includes(metric), `alert rules never reference ${metric}`);
    }
});

test('dashboard.json is valid JSON and targets the new metrics', () => {
    const raw = readFileSync(join(root, 'observability', 'dashboard.json'), 'utf8');
    const dash = JSON.parse(raw);
    assert.ok(Array.isArray(dash.panels) && dash.panels.length >= 3);
    const blob = JSON.stringify(dash);
    for (const metric of [
        'scraper_jobs_last_scraped',
        'scraper_last_nonzero_scrape_timestamp_seconds',
        'scraper_zero_result_sessions_total',
    ]) {
        assert.ok(blob.includes(metric), `dashboard never references ${metric}`);
    }
});

test('observability README states heartbeat is not scrape health', () => {
    const r = readFileSync(join(root, 'observability', 'README.md'), 'utf8');
    assert.match(r, /heartbeat/i);
    assert.match(r, /not.*scrape health|scrape health.*not/i);
});
