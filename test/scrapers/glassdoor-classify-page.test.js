import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { classifyGlassdoorSearchPage, GLASSDOOR_NO_RESULTS_RE } from '../../scrapers/glassdoor.js';

test('classify: block text wins over everything → soft_blocked', () => {
    const r = classifyGlassdoorSearchPage({ url: 'https://www.glassdoor.com/Job/x', bodyText: 'Help us protect Glassdoor — verify you are human', cardCount: 30, bytes: 900000, noResultsText: false, expectedLocToken: '_IN1' });
    assert.equal(r.state, 'soft_blocked');
});
test('classify: no-results text BEFORE card count (suggested cards on empty pages)', () => {
    const r = classifyGlassdoorSearchPage({ url: 'https://www.glassdoor.co.in/Job/x-SRCH_IL.0,13_IN1_KO14,20.htm', bodyText: 'normal page', cardCount: 5, bytes: 800000, noResultsText: true, expectedLocToken: '_IN1' });
    assert.equal(r.state, 'empty_confirmed');
});
test('classify: geo rewrite detected → geo_redirected', () => {
    const r = classifyGlassdoorSearchPage({ url: 'https://www.glassdoor.co.in/Job/india-software-engineer-jobs-SRCH_IL.0,5_IN115_KO6,23.htm', bodyText: 'jobs', cardCount: 30, bytes: 900000, noResultsText: false, expectedLocToken: '_IN1' });
    assert.equal(r.state, 'geo_redirected');
});
test('classify: pinned URL + cards → results (cosmetic .co.in domain redirect is fine)', () => {
    const r = classifyGlassdoorSearchPage({ url: 'https://www.glassdoor.co.in/Job/united-states-software-engineer-jobs-SRCH_IL.0,13_IN1_KO14,31.htm?fromAge=7&countryRedir', bodyText: 'jobs', cardCount: 30, bytes: 900000, noResultsText: false, expectedLocToken: '_IN1' });
    assert.equal(r.state, 'results');
});
test('classify: big page, 0 cards, no signals → dom_changed', () => {
    const r = classifyGlassdoorSearchPage({ url: 'https://www.glassdoor.com/Job/united-states-x-jobs-SRCH_IL.0,13_IN1_KO14,15.htm', bodyText: 'marketing prose', cardCount: 0, bytes: 500000, noResultsText: false, expectedLocToken: '_IN1' });
    assert.equal(r.state, 'dom_changed');
});
test('classify: tiny page → network_error', () => {
    const r = classifyGlassdoorSearchPage({ url: 'https://www.glassdoor.com/Job/united-states-x-jobs-SRCH_IL.0,13_IN1_KO14,15.htm', bodyText: '', cardCount: 0, bytes: 4000, noResultsText: false, expectedLocToken: '_IN1' });
    assert.equal(r.state, 'network_error');
});
test('GLASSDOOR_NO_RESULTS_RE matches the live no-results fixture body', () => {
    const html = fs.readFileSync(new URL('../fixtures/glassdoor-no-results.html', import.meta.url), 'utf-8');
    const text = cheerio.load(html)('body').text();
    assert.ok(GLASSDOOR_NO_RESULTS_RE.test(text), 'regex must match the captured fixture');
});
