import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const FIXTURE = fs.readFileSync(new URL('../fixtures/dice-search.html', import.meta.url), 'utf-8');

function extractJobUrls(htmlString) {
    const dom = new JSDOM(htmlString);
    const doc = dom.window.document;
    // Primary
    const primary = [...doc.querySelectorAll('a[href*="/job-detail/"]')]
        .map((a) => a.href || a.getAttribute('href'))
        .filter(Boolean);
    if (primary.length > 0) return { source: 'primary', urls: [...new Set(primary)] };
    // Backup
    const backup = [...doc.querySelectorAll('[data-testid*="job-card"] a[href*="/job-detail/"]')]
        .map((a) => a.href || a.getAttribute('href'))
        .filter(Boolean);
    return { source: 'backup', urls: [...new Set(backup)] };
}

test('fixture: primary selector finds many job-detail anchors', () => {
    const { source, urls } = extractJobUrls(FIXTURE);
    assert.equal(source, 'primary');
    // Dice cards have ~3 anchors each pointing at the same /job-detail/<uuid>
    // URL (title link, company link, apply link), so the unique-URL count is
    // roughly anchorCount / 3. The fixture has 60 anchors → ~20 unique URLs.
    assert.ok(urls.length >= 15, `expected at least 15 unique URLs, got ${urls.length}`);
    for (const u of urls) {
        assert.match(u, /\/job-detail\//);
    }
});

test('fixture: backup selector also yields hits (free second rail)', () => {
    const dom = new JSDOM(FIXTURE);
    const backupAnchors = dom.window.document.querySelectorAll(
        '[data-testid*="job-card"] a[href*="/job-detail/"]',
    );
    assert.ok(backupAnchors.length > 0,
        `backup selector should also work as a redundancy; got ${backupAnchors.length}`);
});

test('synthetic: empty page → empty urls list', () => {
    const { source, urls } = extractJobUrls('<!doctype html><html><body><p>nothing here</p></body></html>');
    assert.equal(urls.length, 0);
    assert.equal(source, 'backup'); // falls through to backup which is also empty
});
