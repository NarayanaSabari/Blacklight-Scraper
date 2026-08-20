import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, evaluateUrlQuality, URL_QUALITY_MIN_SAMPLE, URL_QUALITY_EMPTY_RATIO_ALERT } from '../../src/core/url-quality.js';

test('classifyUrl: empty / null / undefined → "empty"', () => {
    assert.equal(classifyUrl(''), 'empty');
    assert.equal(classifyUrl(null), 'empty');
    assert.equal(classifyUrl(undefined), 'empty');
});

test('classifyUrl: coreJob\'s "N/A" placeholder counts as missing, not a valid other-url', () => {
    // normalizeJobData's coreJob() (core/normalize.js) defaults an absent url to
    // the literal string 'N/A', never to null/empty. Before this the PERMALINK_RE
    // miss fell through to 'other' - a "real but uninteresting URL" bucket that
    // hid the fact that the scraper produced no url at all.
    assert.equal(classifyUrl('N/A'), 'empty');
});

test('classifyUrl: LinkedIn profile /in/ → "profile_in"', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/in/john-doe'), 'profile_in');
    assert.equal(classifyUrl('https://linkedin.com/in/anyone/'), 'profile_in');
});

test('classifyUrl: LinkedIn feed/update permalink → "permalink"', () => {
    assert.equal(
        classifyUrl('https://www.linkedin.com/feed/update/urn:li:activity:7462490743035731968/'),
        'permalink',
    );
});

test('classifyUrl: LinkedIn /posts/ permalink → "permalink"', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/posts/abc-123/'), 'permalink');
});

test('classifyUrl: Indeed/Dice job pages → "permalink"', () => {
    assert.equal(classifyUrl('https://www.indeed.com/jobs/view/12345'), 'permalink');
});

test('classifyUrl: other valid URLs → "other"', () => {
    assert.equal(classifyUrl('https://example.com/foo'), 'other');
    assert.equal(classifyUrl('https://www.linkedin.com/company/acme'), 'other');
});

test('classifyUrl: non-string coerces safely', () => {
    assert.equal(classifyUrl(42), 'other');
    assert.equal(classifyUrl({}), 'other');
});

// --- evaluateUrlQuality -----------------------------------------------------

test('evaluateUrlQuality: 6148/6148 empty (the 2026-08-20 incident shape) is degraded', () => {
    const qualities = Array(6148).fill('empty');
    const result = evaluateUrlQuality(qualities);
    assert.equal(result.jobCount, 6148);
    assert.equal(result.emptyCount, 6148);
    assert.equal(result.emptyRatio, 1);
    assert.equal(result.degraded, true);
});

test('evaluateUrlQuality: a single empty URL among many is normal, not degraded', () => {
    const qualities = [...Array(19).fill('permalink'), 'empty'];
    const result = evaluateUrlQuality(qualities);
    assert.equal(result.emptyRatio, 0.05);
    assert.equal(result.degraded, false);
});

test('evaluateUrlQuality: below the minimum sample size never trips, even at 100% empty', () => {
    // A narrow role-sweep query can genuinely net a handful of results; one or
    // two missing URLs out of three jobs must not page anyone.
    const qualities = Array(URL_QUALITY_MIN_SAMPLE - 1).fill('empty');
    assert.equal(evaluateUrlQuality(qualities).degraded, false);
});

test('evaluateUrlQuality: crossing the ratio threshold at the minimum sample size trips', () => {
    const emptyCount = Math.ceil(URL_QUALITY_MIN_SAMPLE * URL_QUALITY_EMPTY_RATIO_ALERT);
    const qualities = [
        ...Array(emptyCount).fill('empty'),
        ...Array(URL_QUALITY_MIN_SAMPLE - emptyCount).fill('permalink'),
    ];
    assert.equal(evaluateUrlQuality(qualities).degraded, true);
});

test('evaluateUrlQuality: an empty batch reports zero ratio, not NaN or degraded', () => {
    const result = evaluateUrlQuality([]);
    assert.equal(result.emptyRatio, 0);
    assert.equal(result.degraded, false);
});

