import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMetrics, resetMetricsForTest } from '../../src/metrics/registry.js';

beforeEach(() => resetMetricsForTest());

test('recordUrlQuality: increments the counter with platform + quality labels', async () => {
    const m = getMetrics();
    m.recordUrlQuality('linkedin', 'permalink');
    m.recordUrlQuality('linkedin', 'permalink');
    m.recordUrlQuality('linkedin', 'empty');
    m.recordUrlQuality('indeed', 'permalink');
    const text = await m.snapshot();
    assert.match(text, /scraper_url_quality_total\{[^}]*platform="linkedin"[^}]*quality="permalink"[^}]*\} 2/);
    assert.match(text, /scraper_url_quality_total\{[^}]*platform="linkedin"[^}]*quality="empty"[^}]*\} 1/);
    assert.match(text, /scraper_url_quality_total\{[^}]*platform="indeed"[^}]*quality="permalink"[^}]*\} 1/);
});

test('recordUrlQuality: bad label values do not throw (safety wrap)', () => {
    const m = getMetrics();
    assert.doesNotThrow(() => m.recordUrlQuality(undefined, undefined));
});

test('recordBuildInfo: sets the gauge with all label tuple values', async () => {
    const m = getMetrics();
    m.recordBuildInfo({
        nodeVersion: 'v24.5.0', gitSha: 'abc1234', pkgVersion: '2.0.0',
        headless: false, strict: true,
    });
    const text = await m.snapshot();
    assert.match(
        text,
        /scraper_build_info\{[^}]*node_version="v24\.5\.0"[^}]*git_sha="abc1234"[^}]*pkg_version="2\.0\.0"[^}]*headless="false"[^}]*strict="true"[^}]*\} 1/,
    );
});
