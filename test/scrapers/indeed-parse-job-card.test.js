import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { parseJobCard } from '../../scrapers/indeed.js';

const FIXTURE = fs.readFileSync(new URL('../fixtures/indeed-card.html', import.meta.url), 'utf-8');

test('parseJobCard: real fixture yields a valid row', () => {
    const $ = cheerio.load(FIXTURE);
    // The card fixture is the inner HTML of one .job_seen_beacon; wrap a parent so cheerio queries work.
    const $card = $('.job_seen_beacon').length ? $('.job_seen_beacon').first() : $.root().children().first();
    const row = parseJobCard($, $card, 'www.indeed.com');
    assert.ok(row, 'should not be null');
    assert.ok(!row.__domChanged, `expected a row, got sentinel: ${JSON.stringify(row)}`);
    assert.ok(row.title && row.title.length > 1, `title: ${JSON.stringify(row.title)}`);
    assert.ok(row.company && row.company.length > 0, `company: ${JSON.stringify(row.company)}`);
    assert.ok(row.jobKey && row.jobKey.length > 0);
    assert.ok(row.url && row.url.startsWith('https://www.indeed.com/viewjob?jk='));
});

test('parseJobCard: card with no data-jk anywhere → null (silent skip — UI artifact)', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><h2>X</h2></div>');
    const card = $('.job_seen_beacon');
    assert.equal(parseJobCard($, card, 'www.indeed.com'), null);
});

test('parseJobCard: card with data-jk but no title → __domChanged sentinel', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><a data-jk="abc"></a></div>');
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.ok(r);
    assert.equal(r.__domChanged, true);
    assert.match(r.reason, /title|company/i);
});

test('parseJobCard: synthetic happy path with all fields', () => {
    const $ = cheerio.load(`
        <div class="job_seen_beacon">
            <a data-jk="job123"><h2 class="jobTitle"><span title="Senior Engineer">Senior Engineer</span></h2></a>
            <span data-testid="company-name">Acme Corp</span>
            <div data-testid="text-location">San Francisco, CA</div>
        </div>
    `);
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.ok(r);
    assert.ok(!r.__domChanged);
    assert.equal(r.jobKey, 'job123');
    assert.equal(r.title, 'Senior Engineer');
    assert.equal(r.company, 'Acme Corp');
    assert.match(r.location, /San Francisco/);
    assert.equal(r.url, 'https://www.indeed.com/viewjob?jk=job123');
});

test('parseJobCard: title from <h2 class="jobTitle"> nested span', () => {
    const $ = cheerio.load(`
        <div class="job_seen_beacon">
            <a data-jk="k1"><h2 class="jobTitle"><span>Lead Cloud Architect</span></h2></a>
            <span data-testid="company-name">CloudCo</span>
        </div>
    `);
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.equal(r.title, 'Lead Cloud Architect');
});

test('parseJobCard: includes isPromoted flag when sponsored attribute present', () => {
    const $ = cheerio.load(`
        <div class="job_seen_beacon" data-empn="999">
            <a data-jk="spons1"><h2 class="jobTitle"><span>Promoted Role</span></h2></a>
            <span data-testid="company-name">SponsCorp</span>
        </div>
    `);
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.equal(r.isPromoted, true);
});
