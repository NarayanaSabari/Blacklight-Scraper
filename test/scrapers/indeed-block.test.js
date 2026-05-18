import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indeedNoResults } from '../../scrapers/indeed.js';

test('indeedNoResults: true on a real Indeed "no results" page', () => {
    const html = `<html><body><div class="jobsearch-NoResult-messageContainer">
      <h1>The search <b>quant developer</b> did not match any jobs</h1></div></body></html>`;
    assert.equal(indeedNoResults(html), true);
});

test('indeedNoResults: true on the alternate "0 jobs" phrasing', () => {
    const html = `<html><body><div>did not match any jobs. Try a different search.</div></body></html>`;
    assert.equal(indeedNoResults(html), true);
});

test('indeedNoResults: false on a results page', () => {
    const html = `<html><body><div class="job_seen_beacon" data-jk="abc">A job</div></body></html>`;
    assert.equal(indeedNoResults(html), false);
});

test('indeedNoResults: false on a Cloudflare challenge page (NOT a confirmed empty)', () => {
    const html = `<html><head><title>Just a moment...</title></head><body>
      <div id="challenge-platform"></div></body></html>`;
    assert.equal(indeedNoResults(html), false);
});

test('indeedNoResults: false/empty-safe on empty or junk input', () => {
    assert.equal(indeedNoResults(''), false);
    assert.equal(indeedNoResults(null), false);
});
