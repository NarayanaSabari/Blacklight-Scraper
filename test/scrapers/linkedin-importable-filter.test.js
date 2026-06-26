import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasImportableUrl, confirmedEmptyAfterLinkFilter } from '../../scrapers/linkedin.js';

// LinkedIn-only import policy: a post we could NOT resolve a permalink for is
// not importable. The scraper must drop it rather than ship a link-less job.
// `hasImportableUrl` is the predicate that decides "does this row carry a real
// source link?" — applied to each normalized post's `url` field.

test('hasImportableUrl: true for a real post permalink', () => {
    assert.equal(
        hasImportableUrl('https://www.linkedin.com/feed/update/urn:li:activity:123/'),
        true,
    );
    assert.equal(
        hasImportableUrl('https://www.linkedin.com/posts/jane-doe-activity-999-abcd'),
        true,
    );
});

test('hasImportableUrl: false for empty string (the link-less case)', () => {
    assert.equal(hasImportableUrl(''), false);
});

test('hasImportableUrl: false for the "N/A" normalize.js placeholder', () => {
    // normalizeJobData defaults a missing url to the literal 'N/A'.
    assert.equal(hasImportableUrl('N/A'), false);
});

test('hasImportableUrl: false for whitespace / nullish / non-string', () => {
    assert.equal(hasImportableUrl('   '), false);
    assert.equal(hasImportableUrl(null), false);
    assert.equal(hasImportableUrl(undefined), false);
    assert.equal(hasImportableUrl(42), false);
    assert.equal(hasImportableUrl({}), false);
});

test('hasImportableUrl: false for a scheme-less fragment (not a full link)', () => {
    assert.equal(hasImportableUrl('linkedin.com/feed/update/urn:li:activity:7/'), false);
    assert.equal(hasImportableUrl('/feed/update/urn:li:activity:7/'), false);
});

// confirmedEmptyAfterLinkFilter preserves BaseScraper's block-detection: a 0-job
// return with emptyConfirmed=false is treated as a SUSPECTED BLOCK (cooldown).
// When the link-filter empties a batch that DID extract real posts, that is NOT
// a block — we must signal confirmed-empty so no spurious cooldown fires.

test('confirmedEmptyAfterLinkFilter: false when there are importable jobs', () => {
    assert.equal(
        confirmedEmptyAfterLinkFilter({ importableCount: 3, extractedCount: 5, pageConfirmedEmpty: false }),
        false,
    );
});

test('confirmedEmptyAfterLinkFilter: true when posts were extracted but all link-less', () => {
    // We saw 5 real posts; all 5 lacked a resolvable permalink → 0 importable.
    // This is a clean empty, NOT a block.
    assert.equal(
        confirmedEmptyAfterLinkFilter({ importableCount: 0, extractedCount: 5, pageConfirmedEmpty: false }),
        true,
    );
});

test('confirmedEmptyAfterLinkFilter: true on a genuine page-confirmed no-results', () => {
    assert.equal(
        confirmedEmptyAfterLinkFilter({ importableCount: 0, extractedCount: 0, pageConfirmedEmpty: true }),
        true,
    );
});

test('confirmedEmptyAfterLinkFilter: false on 0 extracted with no confirmed-empty signal (possible block)', () => {
    assert.equal(
        confirmedEmptyAfterLinkFilter({ importableCount: 0, extractedCount: 0, pageConfirmedEmpty: false }),
        false,
    );
});
