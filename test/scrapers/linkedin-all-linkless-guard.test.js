import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allLinklessLooksBroken } from '../../scrapers/linkedin.js';

// The silent-drop failure: a healthy batch was extracted but the permalink
// resolver returned nothing for ANY post → 0 importable. That must fail loudly.
test('allLinklessLooksBroken: true when a healthy batch resolves 0 links', () => {
    assert.equal(allLinklessLooksBroken({ extractedCount: 12, importableCount: 0 }), true);
    assert.equal(allLinklessLooksBroken({ extractedCount: 3, importableCount: 0 }), true);
});

test('allLinklessLooksBroken: false when at least one link resolved', () => {
    assert.equal(allLinklessLooksBroken({ extractedCount: 12, importableCount: 1 }), false);
    assert.equal(allLinklessLooksBroken({ extractedCount: 12, importableCount: 12 }), false);
});

test('allLinklessLooksBroken: false for tiny batches (avoid false positives)', () => {
    // below minExtracted (default 3): a genuinely odd 1-2 post empty is not
    // treated as a broken resolver.
    assert.equal(allLinklessLooksBroken({ extractedCount: 0, importableCount: 0 }), false);
    assert.equal(allLinklessLooksBroken({ extractedCount: 1, importableCount: 0 }), false);
    assert.equal(allLinklessLooksBroken({ extractedCount: 2, importableCount: 0 }), false);
});

test('allLinklessLooksBroken: honors a custom minExtracted threshold', () => {
    assert.equal(allLinklessLooksBroken({ extractedCount: 4, importableCount: 0, minExtracted: 5 }), false);
    assert.equal(allLinklessLooksBroken({ extractedCount: 5, importableCount: 0, minExtracted: 5 }), true);
});

test('allLinklessLooksBroken: safe on missing args', () => {
    assert.equal(allLinklessLooksBroken(), false);
    assert.equal(allLinklessLooksBroken({}), false);
});
