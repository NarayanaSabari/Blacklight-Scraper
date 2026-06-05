import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from '../../src/core/url-quality.js';

test('classifyUrl: empty / null / undefined → "empty"', () => {
    assert.equal(classifyUrl(''), 'empty');
    assert.equal(classifyUrl(null), 'empty');
    assert.equal(classifyUrl(undefined), 'empty');
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
