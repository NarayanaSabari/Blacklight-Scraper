import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeGlassdoorViaApi } from '../../scrapers/glassdoor-api.js';

// Glassdoor's fast API path hardcoded description: 'N/A' on every listing —
// the backend importer's MIN_DESCRIPTION_LENGTH=50 gate then discarded every
// single Glassdoor job (prod: 444,092 found -> 1,134 imported). Descriptions
// now come from a per-job page fetch (enrichDescriptions, injectable via
// deps.enrichDescriptions) run after all pages of listings are collected.
// These guard that wiring without any network or browser launch.

function listing(id, jobLink = `/job/${id}`) {
    return {
        jobview: {
            header: {
                jobTitleText: `Java Developer ${id}`,
                employerNameFromSearch: 'Acme',
                locationName: 'Austin, TX',
                jobLink,
                ageInDays: 1,
            },
        },
    };
}

function fakeSessionClass(listings) {
    return class FakeSession {
        async get() {
            return { status: 200, headers: { 'set-cookie': ['gdsid=abc; Path=/'] }, text: async () => '<html/>' };
        }
        async post() {
            return {
                status: 200,
                text: async () => JSON.stringify([{ data: { jobListings: { jobListings: listings, paginationCursors: [] } } }]),
            };
        }
        async close() {}
    };
}

function baseDeps(listings, extra = {}) {
    return {
        Session: fakeSessionClass(listings),
        ensureTLS: async () => {},
        getProxyPool: () => ({ acquire: () => null, reportBlocked: () => {}, reportOk: () => {} }),
        ...extra,
    };
}

test('descriptions from enrichDescriptions land on the mapped jobs', async () => {
    const listings = [listing(1), listing(2)];
    const deps = baseDeps(listings, {
        enrichDescriptions: async (raw) => {
            assert.equal(raw.length, 2);
            const m = new Map();
            m.set(0, 'A'.repeat(120));
            // index 1 intentionally left unset
            return m;
        },
    });
    const res = await scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps);
    assert.equal(res.jobs.length, 2);
    assert.equal(res.jobs[0].job.description, 'A'.repeat(120));
    assert.equal(res.jobs[1].job.description, 'N/A');
});

test('enrichment returning an empty map leaves every job at N/A', async () => {
    const listings = [listing(1)];
    const deps = baseDeps(listings, { enrichDescriptions: async () => new Map() });
    const res = await scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps);
    assert.equal(res.jobs.length, 1);
    assert.equal(res.jobs[0].job.description, 'N/A');
});

test('enrichDescriptions throwing does not fail the scrape', async () => {
    const listings = [listing(1)];
    const deps = baseDeps(listings, {
        enrichDescriptions: async () => { throw new Error('browser boom'); },
    });
    const res = await scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps);
    assert.equal(res.jobs.length, 1);
    assert.equal(res.jobs[0].job.description, 'N/A');
});

test('GLASSDOOR_FETCH_DESCRIPTIONS=false skips enrichment entirely', async (t) => {
    const previous = process.env.GLASSDOOR_FETCH_DESCRIPTIONS;
    process.env.GLASSDOOR_FETCH_DESCRIPTIONS = 'false';
    t.after(() => {
        if (previous === undefined) delete process.env.GLASSDOOR_FETCH_DESCRIPTIONS;
        else process.env.GLASSDOOR_FETCH_DESCRIPTIONS = previous;
    });

    let called = false;
    const listings = [listing(1)];
    const deps = baseDeps(listings, {
        enrichDescriptions: async () => { called = true; return new Map([[0, 'should not be used']]); },
    });
    const res = await scrapeGlassdoorViaApi('Java Developer', 'US', null, {}, deps);
    assert.equal(called, false, 'enrichDescriptions must not be invoked when the flag is false');
    assert.equal(res.jobs.length, 1);
    assert.equal(res.jobs[0].job.description, 'N/A');
});
