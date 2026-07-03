import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingAgeDays, isFreshListing } from '../../scrapers/glassdoor-api.js';

const mk = (age) => ({ jobview: { header: { jobTitleText: 'X', ageInDays: age } } });

// Glassdoor is queried with fromage:null (no server-side date filter); ~79% of
// what it returns for most roles is older than the 7-day import cutoff and was
// being shipped only to be dropped as "too_old" downstream. These guard the
// source-side recency filter that stops that waste.

test('listingAgeDays: reads header.ageInDays, null when missing/non-numeric', () => {
    assert.equal(listingAgeDays(mk(3)), 3);
    assert.equal(listingAgeDays(mk(0)), 0);
    assert.equal(listingAgeDays({ jobview: { header: {} } }), null);
    assert.equal(listingAgeDays({}), null);
    assert.equal(listingAgeDays(null), null);
});

test('isFreshListing: keeps <= cutoff, drops older', () => {
    assert.equal(isFreshListing(mk(0), 7), true);
    assert.equal(isFreshListing(mk(7), 7), true);   // boundary inclusive
    assert.equal(isFreshListing(mk(8), 7), false);
    assert.equal(isFreshListing(mk(400), 7), false);
});

test('isFreshListing: unknown age is kept (never over-drop on missing data)', () => {
    assert.equal(isFreshListing({ jobview: { header: {} } }, 7), true);
    assert.equal(isFreshListing(null, 7), true);
});
