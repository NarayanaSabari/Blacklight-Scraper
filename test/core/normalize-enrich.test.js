import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJobData, inferExperienceLevel, parseSalaryText, parseLocationText } from '../../src/core/normalize.js';

test('inferExperienceLevel: title keywords → level (ordered)', () => {
    assert.equal(inferExperienceLevel('Senior Software Engineer'), 'Senior');
    assert.equal(inferExperienceLevel('Sr. Backend Developer'), 'Senior');
    assert.equal(inferExperienceLevel('Principal Engineer'), 'Principal');
    assert.equal(inferExperienceLevel('Staff Data Scientist'), 'Principal');
    assert.equal(inferExperienceLevel('Lead DevOps Engineer'), 'Lead');
    assert.equal(inferExperienceLevel('Engineering Manager'), 'Lead');
    assert.equal(inferExperienceLevel('Junior Developer'), 'Entry');
    assert.equal(inferExperienceLevel('Software Engineer Intern'), 'Internship');
    assert.equal(inferExperienceLevel('Software Engineer'), null);   // no signal
    assert.equal(inferExperienceLevel(null), null);
    // ordering: Principal beats Senior when both could match
    assert.equal(inferExperienceLevel('Senior Staff Engineer'), 'Principal');
});

test('parseSalaryText: structured pay from common formats', () => {
    assert.deepEqual(parseSalaryText('USD 85000–100000 / year'), { min: 85000, max: 100000, currency: 'USD', period: 'year' });
    assert.deepEqual(parseSalaryText('$90,000 - $125,000'), { min: 90000, max: 125000, currency: 'USD', period: null });
    assert.deepEqual(parseSalaryText('$50/hr'), { min: 50, max: null, currency: 'USD', period: 'hour' });
    assert.deepEqual(parseSalaryText('$100k–$130k a year'), { min: 100000, max: 130000, currency: 'USD', period: 'year' });
    assert.deepEqual(parseSalaryText('N/A'), { min: null, max: null, currency: null, period: null });
    // plausibility: an hourly window rejects a stray big number
    const hr = parseSalaryText('$15 - $20 per hour');
    assert.deepEqual([hr.min, hr.max, hr.period], [15, 20, 'hour']);
});

test('parseLocationText: city/state/country from formatted string', () => {
    assert.deepEqual(parseLocationText('Denver, CO 80203'), { city: 'Denver', state: 'CO', country: null });
    assert.deepEqual(parseLocationText('Platteville, WI'), { city: 'Platteville', state: 'WI', country: null });
    assert.deepEqual(parseLocationText('United States'), { city: null, state: null, country: 'United States' });
    assert.deepEqual(parseLocationText('Austin, TX, United States'), { city: 'Austin', state: 'TX', country: 'United States' });
    assert.deepEqual(parseLocationText('N/A'), { city: null, state: null, country: null });
});

test('normalizeJobData: integration — enrichment fills level/city/state/salaryMin', () => {
    const j = normalizeJobData({
        title: 'Senior Backend Engineer',
        company: 'Acme',
        location: 'Denver, CO 80203',
        salary: '$120,000 - $150,000 a year',
        url: 'https://x/y',
    }, 'Indeed');
    assert.equal(j.experience.level, 'Senior');
    assert.equal(j.location.city, 'Denver');
    assert.equal(j.location.state, 'CO');
    assert.equal(j.compensation.salaryMin, 120000);
    assert.equal(j.compensation.salaryMax, 150000);
    assert.equal(j.compensation.period, 'year');
});

test('normalizeJobData: scraper-provided structured data is NOT overridden by parsing', () => {
    const j = normalizeJobData({
        title: 'Engineer', company: 'Acme', location: 'NYC',
        city: 'New York', state: 'NY', country: 'US',
        salary: 'ignore me', salary_min: 100, salary_max: 200, salary_period: 'year',
        url: 'https://x',
    }, 'Dice');
    assert.equal(j.location.city, 'New York');
    assert.equal(j.compensation.salaryMin, 100);
    assert.equal(j.compensation.salaryMax, 200);
});
