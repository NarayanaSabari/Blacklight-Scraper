import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { classifyTechFetchListPage, TECHFETCH_NO_RESULTS_RE } from '../../scrapers/techfetch.js';

test('classify: login redirect → auth_required', () => {
    const r = classifyTechFetchListPage({ url: 'https://www.techfetch.com/js/js_login.aspx?ReturnUrl=x', rowCount: 0, hasLoadJobsFn: false, bodyText: 'Sign in', bytes: 40000 });
    assert.equal(r.state, 'auth_required');
});
test('classify: rows present → results', () => {
    const r = classifyTechFetchListPage({ url: 'https://www.techfetch.com/js/js_job_list.aspx', rowCount: 20, hasLoadJobsFn: true, bodyText: 'java developer jobs', bytes: 400000 });
    assert.equal(r.state, 'results');
});
test('classify: zero rows + "NO matched jobs found" → empty_confirmed (live phrase)', () => {
    const r = classifyTechFetchListPage({ url: 'https://www.techfetch.com/js/js_job_list.aspx', rowCount: 0, hasLoadJobsFn: true, bodyText: 'Matched Jobs NO matched jobs found. Click here for a custom search.', bytes: 200000 });
    assert.equal(r.state, 'empty_confirmed');
});
test('classify: zero rows + generic "No jobs found" → empty_confirmed', () => {
    const r = classifyTechFetchListPage({ url: 'https://www.techfetch.com/js/js_job_list.aspx', rowCount: 0, hasLoadJobsFn: true, bodyText: 'No jobs found for your search', bytes: 200000 });
    assert.equal(r.state, 'empty_confirmed');
});
test('classify: shell rendered (LoadJobs fn present) but 0 rows, no empty text → dom_changed', () => {
    const r = classifyTechFetchListPage({ url: 'https://www.techfetch.com/js/js_job_list.aspx', rowCount: 0, hasLoadJobsFn: true, bodyText: 'something unexpected', bytes: 300000 });
    assert.equal(r.state, 'dom_changed');
});
test('classify: tiny page, no shell → network_error', () => {
    const r = classifyTechFetchListPage({ url: 'https://www.techfetch.com/js/js_job_list.aspx', rowCount: 0, hasLoadJobsFn: false, bodyText: '', bytes: 3000 });
    assert.equal(r.state, 'network_error');
});
test('TECHFETCH_NO_RESULTS_RE matches the live no-results fixture', () => {
    const html = fs.readFileSync(new URL('../fixtures/techfetch-no-results.html', import.meta.url), 'utf-8');
    const text = new JSDOM(html).window.document.body.textContent;
    assert.ok(TECHFETCH_NO_RESULTS_RE.test(text));
});
