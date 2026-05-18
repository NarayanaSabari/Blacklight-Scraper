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

test('indeedNoResults: false/empty-safe on empty/null/undefined/non-string input', () => {
    assert.equal(indeedNoResults(''), false);
    assert.equal(indeedNoResults(null), false);
    assert.equal(indeedNoResults(undefined), false);
    assert.equal(indeedNoResults(42), false);
    assert.equal(indeedNoResults({}), false);
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scrapers', 'indeed.js'),
    'utf8',
);

test('indeed.js imports assertNotBlocked from the proven block-detection module', () => {
    assert.match(SRC, /import\s*\{\s*assertNotBlocked\s*\}\s*from\s*['"]\.\.\/src\/core\/block-detection\.js['"]/);
});

test('block detection + I13 + I2 are all gated behind SCRAPER_STRICT_EMPTY (merge-inert when off)', () => {
    assert.match(SRC, /const\s+STRICT\s*=\s*process\.env\.SCRAPER_STRICT_EMPTY\s*===\s*['"]true['"]/);
    for (const m of SRC.matchAll(/assertNotBlocked\s*\(/g)) {
        const before = SRC.slice(Math.max(0, m.index - 400), m.index);
        assert.ok(/if\s*\(\s*STRICT\s*\)/.test(before),
            'assertNotBlocked() call is not guarded by `if (STRICT)`');
    }
    assert.match(SRC, /if \(!STRICT\) loginSuccess = true;/);
    assert.match(SRC, /if\s*\(\s*STRICT\s*&&\s*pageNum\s*===\s*0\s*&&\s*!indeedNoResults\(html\)\s*\)/, 'I2 page-0 throw must be STRICT-gated');
});

test('scrapeIndeed returns the {jobs, emptyConfirmed} contract shape', () => {
    assert.match(SRC, /return\s*\{\s*jobs:\s*normalizedJobs\s*,\s*emptyConfirmed/);
});
