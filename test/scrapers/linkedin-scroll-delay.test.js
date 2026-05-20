import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextScrollDelay } from '../../scrapers/linkedin.js';

const CFG = { min: 2500, max: 5000, pauseEvery: 6, pauseMin: 8000, pauseMax: 15000 };

test('nextScrollDelay: base delay within [min,max] for non-pause indices', () => {
    assert.equal(nextScrollDelay(1, () => 0, CFG), 2500);
    assert.equal(nextScrollDelay(1, () => 1, CFG), 5000);
    assert.equal(nextScrollDelay(5, () => 0.5, CFG), 3750);
});

test('nextScrollDelay: index 0 is a base delay (never a pause)', () => {
    assert.equal(nextScrollDelay(0, () => 0, CFG), 2500);
});

test('nextScrollDelay: pause at index>0 && index%pauseEvery===0, within [pauseMin,pauseMax]', () => {
    assert.equal(nextScrollDelay(6, () => 0, CFG), 8000);
    assert.equal(nextScrollDelay(12, () => 1, CFG), 15000);
    assert.equal(nextScrollDelay(6, () => 0.5, CFG), 11500);
});

test('nextScrollDelay: pauseEvery<=0 disables pauses; rng default tolerated', () => {
    const c = { ...CFG, pauseEvery: 0 };
    const v = nextScrollDelay(6, undefined, c);
    assert.ok(v >= 2500 && v <= 5000);
});
