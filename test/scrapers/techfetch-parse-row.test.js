import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseTechFetchRow } from '../../scrapers/techfetch.js';

const CARD = fs.readFileSync(new URL('../fixtures/techfetch-card.html', import.meta.url), 'utf-8');

function rowFromHtml(html) {
    const dom = new JSDOM(html);
    return dom.window.document.querySelector('[id*="_divJob"]') ?? dom.window.document.body.firstElementChild;
}

test('parse: real fixture row yields valid job', () => {
    const r = parseTechFetchRow(rowFromHtml(CARD));
    assert.ok(r && !r.__domChanged, JSON.stringify(r)?.slice(0, 200));
    assert.ok(r.jobTitle.length > 3);
    assert.ok(r.jobLink.startsWith('https://www.techfetch.com/job-description/'));
    assert.ok(!/utm_/.test(r.jobLink), 'utm params must be stripped');
});
test('parse: row without title span → __domChanged sentinel', () => {
    const r = parseTechFetchRow(rowFromHtml('<div id="ctl09_divJob"><span>no title here</span></div>'));
    assert.equal(r.__domChanged, true);
    assert.match(r.reason, /title/i);
});
test('parse: title span without anchor → __domChanged sentinel', () => {
    const r = parseTechFetchRow(rowFromHtml('<div id="ctl09_divJob"><span id="ctl09_lblTitle">Plain text</span></div>'));
    assert.equal(r.__domChanged, true);
});
test('parse: synthetic full row', () => {
    const html = `<div id="ctl09_divJob">
        <div id="ctl09_jllogo"><a href="/job-openings/acme.com"><img alt="acme.com"></a></div>
        <span id="ctl09_lblTitle"><a href="/job-description/java-dev-austin-tx-j123&aid=x&utm_source=y">Java Dev</a></span>
        <span id="ctl09_lblLocation">Austin, TX</span>
        <span id="ctl09_lblRate">$60/hr</span>
    </div>`;
    const r = parseTechFetchRow(rowFromHtml(html));
    assert.equal(r.jobTitle, 'Java Dev');
    assert.equal(r.jobLink, 'https://www.techfetch.com/job-description/java-dev-austin-tx-j123&aid=x');
    assert.equal(r.company, 'acme.com');
    assert.equal(r.location, 'Austin, TX');
    assert.equal(r.rate, '$60/hr');
});
test('parse: company falls back to _lblPostedBy when there is no logo (live: ~40% of cards)', () => {
    const html = `<div id="ctl09_divJob">
        <span id="ctl09_lblTitle"><a href="/job-description/java-dev-x-j9">Java Dev</a></span>
        <span id="ctl09_lblPostedBy">Redsun Solutions LLC</span>
    </div>`;
    const r = parseTechFetchRow(rowFromHtml(html));
    assert.ok(!r.__domChanged);
    assert.equal(r.company, 'Redsun Solutions LLC');
});
