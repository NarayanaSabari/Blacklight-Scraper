import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { extractCardFromElement } from '../../scrapers/monster.js';

const FIXTURE = fs.readFileSync(new URL('../fixtures/monster-card.html', import.meta.url), 'utf-8');

function loadCards() {
    const dom = new JSDOM(`<!doctype html><html><body>${FIXTURE}</body></html>`);
    return [...dom.window.document.querySelectorAll('article[data-testid="JobCard"]')];
}

test('extractCardFromElement: fixture cards yield valid rows', () => {
    const cards = loadCards();
    assert.ok(cards.length >= 2, `expected at least 2 fixture cards, got ${cards.length}`);
    const first = extractCardFromElement(cards[0]);
    assert.ok(first, 'first card should extract');
    assert.equal(typeof first.title, 'string');
    assert.ok(first.title.length > 1, `title should be > 1 char (was: ${JSON.stringify(first.title)})`);
    assert.notEqual(first.title, 'M', 'regression: title must never be the company-badge letter');
    assert.notEqual(first.title, 'P', 'regression: title must never be the company-badge letter');
    assert.ok(first.company.length > 1);
    assert.ok(first.jobId.match(/^[a-f0-9-]{20,}$/), `jobId should be a UUID, got: ${first.jobId}`);
    assert.ok(first.url.startsWith('https://www.monster.com/'), `url: ${first.url}`);
});

test('extractCardFromElement: aria-label missing → __domChanged sentinel', () => {
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard"><button data-job-id="abc"></button></article>`);
    const card = dom.window.document.querySelector('article');
    const result = extractCardFromElement(card);
    assert.deepEqual(result, { __domChanged: true, reason: 'no_aria_label' });
});

test('extractCardFromElement: aria-label without " at " → __domChanged sentinel', () => {
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard"><button data-job-id="abc" aria-label="View job"></button></article>`);
    const card = dom.window.document.querySelector('article');
    const result = extractCardFromElement(card);
    assert.equal(result.__domChanged, true);
    assert.match(result.reason, /aria_label_format/);
});

test('extractCardFromElement: missing data-job-id → null (skip row, do NOT signal dom_changed)', () => {
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard"><button aria-label="Foo at Bar"></button></article>`);
    const card = dom.window.document.querySelector('article');
    assert.equal(extractCardFromElement(card), null);
});

test('extractCardFromElement: real anchor href used in preference', () => {
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard">
        <button data-job-id="aaa" aria-label="X at Y"></button>
        <a href="/job-openings/explicit-href-aaa">Real link</a>
    </article>`);
    const card = dom.window.document.querySelector('article');
    const r = extractCardFromElement(card);
    assert.equal(r.url, 'https://www.monster.com/job-openings/explicit-href-aaa');
});
