import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasImportableUrl } from '../../scrapers/linkedin.js';
import { normalizeJobData } from '../../src/core/normalize.js';

// Regression for the bug that dropped EVERY LinkedIn post since 2f313a3a:
// the import filter checked `p.url`, but normalizeJobData nests the permalink
// at `p.job.url` (coreJob) — so `p.url` is always undefined → all dropped.
// This test exercises the REAL filter path (normalizeJobData → nested url),
// which the existing hasImportableUrl-only test never did.

test('normalizeJobData nests the permalink at job.url (NOT top-level url)', () => {
    const norm = normalizeJobData(
        { title: 'X', company: 'Y', url: 'https://www.linkedin.com/posts/jane_ugcPost-777-ab/' },
        'LinkedIn',
    );
    assert.equal(norm.url, undefined, 'there is no top-level url (this was the bug)');
    assert.equal(norm.job.url, 'https://www.linkedin.com/posts/jane_ugcPost-777-ab/');
});

test('import filter must read p.job.url — a resolved post is importable', () => {
    const norm = normalizeJobData(
        { title: 'X', company: 'Y', url: 'https://www.linkedin.com/posts/jane_ugcPost-777-ab/' },
        'LinkedIn',
    );
    // The production filter predicate:
    assert.equal(hasImportableUrl(norm?.job?.url), true, 'resolved post must be importable');
    // The OLD (buggy) predicate dropped it:
    assert.equal(hasImportableUrl(norm?.url), false, 'p.url was always undefined → all dropped');
});

test('a link-less post (url defaults to N/A) is correctly dropped', () => {
    const norm = normalizeJobData({ title: 'X', company: 'Y' }, 'LinkedIn'); // no url
    assert.equal(norm.job.url, 'N/A');
    assert.equal(hasImportableUrl(norm?.job?.url), false);
});
