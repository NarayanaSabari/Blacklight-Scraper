import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indeedJobUrl } from '../../scrapers/indeed.js';

test('indeedJobUrl: standard US domain + key', () => {
    assert.equal(
        indeedJobUrl('www.indeed.com', 'abc123'),
        'https://www.indeed.com/viewjob?jk=abc123',
    );
});

test('indeedJobUrl: regional domain (in.indeed.com)', () => {
    assert.equal(
        indeedJobUrl('in.indeed.com', 'abc123'),
        'https://in.indeed.com/viewjob?jk=abc123',
    );
});

test('indeedJobUrl: encodes special characters in key', () => {
    assert.equal(
        indeedJobUrl('www.indeed.com', 'abc 123/def'),
        'https://www.indeed.com/viewjob?jk=abc%20123%2Fdef',
    );
});

test('indeedJobUrl: missing key → null', () => {
    assert.equal(indeedJobUrl('www.indeed.com', null), null);
    assert.equal(indeedJobUrl('www.indeed.com', undefined), null);
    assert.equal(indeedJobUrl('www.indeed.com', ''), null);
});

test('indeedJobUrl: missing domain → null', () => {
    assert.equal(indeedJobUrl(null, 'abc'), null);
    assert.equal(indeedJobUrl('', 'abc'), null);
});
