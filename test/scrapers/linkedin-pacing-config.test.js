import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPacingConfig, readMenuPacing } from '../../scrapers/linkedin.js';

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

test('readMenuPacing: all-absent → faster documented defaults', () => {
    assert.deepEqual(readMenuPacing({}), {
        hoverMin: 80, hoverMax: 200,
        openMin: 160, openMax: 380,
        itemMin: 60, itemMax: 150,
        pollTries: 7, pollMin: 60, pollMax: 140,
        closeMin: 70, closeMax: 180,
    });
});

test('readMenuPacing: overrides parsed to ints (dial back for a canary)', () => {
    const c = readMenuPacing({
        LINKEDIN_MENU_HOVER_MIN_MS: '140', LINKEDIN_MENU_HOVER_MAX_MS: '430',
        LINKEDIN_MENU_POLL_TRIES: '12', LINKEDIN_MENU_POLL_MIN_MS: '120', LINKEDIN_MENU_POLL_MAX_MS: '230',
    });
    assert.equal(c.hoverMin, 140);
    assert.equal(c.hoverMax, 430);
    assert.equal(c.pollTries, 12);
    assert.equal(c.pollMin, 120);
});

test('readMenuPacing: garbage → default; pollTries floored at 1', () => {
    const c = readMenuPacing({ LINKEDIN_MENU_HOVER_MIN_MS: 'abc', LINKEDIN_MENU_POLL_TRIES: '0' });
    assert.equal(c.hoverMin, 80);
    assert.equal(c.pollTries, 1, 'pollTries must be >= 1 so the clipboard is read at least once');
});

test('readMenuPacing: defaults to process.env when no arg (smoke, no throw)', () => {
    assert.doesNotThrow(() => readMenuPacing());
});
