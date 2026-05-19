import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSessionQuery } from '../../scrapers/linkedin.js';

test('pickSessionQuery: null / non-array / empty → null', () => {
    assert.equal(pickSessionQuery(null), null);
    assert.equal(pickSessionQuery(undefined), null);
    assert.equal(pickSessionQuery('nope'), null);
    assert.equal(pickSessionQuery([]), null);
});

test('pickSessionQuery: single element → that element', () => {
    assert.equal(pickSessionQuery(['only']), 'only');
});

test('pickSessionQuery: uniform pick via injected rng (no out-of-bounds)', () => {
    const q = ['a', 'b', 'c'];
    assert.equal(pickSessionQuery(q, () => 0), 'a');
    assert.equal(pickSessionQuery(q, () => 0.5), 'b');
    assert.equal(pickSessionQuery(q, () => 0.999), 'c');
    assert.equal(pickSessionQuery(q, () => 1), 'c');
});

test('pickSessionQuery: does not mutate the input array', () => {
    const q = ['a', 'b'];
    pickSessionQuery(q, () => 0.7);
    assert.deepEqual(q, ['a', 'b']);
});
