import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPacingConfig } from '../../scrapers/linkedin.js';

test('readPacingConfig: all-absent → documented defaults', () => {
    assert.deepEqual(readPacingConfig({}), {
        maxScrolls: 60,
        noProgressStop: 4,
        scrollPacing: { min: 2500, max: 5000, pauseEvery: 6, pauseMin: 8000, pauseMax: 15000 },
    });
});

test('readPacingConfig: valid overrides parsed to ints', () => {
    const c = readPacingConfig({
        LINKEDIN_MAX_SCROLLS: '90', LINKEDIN_NOPROGRESS_STOP: '3',
        LINKEDIN_SCROLL_MIN_MS: '3000', LINKEDIN_SCROLL_MAX_MS: '7000',
        LINKEDIN_SCROLL_PAUSE_EVERY: '5', LINKEDIN_SCROLL_PAUSE_MIN_MS: '9000',
        LINKEDIN_SCROLL_PAUSE_MAX_MS: '20000',
    });
    assert.deepEqual(c, {
        maxScrolls: 90, noProgressStop: 3,
        scrollPacing: { min: 3000, max: 7000, pauseEvery: 5, pauseMin: 9000, pauseMax: 20000 },
    });
});

test('readPacingConfig: garbage/empty → default, never throws', () => {
    const c = readPacingConfig({ LINKEDIN_MAX_SCROLLS: 'abc', LINKEDIN_SCROLL_MIN_MS: '' });
    assert.equal(c.maxScrolls, 60);
    assert.equal(c.scrollPacing.min, 2500);
});

test('readPacingConfig: defaults to process.env when no arg (smoke, no throw)', () => {
    assert.doesNotThrow(() => readPacingConfig());
});
