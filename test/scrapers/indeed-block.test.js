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

test('block detection helpers are present in the module', () => {
    // STRICT + assertNotBlocked are preserved for legacy compatibility.
    assert.match(SRC, /const\s+STRICT\s*=\s*process\.env\.SCRAPER_STRICT_EMPTY\s*===\s*['"]true['"]/);
    assert.match(SRC, /import\s*\{\s*assertNotBlocked\s*\}\s*from/);
    // New classifier-based block detection is always-on (no STRICT gate).
    assert.match(SRC, /classifyIndeedSearchPage\s*\(/);
    // Cooldown gate fires before browser launch.
    assert.match(SRC, /isOnCooldown\s*\(/);
    assert.match(SRC, /BlockedError/);
});

test('scrapeIndeed returns the {jobs, emptyConfirmed} contract shape', () => {
    // New orchestrator returns {jobs: collectedJobs, emptyConfirmed, partial?}
    // or the plain array on success.
    assert.match(SRC, /return\s*\{\s*jobs:\s*collectedJobs\s*,\s*emptyConfirmed/);
});
