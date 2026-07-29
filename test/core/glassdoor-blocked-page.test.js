import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedPage, extractJobDetailsFromHTML } from '../../src/core/glassdoor-jd.js';

// Glassdoor rate-limits job-page fetches per IP and allows roughly one batch
// before answering 429 "Access denied". Verified live 2026-07-28: a fresh IP
// returns 200 with a ~500KB page carrying real JSON-LD (descriptions ~4.2k
// chars); a burned IP returns a ~7.5KB denial page with none. Detecting that is
// what lets the caller abandon the batch and cool the IP instead of spending
// every remaining fetch on an address Glassdoor has already shut out.

test('isBlockedPage: rate-limit and forbidden statuses are blocks', () => {
    assert.equal(isBlockedPage(429, '<html>whatever</html>'), true);
    assert.equal(isBlockedPage(403, '<html>whatever</html>'), true);
});

test('isBlockedPage: recognises the interstitial bodies even on a 200', () => {
    assert.equal(isBlockedPage(200, '<title>Access denied | www.glassdoor.com used Cloudflare</title>'), true);
    assert.equal(isBlockedPage(200, '<title>Security</title>'), true);
    assert.equal(isBlockedPage(200, '<title>Just a moment...</title>'), true);
    assert.equal(isBlockedPage(200, '<title>Attention Required! | Cloudflare</title>'), true);
});

test('isBlockedPage: a real job page is not a block', () => {
    const real = '<html><head><title>Kyndryl hiring Software Engineering Developer</title></head><body>...</body></html>';
    assert.equal(isBlockedPage(200, real), false);
    assert.equal(isBlockedPage(undefined, real), false);
});

test('isBlockedPage: a security-related job title is not a block', () => {
    const real = '<html><head><title>Acme hiring Senior Security Engineer</title></head><body>Job details</body></html>';
    assert.equal(isBlockedPage(200, real), false);
});

test('isBlockedPage: missing/empty input is not treated as a block', () => {
    assert.equal(isBlockedPage(200, ''), false);
    assert.equal(isBlockedPage(200, null), false);
    assert.equal(isBlockedPage(undefined, undefined), false);
});

test('isBlockedPage: only inspects the head of the body, not the whole page', () => {
    // A job description that happens to quote "Access denied" deep in its text
    // must not be mistaken for Cloudflare's denial page.
    const html = `<title>Real Job</title>${'x'.repeat(5000)}Access denied`;
    assert.equal(isBlockedPage(200, html), false);
});

test('extractJobDetailsFromHTML: pulls the description out of JSON-LD', () => {
    const desc = 'We are hiring a Java developer. '.repeat(10);
    const html = `<html><head><title>Acme hiring Java Developer</title>
        <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description: `<p>${desc}</p>` })}</script>
        </head><body></body></html>`;
    const out = extractJobDetailsFromHTML(html);
    assert.ok(out.fullDescription.length >= 50, 'must clear the importer 50-char gate');
    assert.match(out.fullDescription, /hiring a Java developer/);
});

test('extractJobDetailsFromHTML: returns null on a challenge page', () => {
    assert.equal(extractJobDetailsFromHTML('<html><head><title>Just a moment...</title></head></html>'), null);
});
