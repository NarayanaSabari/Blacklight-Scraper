import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintSeedFor } from '../../scrapers/linkedin.js';

test('fingerprintSeedFor: deterministic per profileKey, in [10000,99999]', () => {
    const a = fingerprintSeedFor('li-acct-1');
    assert.equal(a, fingerprintSeedFor('li-acct-1'), 'same key → same seed');
    assert.ok(a >= 10000 && a <= 99999, `seed in range, got ${a}`);
    assert.notEqual(fingerprintSeedFor('li-acct-1'), fingerprintSeedFor('li-acct-2'));
});

test('fingerprintSeedFor: null/empty → stable default seed in range', () => {
    const d = fingerprintSeedFor(null);
    assert.equal(d, fingerprintSeedFor(null));
    assert.ok(d >= 10000 && d <= 99999);
});
