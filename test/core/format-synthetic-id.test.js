// SCR-7 (#390): the synthetic dedup key must be STABLE and CROSS-LANGUAGE.
//
// The old fallback was `${platform}-${Date.now()}-${Math.random()}`, so the same
// posting got a fresh key on every cycle and re-inserted forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syntheticExternalId, formatJobForBlacklight } from '../../src/core/format.js';

test('the same content yields the same key across calls', () => {
    const a = syntheticExternalId('indeed', { title: 'SRE', company: 'Acme', location: 'Austin' });
    const b = syntheticExternalId('indeed', { title: 'SRE', company: 'Acme', location: 'Austin' });
    assert.equal(a, b, 'an unstable key re-inserts the same posting every cycle');
    assert.match(a, /^syn-[0-9a-f]{16}$/);
});

test('normalisation: case and whitespace differences do not change the key', () => {
    // Two scrapes of one posting routinely differ in exactly these ways.
    assert.equal(
        syntheticExternalId('indeed', { title: 'Senior  SRE', company: 'ACME', location: 'Austin, TX' }),
        syntheticExternalId('indeed', { title: ' senior sre ', company: 'acme', location: 'austin, tx' }),
    );
});

test('different postings get different keys', () => {
    const base = { title: 'SRE', company: 'Acme', location: 'Austin' };
    const key = syntheticExternalId('indeed', base);
    assert.notEqual(key, syntheticExternalId('indeed', { ...base, title: 'SRE II' }));
    assert.notEqual(key, syntheticExternalId('indeed', { ...base, company: 'Other' }));
    assert.notEqual(key, syntheticExternalId('indeed', { ...base, location: 'Dallas' }));
    assert.notEqual(key, syntheticExternalId('dice', base), 'platform participates');
});

test('CROSS-LANGUAGE CONTRACT: these values must match the Python side exactly', () => {
    // MATCHED PAIR with _synthetic_external_id in
    // server/app/inngest/functions/job_import.py. Verified equal by running both.
    // If this test fails after a change to either implementation, the scraper and
    // the importer will mint DIFFERENT keys for one posting and it will insert
    // twice instead of deduping — change both sides together or not at all.
    assert.equal(
        syntheticExternalId('indeed', {
            title: 'Senior Python Developer', company: 'Acme Corp', location: 'Austin, TX',
        }),
        'syn-19dd5ba601bb5dd5',
    );
    assert.equal(
        syntheticExternalId('monster', {
            title: 'Café Manager — Ünïcode', company: 'Ünï', location: 'Zürich',
        }),
        'syn-e5d78876fb920584',
        'utf-8 must be hashed identically in both languages',
    );
    assert.equal(
        syntheticExternalId('dice', { title: 'DevOps', company: null, location: undefined }),
        'syn-647fc13f55761891',
        'null/undefined must normalise to the empty string, as Python None does',
    );
});

test('the NESTED job schema hashes real strings, not "[object Object]"', () => {
    // Regression guard: computing the id before extraction meant `job.company`
    // was an OBJECT, so every posting hashed to one key — worse than random ids.
    const nested = (company, location) => formatJobForBlacklight({
        job: { title: 'SRE', description: 'x'.repeat(80) },   // no id, no url
        company: { name: company },
        location: { formatted: location },
    }, 'indeed');

    const a = nested('Acme', 'Austin');
    const b = nested('Other', 'Dallas');
    assert.match(a.platform_job_id, /^syn-/);
    assert.notEqual(
        a.platform_job_id, b.platform_job_id,
        'different companies/locations must not collide into one key',
    );
    assert.equal(
        a.platform_job_id,
        syntheticExternalId('indeed', { title: 'SRE', company: 'Acme', location: 'Austin' }),
        'must hash the EXTRACTED values',
    );
});

test('a real platform id or url still wins over the synthetic fallback', () => {
    const withId = formatJobForBlacklight({ jobId: 'abc123', title: 'SRE' }, 'indeed');
    assert.equal(withId.platform_job_id, 'abc123');
    const withUrl = formatJobForBlacklight({ title: 'SRE', url: 'https://x/y' }, 'indeed');
    assert.match(withUrl.platform_job_id, /^h/, 'url hash, not the content hash');
});
