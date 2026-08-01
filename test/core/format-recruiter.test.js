// The `recruiter` field on the wire payload is the drop point for LinkedIn
// contact extraction reaching the backend. Post bodies are attacker-controlled
// public text, so this boundary caps and sanitises rather than trusting the
// scraper's raw extraction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJobForBlacklight } from '../../src/core/format.js';

function job(recruiter) {
    return {
        job: { title: 'SRE', description: 'x'.repeat(80), jobId: 'abc' },
        recruiter,
    };
}

test('formatJobForBlacklight: emits recruiter when contacts exist', () => {
    const wire = formatJobForBlacklight(
        job({ name: 'Jane Doe', profileUrl: 'https://linkedin.com/in/jane', emails: ['jane@x.com'], phones: ['555-123-4567'] }),
        'linkedin',
    );
    assert.deepEqual(wire.recruiter, {
        name: 'Jane Doe',
        profile_url: 'https://linkedin.com/in/jane',
        emails: ['jane@x.com'],
        phones: ['555-123-4567'],
    });
});

test('formatJobForBlacklight: omits the recruiter key entirely when there are no contacts', () => {
    const wire = formatJobForBlacklight(job({ name: 'Jane Doe', profileUrl: null, emails: [], phones: [] }), 'linkedin');
    assert.equal('recruiter' in wire, false);
});

test('formatJobForBlacklight: omits the recruiter key when job.recruiter is absent', () => {
    const wire = formatJobForBlacklight(job(undefined), 'linkedin');
    assert.equal('recruiter' in wire, false);
});

test('formatJobForBlacklight: caps emails and phones at 5 each', () => {
    const emails = Array.from({ length: 12 }, (_, i) => `person${i}@example.com`);
    const phones = Array.from({ length: 12 }, (_, i) => `555-000-${1000 + i}`);
    const wire = formatJobForBlacklight(job({ emails, phones }), 'linkedin');
    assert.equal(wire.recruiter.emails.length, 5);
    assert.equal(wire.recruiter.phones.length, 5);
});

test('formatJobForBlacklight: de-duplicates and lowercases emails', () => {
    const wire = formatJobForBlacklight(
        job({ emails: ['Jane@Example.com', 'jane@example.com', 'JANE@EXAMPLE.COM'], phones: [] }),
        'linkedin',
    );
    assert.deepEqual(wire.recruiter.emails, ['jane@example.com']);
});

test('formatJobForBlacklight: de-duplicates phones without altering case/format', () => {
    const wire = formatJobForBlacklight(
        job({ emails: [], phones: ['555-123-4567', '555-123-4567'] }),
        'linkedin',
    );
    assert.deepEqual(wire.recruiter.phones, ['555-123-4567']);
});

test('formatJobForBlacklight: truncates an oversized contact to 254 chars', () => {
    const huge = 'a'.repeat(300) + '@example.com';
    const wire = formatJobForBlacklight(job({ emails: [huge], phones: [] }), 'linkedin');
    assert.ok(wire.recruiter.emails[0].length <= 254);
});

test('formatJobForBlacklight: drops non-string / empty entries', () => {
    const wire = formatJobForBlacklight(
        job({ emails: ['ok@example.com', '', null, 42], phones: [] }),
        'linkedin',
    );
    assert.deepEqual(wire.recruiter.emails, ['ok@example.com']);
});
