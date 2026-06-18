import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppsapiJobs, mapAppsapiJobResult } from '../../scrapers/monster.js';

// Minimal slice of a real Monster appsapi jobResult (schema.org JobPosting shape).
const jobResult = {
    jobId: 'abc-123',
    jobPosting: {
        title: 'DevOps Engineer - TS/SCI',
        url: 'https://www.monster.com/job-openings/devops-x-abc-123',
        description: '<p>Build <b>things</b></p>',
        datePosted: '2026-05-23T03:00:00+00:00',
        hiringOrganization: { name: 'Acme Corp' },
        jobLocation: [{ address: { addressLocality: 'Reston', addressRegion: 'VA', addressCountry: 'US' } }],
    },
    normalizedJobPosting: {
        baseSalary: { currency: 'USD', value: { minValue: 140000, maxValue: 180000, unitText: 'YEAR' } },
    },
};

test('mapAppsapiJobResult: maps title/company/location/url/description/salary', () => {
    const j = mapAppsapiJobResult(jobResult);
    assert.equal(j.job.title, 'DevOps Engineer - TS/SCI');
    assert.equal(j.company.name, 'Acme Corp');
    assert.equal(j.location.formatted, 'Reston, VA');
    assert.match(j.job.url, /devops-x-abc-123/);
    assert.match(j.job.description, /Build things/);  // HTML stripped
    assert.doesNotMatch(j.job.description, /<b>/);
});

test('mapAppsapiJobResult: null when no title; falls back to normalizedJobPosting', () => {
    assert.equal(mapAppsapiJobResult({ jobId: 'x' }), null);
    assert.equal(mapAppsapiJobResult(null), null);
    const onlyNorm = { jobId: 'y', normalizedJobPosting: { title: 'Eng', hiringOrganization: { name: 'B' } } };
    assert.equal(mapAppsapiJobResult(onlyNorm).job.title, 'Eng');
});

test('parseAppsapiJobs: extracts from jobResults; tolerates garbage/empty', () => {
    assert.equal(parseAppsapiJobs(JSON.stringify({ jobResults: [jobResult, jobResult] })).length, 2);
    assert.deepEqual(parseAppsapiJobs('not json'), []);
    assert.deepEqual(parseAppsapiJobs(JSON.stringify({ jobResults: [] })), []);
    assert.deepEqual(parseAppsapiJobs(JSON.stringify({ totalSize: 0 })), []);
});
