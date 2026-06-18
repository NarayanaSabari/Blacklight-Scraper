import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractJobFromStructuredData } from '../../scrapers/dice.js';

const FIXTURE_JSON = JSON.parse(fs.readFileSync(new URL('../fixtures/dice-structured-data.json', import.meta.url), 'utf-8'));

test('extractJobFromStructuredData: fixture yields a valid row', () => {
    const r = extractJobFromStructuredData(FIXTURE_JSON, 'https://www.dice.com/job-detail/abc');
    assert.ok(r, 'should not be null');
    assert.ok(!r.__domChanged, `expected non-sentinel result, got: ${JSON.stringify(r)}`);
    assert.ok(r.title.length > 0);
    assert.ok(r.company.length > 0);
    assert.equal(typeof r.url, 'string');
});

test('extractJobFromStructuredData: missing title → __domChanged sentinel', () => {
    const r = extractJobFromStructuredData({ '@type': 'JobPosting', hiringOrganization: { name: 'X' } }, 'https://x');
    assert.deepEqual(r, { __domChanged: true, reason: 'missing_title' });
});

test('extractJobFromStructuredData: missing hiringOrganization.name → __domChanged sentinel', () => {
    const r = extractJobFromStructuredData({ '@type': 'JobPosting', title: 'Engineer' }, 'https://x');
    assert.deepEqual(r, { __domChanged: true, reason: 'missing_company' });
});

test('extractJobFromStructuredData: TELECOMMUTE → isRemote true', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'Engineer',
        hiringOrganization: { name: 'X' },
        jobLocationType: 'TELECOMMUTE',
    }, 'https://x');
    assert.equal(r.isRemote, true);
});

test('extractJobFromStructuredData: array employmentType collapsed to string', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'Engineer',
        hiringOrganization: { name: 'X' },
        employmentType: ['FULL_TIME', 'PART_TIME'],
    }, 'https://x');
    assert.equal(r.employmentType, 'full_time, part_time');
});

test('extractJobFromStructuredData: identifier.value populates jobId; falls back to URL tail', () => {
    const withId = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
        identifier: { '@type': 'PropertyValue', value: 'uuid-here' },
    }, 'https://www.dice.com/job-detail/xyz');
    assert.equal(withId.jobId, 'uuid-here');

    const noId = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
    }, 'https://www.dice.com/job-detail/url-tail');
    assert.equal(noId.jobId, 'url-tail');
});

test('extractJobFromStructuredData: jobLocation.address parses into city+state', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
        jobLocation: { address: { addressLocality: 'Salt Lake City', addressRegion: 'UT' } },
    }, 'https://x');
    assert.equal(r.city, 'Salt Lake City');
    assert.equal(r.state, 'UT');
    assert.equal(r.locationFormatted, 'Salt Lake City, UT');
});

test('extractJobFromStructuredData: ISO dates parsed to YYYY-MM-DD', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
        datePosted: '2026-05-15T08:30:00Z',
        validThrough: '2026-06-15T08:30:00Z',
    }, 'https://x');
    assert.equal(r.postedDate, '2026-05-15');
    assert.equal(r.validThrough, '2026-06-15');
});
