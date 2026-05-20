import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLiAt } from '../../scrapers/linkedin.js';

test('hasLiAt: null → false', () => {
    assert.equal(hasLiAt(null), false);
});

test('hasLiAt: undefined → false', () => {
    assert.equal(hasLiAt(undefined), false);
});

test('hasLiAt: non-array → false', () => {
    assert.equal(hasLiAt('not-an-array'), false);
    assert.equal(hasLiAt(42), false);
    assert.equal(hasLiAt({}), false);
});

test('hasLiAt: empty array → false', () => {
    assert.equal(hasLiAt([]), false);
});

test('hasLiAt: jar with no li_at entry → false', () => {
    assert.equal(hasLiAt([
        { name: 'lidc', value: 'b=VB10:s=V:...' },
        { name: 'bcookie', value: 'v=2&abc' },
    ]), false);
});

test('hasLiAt: li_at present but empty value → false', () => {
    assert.equal(hasLiAt([{ name: 'li_at', value: '' }]), false);
});

test('hasLiAt: li_at present but missing value → false', () => {
    assert.equal(hasLiAt([{ name: 'li_at' }]), false);
});

test('hasLiAt: li_at with non-empty value → true', () => {
    assert.equal(hasLiAt([{ name: 'li_at', value: 'AQEDATEAAA...' }]), true);
});

test('hasLiAt: li_at among other cookies → true', () => {
    assert.equal(hasLiAt([
        { name: 'bcookie', value: 'v=2&abc' },
        { name: 'li_at', value: 'AQEDATEAAA...' },
        { name: 'lidc', value: 'b=VB10:s=V:...' },
    ]), true);
});
