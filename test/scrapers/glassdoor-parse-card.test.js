import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { parseGlassdoorCard } from '../../scrapers/glassdoor.js';

const CARD = fs.readFileSync(new URL('../fixtures/glassdoor-card.html', import.meta.url), 'utf-8');

test('parse: real fixture card yields a valid row with absolute link on the serving domain', () => {
    const $ = cheerio.load(CARD);
    const $card = $('.jobCard').length ? $('.jobCard').first() : $.root().children().first();
    const row = parseGlassdoorCard($, $card, 'https://www.glassdoor.co.in/Job/x.htm');
    assert.ok(row && !row.__domChanged, JSON.stringify(row).slice(0, 200));
    assert.ok(row.jobTitle.length > 1);
    assert.ok(row.jobLink.startsWith('https://www.glassdoor.co.in/'), row.jobLink);
});
test('parse: link resolves against the page base, NOT hardcoded .co.in', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-title" id="job-title-123">Engineer</a><a data-test="job-link" href="/job-listing/x.htm"></a><span data-test="job-employer">Acme</span></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/Job/y.htm');
    assert.equal(row.jobLink, 'https://www.glassdoor.com/job-listing/x.htm');
});
test('parse: missing title → __domChanged sentinel', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-link" href="/job-listing/x.htm"></a></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/');
    assert.equal(row.__domChanged, true);
    assert.match(row.reason, /title/i);
});
test('parse: no link and no jobId → __domChanged sentinel', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-title">Engineer</a></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/');
    assert.equal(row.__domChanged, true);
});
test('parse: rating/salary/easyApply are best-effort (absent → defaults, no sentinel)', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-title" id="job-title-9">E</a><a data-test="job-link" href="/job-listing/z.htm"></a><span data-test="job-employer">Co</span></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/');
    assert.ok(!row.__domChanged);
    assert.equal(row.companyRating, null);
    assert.equal(row.easyApply, false);
});
