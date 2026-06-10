# Indeed Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift `scrapers/indeed.js` to the Monster+Dice robustness pattern — typed errors, page-state classifier (with Indeed-specific `auth_required` state), file-backed Cloudflare cooldown, fixture-driven tests, debug harness — while flipping the existing `SCRAPER_STRICT_EMPTY` default from off to on.

**Architecture:** Four new pure helpers in `scrapers/indeed.js` (`extractJobKey`, `indeedJobUrl`, `parseJobCard`, `classifyIndeedSearchPage`), one new module `src/core/indeed-cooldown.js` (mirror of `monster-cooldown.js`), an orchestrator rewrite that drops the silent anonymous-fallback and routes failures through typed errors + partial-result returns, a registry flip to `{strictEmpty: true}`, and a debug harness. Existing pieces preserved: `indeedNoResults`, `buildSearchUrl`, `loadCookies`, `getIndeedDomain`, Cloudflare-passing tuning (humanize:true, no warmup, waitUntil:'load' + 10s grace), credential lease, per-job detail extraction.

**Tech Stack:** Node 24 + ESM + `node:test` + `node:assert/strict` + `cheerio` (already in deps) + `jsdom` (already in deps) + CloakBrowser (already in deps). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-10-indeed-hardening-design.md`

---

## Constraints (read before starting)

1. **`scrapers/linkedin.js`, `scrapers/monster.js`, `scrapers/dice.js` MUST NOT be modified** (different platforms; sanity guard).
2. **Pre-existing dirty files MUST stay unstaged:** `.gitignore`, `pnpm-lock.yaml`, `.claude/`, `node_modules/`. Stage files by name; never `git add .` / `git add -A` / `git commit -a`.
3. **No new dependencies.** Everything uses existing in-repo modules + `node:fs`/`node:os`/`node:path`/`cheerio`/`jsdom`/`cloakbrowser`.
4. **Tests:** use `node:test` + `node:assert/strict`. Run with `node --test 'test/**/*.test.js'` (quoted glob — bare-dir broken on Node 24 per repo MEMORY).
5. **Every commit ends with** `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
6. **Never echo secrets** (API keys, cookie values, passwords).
7. **Live network calls only inside the probe + debug harness** — unit tests must not hit indeed.com.
8. **Stage explicitly per task** — do not commit unrelated work.
9. **Working directory:** `/Users/sabari/Developer/freelancing/Blacklight-Scraper` (main repo root, on branch `emdash/indeed-hardening`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scrapers/indeed.js` | **modify (large)** | Add 4 pure helpers (`extractJobKey`, `indeedJobUrl`, `parseJobCard`, `classifyIndeedSearchPage`); rewrite `scrapeIndeed` orchestrator (cooldown gate, drop anonymous fallback → `AuthError`, classifier-driven pagination, partial-result, marker writes). Preserve existing helpers (`buildSearchUrl`, `getIndeedDomain`, `loadCookies`, `humanDelay`, `parseExpiry`, `closePopups`, `indeedNoResults`, `extractJobDetails`, `extractJobDetailsInParallel`). |
| `src/core/indeed-cooldown.js` | **new** | Mirror of `src/core/monster-cooldown.js`. `~/.blacklight-indeed-cooldown` marker, 60-min default, `INDEED_BLOCK_COOLDOWN_MIN` env override. |
| `src/scrapers/registry.js` | **modify** | `indeed` entry gets `{strictEmpty: true}` options arg. |
| `scripts/test-indeed-scrape.js` | **new** | Debug harness mirroring `scripts/test-monster-scrape.js`. |
| `package.json` | **modify** | Add `"indeed:test-scrape": "node scripts/test-indeed-scrape.js"`. |
| `test/fixtures/indeed-search.html` | **new** | Saved real search page from `/tmp/indeed-search.html`. |
| `test/fixtures/indeed-no-results.html` | **new** | Saved real no-results page from `/tmp/indeed-no-results.html`. |
| `test/fixtures/indeed-card.html` | **new** | Saved real `.job_seen_beacon` HTML from `/tmp/indeed-card.html`. |
| `test/scrapers/indeed-extract-job-key.test.js` | **new** | Pure tests for `extractJobKey($card)`. |
| `test/scrapers/indeed-job-url.test.js` | **new** | Pure tests for `indeedJobUrl(domain, key)`. |
| `test/scrapers/indeed-parse-job-card.test.js` | **new** | Fixture-driven tests for `parseJobCard($card, domain)`. |
| `test/scrapers/indeed-classify-page.test.js` | **new** | Pure tests for `classifyIndeedSearchPage`. |
| `test/scrapers/indeed-block.test.js` | **keep** | Existing `indeedNoResults` tests. |
| `test/core/indeed-cooldown.test.js` | **new** | Mirror of `monster-cooldown.test.js`. |

---

## Task 1: Save fixtures

**Files:**
- Create: `test/fixtures/indeed-search.html` (from `/tmp/indeed-search.html`)
- Create: `test/fixtures/indeed-no-results.html` (from `/tmp/indeed-no-results.html`)
- Create: `test/fixtures/indeed-card.html` (from `/tmp/indeed-card.html`)

- [ ] **Step 1: Confirm source files exist**

```bash
ls -la /tmp/indeed-search.html /tmp/indeed-no-results.html /tmp/indeed-card.html
```

Expected: all three files exist, non-zero size. The search page is ~1.7 MB; the no-results page is ~smaller; the card is ~3 KB.

If any is missing (e.g. system rebooted), regenerate with `node scripts/indeed-deep-probe.mjs` first (~3 min — writes all three).

- [ ] **Step 2: Copy the three fixtures**

```bash
mkdir -p test/fixtures
cp /tmp/indeed-search.html test/fixtures/indeed-search.html
cp /tmp/indeed-no-results.html test/fixtures/indeed-no-results.html
cp /tmp/indeed-card.html test/fixtures/indeed-card.html
```

- [ ] **Step 3: Verify fixture shapes**

```bash
echo "search page card counts:"
node -e 'import("jsdom").then(({ JSDOM }) => { const fs = require("fs"); const html = fs.readFileSync("test/fixtures/indeed-search.html", "utf-8"); const doc = new JSDOM(html).window.document; console.log("  .job_seen_beacon:", doc.querySelectorAll(".job_seen_beacon").length); console.log("  a[data-jk]      :", doc.querySelectorAll("a[data-jk]").length); console.log("  [data-jk]       :", doc.querySelectorAll("[data-jk]").length); });'
echo "no-results signals:"
node -e 'const fs = require("fs"); const html = fs.readFileSync("test/fixtures/indeed-no-results.html", "utf-8"); console.log("  jobsearch-NoResult class :", html.includes("jobsearch-NoResult")); console.log("  did not match phrase     :", /did not match any jobs/i.test(html));'
echo "card fixture has data-jk?"
node -e 'const html = require("fs").readFileSync("test/fixtures/indeed-card.html", "utf-8"); const m = html.match(/data-jk=["\x27]([^"\x27]+)/); console.log("  found:", m ? m[1] : "no");'
```

Expected:
- Search page `.job_seen_beacon` ≥ 14
- `a[data-jk]` ≥ 20
- No-results fixture has both `jobsearch-NoResult` class AND the "did not match" phrase
- Card fixture has at least one `data-jk` attribute

If any of these don't match, the probe captured a non-representative page — re-run the probe.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/indeed-search.html test/fixtures/indeed-no-results.html test/fixtures/indeed-card.html
git commit -m "$(cat <<'EOF'
test(indeed): commit live search + no-results + card fixtures

Saved from the deep probe at /tmp/indeed-*. Used as the ground-truth
fixtures for pure-helper tests in subsequent tasks so we don't have to
hit indeed.com from CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pure helper — `extractJobKey`

**Files:**
- Modify: `scrapers/indeed.js` (ADD `extractJobKey` near the existing pure helpers — before `extractJobsFromSearchPage`)
- Create: `test/scrapers/indeed-extract-job-key.test.js`

The current scraper has an inline three-step fallback inside `extractJobsFromSearchPage`. Extract it as a named function so it's fixture-testable.

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/indeed-extract-job-key.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractJobKey } from '../../scrapers/indeed.js';

test('extractJobKey: card has data-jk on itself', () => {
    const $ = cheerio.load('<div class="job_seen_beacon" data-jk="abc123"></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'abc123');
});

test('extractJobKey: closest ancestor has data-jk', () => {
    const $ = cheerio.load('<div data-jk="anc456"><div class="job_seen_beacon"></div></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'anc456');
});

test('extractJobKey: child a[data-jk] (current Indeed pattern — 2026)', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><a data-jk="child789">Title</a></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'child789');
});

test('extractJobKey: prefers own attribute over child', () => {
    const $ = cheerio.load('<div class="job_seen_beacon" data-jk="own"><a data-jk="child">X</a></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'own');
});

test('extractJobKey: prefers own attribute over ancestor', () => {
    const $ = cheerio.load('<div data-jk="anc"><div class="job_seen_beacon" data-jk="own"></div></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'own');
});

test('extractJobKey: no data-jk anywhere → null', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><span>nothing</span></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), null);
});

test('extractJobKey: empty card → null', () => {
    const $ = cheerio.load('<div></div>');
    const card = $('div');
    assert.equal(extractJobKey($, card), null);
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test 'test/scrapers/indeed-extract-job-key.test.js'
```
Expected: FAIL — `extractJobKey is not a function`.

- [ ] **Step 3: Add the helper in `scrapers/indeed.js`**

Open `scrapers/indeed.js`. Find the existing `function extractJobsFromSearchPage(html, domain) { ... }`. IMMEDIATELY BEFORE that function, insert:

```js
// Returns the job key (Indeed's per-listing identifier) for a card.
// Three-step fallback, preserving the historical waterfall:
//   1. card's own data-jk attribute
//   2. closest ancestor with data-jk
//   3. first descendant with data-jk (today's primary path: a[data-jk] —
//      2026 Indeed migrated the attribute from li/div onto the anchor)
// Returns null on miss; the caller skips the row.
export function extractJobKey($, $card) {
    const own = $card.attr('data-jk');
    if (own) return own;
    const ancestor = $card.closest('[data-jk]');
    if (ancestor.length && ancestor.attr('data-jk')) return ancestor.attr('data-jk');
    const descendant = $card.find('[data-jk]').first();
    if (descendant.length && descendant.attr('data-jk')) return descendant.attr('data-jk');
    return null;
}
```

DO NOT modify any other function in this task.

- [ ] **Step 4: Run test, verify PASS**

```bash
node --test 'test/scrapers/indeed-extract-job-key.test.js'
```
Expected: PASS (7 tests).

Full suite:
```bash
node --test 'test/**/*.test.js'
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scrapers/indeed.js test/scrapers/indeed-extract-job-key.test.js
git commit -m "$(cat <<'EOF'
feat(indeed): extractJobKey — pure 3-step data-jk fallback

Extracts the inline three-step fallback from extractJobsFromSearchPage
into a fixture-testable named function. Preserves the historical
waterfall (own → ancestor → descendant). The descendant path is today's
primary route since Indeed migrated data-jk from li/div onto a[data-jk].

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure helper — `indeedJobUrl`

**Files:**
- Modify: `scrapers/indeed.js` (ADD `indeedJobUrl` immediately after `extractJobKey`)
- Create: `test/scrapers/indeed-job-url.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/indeed-job-url.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indeedJobUrl } from '../../scrapers/indeed.js';

test('indeedJobUrl: standard US domain + key', () => {
    assert.equal(
        indeedJobUrl('www.indeed.com', 'abc123'),
        'https://www.indeed.com/viewjob?jk=abc123',
    );
});

test('indeedJobUrl: regional domain (in.indeed.com)', () => {
    assert.equal(
        indeedJobUrl('in.indeed.com', 'abc123'),
        'https://in.indeed.com/viewjob?jk=abc123',
    );
});

test('indeedJobUrl: encodes special characters in key', () => {
    assert.equal(
        indeedJobUrl('www.indeed.com', 'abc 123/def'),
        'https://www.indeed.com/viewjob?jk=abc%20123%2Fdef',
    );
});

test('indeedJobUrl: missing key → null', () => {
    assert.equal(indeedJobUrl('www.indeed.com', null), null);
    assert.equal(indeedJobUrl('www.indeed.com', undefined), null);
    assert.equal(indeedJobUrl('www.indeed.com', ''), null);
});

test('indeedJobUrl: missing domain → null', () => {
    assert.equal(indeedJobUrl(null, 'abc'), null);
    assert.equal(indeedJobUrl('', 'abc'), null);
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test 'test/scrapers/indeed-job-url.test.js'
```
Expected: FAIL — `indeedJobUrl is not a function`.

- [ ] **Step 3: Add the helper in `scrapers/indeed.js`**

Insert IMMEDIATELY AFTER `extractJobKey`:

```js
// Builds the canonical job-detail URL for an Indeed listing. Returns
// null when either input is missing so the caller can drop the row
// rather than emit a broken URL.
export function indeedJobUrl(domain, jobKey) {
    if (!domain || !jobKey) return null;
    return `https://${domain}/viewjob?jk=${encodeURIComponent(jobKey)}`;
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
node --test 'test/scrapers/indeed-job-url.test.js'
```
Expected: PASS (5 tests).

Full suite:
```bash
node --test 'test/**/*.test.js'
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scrapers/indeed.js test/scrapers/indeed-job-url.test.js
git commit -m "$(cat <<'EOF'
feat(indeed): indeedJobUrl — canonical /viewjob URL builder

Pure builder for https://<domain>/viewjob?jk=<encoded-key>. Handles
regional domains (e.g. in.indeed.com); URL-encodes the key. Returns
null on missing-either so the caller drops the row instead of emitting
a malformed URL.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pure helper — `parseJobCard` (fixture-driven)

**Files:**
- Modify: `scrapers/indeed.js` (ADD `parseJobCard` immediately after `indeedJobUrl`)
- Create: `test/scrapers/indeed-parse-job-card.test.js`

`parseJobCard($, $card, domain) → row | {__domChanged: true, reason}` composes the two helpers above and pulls per-card fields from the existing inline extractor logic.

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/indeed-parse-job-card.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { parseJobCard } from '../../scrapers/indeed.js';

const FIXTURE = fs.readFileSync(new URL('../fixtures/indeed-card.html', import.meta.url), 'utf-8');

test('parseJobCard: real fixture yields a valid row', () => {
    const $ = cheerio.load(FIXTURE);
    // The card fixture is the inner HTML of one .job_seen_beacon; wrap a parent so cheerio queries work.
    const $card = $('.job_seen_beacon').length ? $('.job_seen_beacon').first() : $.root().children().first();
    const row = parseJobCard($, $card, 'www.indeed.com');
    assert.ok(row, 'should not be null');
    assert.ok(!row.__domChanged, `expected a row, got sentinel: ${JSON.stringify(row)}`);
    assert.ok(row.title && row.title.length > 1, `title: ${JSON.stringify(row.title)}`);
    assert.ok(row.company && row.company.length > 0, `company: ${JSON.stringify(row.company)}`);
    assert.ok(row.jobKey && row.jobKey.length > 0);
    assert.ok(row.url && row.url.startsWith('https://www.indeed.com/viewjob?jk='));
});

test('parseJobCard: card with no data-jk anywhere → null (silent skip — UI artifact)', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><h2>X</h2></div>');
    const card = $('.job_seen_beacon');
    assert.equal(parseJobCard($, card, 'www.indeed.com'), null);
});

test('parseJobCard: card with data-jk but no title → __domChanged sentinel', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><a data-jk="abc"></a></div>');
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.ok(r);
    assert.equal(r.__domChanged, true);
    assert.match(r.reason, /title|company/i);
});

test('parseJobCard: synthetic happy path with all fields', () => {
    const $ = cheerio.load(`
        <div class="job_seen_beacon">
            <a data-jk="job123"><h2 class="jobTitle"><span title="Senior Engineer">Senior Engineer</span></h2></a>
            <span data-testid="company-name">Acme Corp</span>
            <div data-testid="text-location">San Francisco, CA</div>
        </div>
    `);
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.ok(r);
    assert.ok(!r.__domChanged);
    assert.equal(r.jobKey, 'job123');
    assert.equal(r.title, 'Senior Engineer');
    assert.equal(r.company, 'Acme Corp');
    assert.match(r.location, /San Francisco/);
    assert.equal(r.url, 'https://www.indeed.com/viewjob?jk=job123');
});

test('parseJobCard: title from <h2 class="jobTitle"> nested span', () => {
    const $ = cheerio.load(`
        <div class="job_seen_beacon">
            <a data-jk="k1"><h2 class="jobTitle"><span>Lead Cloud Architect</span></h2></a>
            <span data-testid="company-name">CloudCo</span>
        </div>
    `);
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.equal(r.title, 'Lead Cloud Architect');
});

test('parseJobCard: includes isPromoted flag when sponsored attribute present', () => {
    const $ = cheerio.load(`
        <div class="job_seen_beacon" data-empn="999">
            <a data-jk="spons1"><h2 class="jobTitle"><span>Promoted Role</span></h2></a>
            <span data-testid="company-name">SponsCorp</span>
        </div>
    `);
    const card = $('.job_seen_beacon');
    const r = parseJobCard($, card, 'www.indeed.com');
    assert.equal(r.isPromoted, true);
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test 'test/scrapers/indeed-parse-job-card.test.js'
```
Expected: FAIL — `parseJobCard is not a function`.

- [ ] **Step 3: Add the helper in `scrapers/indeed.js`**

Insert IMMEDIATELY AFTER `indeedJobUrl`:

```js
// Maps one search-result card to a flat record. Composes extractJobKey
// + indeedJobUrl with per-field selectors. Returns:
//   - the row on success
//   - { __domChanged: true, reason } when load-bearing fields are missing
//     and the card had a data-jk (indicates Indeed renamed something)
//   - null when no data-jk exists at all (UI artifact, not a job card)
export function parseJobCard($, $card, domain) {
    const jobKey = extractJobKey($, $card);
    if (!jobKey) return null;

    // Title — prefer the nested span inside h2.jobTitle (Indeed's stable layout)
    let title = $card.find('h2.jobTitle span[title]').attr('title')
        || $card.find('h2.jobTitle span').first().text().trim()
        || $card.find('h2.jobTitle').text().trim()
        || $card.find('a[data-jk]').first().text().trim();
    title = title?.trim() || '';

    // Company
    const company = (
        $card.find('[data-testid="company-name"]').text().trim()
        || $card.find('.companyName').text().trim()
        || $card.find('span.companyName').text().trim()
        || ''
    ).trim();

    if (!title || !company) {
        return { __domChanged: true, reason: !title ? 'missing_title' : 'missing_company' };
    }

    // Location
    const location = (
        $card.find('[data-testid="text-location"]').text().trim()
        || $card.find('.companyLocation').text().trim()
        || ''
    ).trim();

    // Salary (best-effort; not load-bearing)
    const salary = (
        $card.find('[data-testid="attribute_snippet_testid"]:contains("$")').first().text().trim()
        || $card.find('.salary-snippet, .estimated-salary').first().text().trim()
        || ''
    ).trim();

    // Posted-date
    const postedDate = (
        $card.find('[data-testid="myJobsStateDate"]').text().trim()
        || $card.find('.date').text().trim()
        || ''
    ).replace(/^Posted\s*/i, '').trim();

    const url = indeedJobUrl(domain, jobKey);
    const isPromoted = $card.attr('data-empn') ? true : $card.find('.sponsoredJob, [class*="sponsored"]').length > 0;

    return {
        jobKey,
        title,
        company,
        location,
        salary,
        postedDate,
        url,
        isPromoted,
    };
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
node --test 'test/scrapers/indeed-parse-job-card.test.js'
```
Expected: PASS (6 tests).

Full suite:
```bash
node --test 'test/**/*.test.js'
```
Expected: all green.

If the real fixture test fails (the first test), inspect the actual saved card HTML to see what selectors should be used. The current scraper's `extractJobsFromSearchPage` (lines 243-385) has the canonical selectors — port any that work better than what's in `parseJobCard` above.

- [ ] **Step 5: Commit**

```bash
git add scrapers/indeed.js test/scrapers/indeed-parse-job-card.test.js
git commit -m "$(cat <<'EOF'
feat(indeed): parseJobCard — fixture-driven card extractor with sentinels

Composes extractJobKey + indeedJobUrl with per-field cheerio selectors
(title from h2.jobTitle nested span, company from data-testid=company-name
with .companyName fallback, location/salary/postedDate via data-testid).
Returns null for cards with no data-jk (UI artifacts) and the
{__domChanged, reason} sentinel for cards with data-jk but missing
load-bearing fields. Surfaces sponsored cards via isPromoted: true
(data-empn attribute or sponsored class hint).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Page-state classifier — `classifyIndeedSearchPage`

**Files:**
- Modify: `scrapers/indeed.js` (ADD `classifyIndeedSearchPage` after `parseJobCard`)
- Create: `test/scrapers/indeed-classify-page.test.js`

Pure function: `classifyIndeedSearchPage({url, bodyText, anchorCount, sawAuthBounce, bytes, html}) → {state, signal}`.

The `html` input lets the classifier call `indeedNoResults(html)` (existing exported helper) for the empty-confirmed check.

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/indeed-classify-page.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyIndeedSearchPage } from '../../scrapers/indeed.js';

const NO_RESULTS_HTML = fs.readFileSync(new URL('../fixtures/indeed-no-results.html', import.meta.url), 'utf-8');

test('classifyIndeedSearchPage: anchors > 0 → results', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer&l=US',
        bodyText: 'Software Engineer jobs in United States',
        anchorCount: 16,
        sawAuthBounce: false,
        bytes: 1_500_000,
        html: '',
    });
    assert.equal(r.state, 'results');
});

test('classifyIndeedSearchPage: secure.indeed.com/auth bounce → auth_required', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://secure.indeed.com/auth?co=US&hl=en_US&continue=...&branding=page-two-signin',
        bodyText: '',
        anchorCount: 0,
        sawAuthBounce: true,
        bytes: 50_000,
        html: '',
    });
    assert.equal(r.state, 'auth_required');
});

test('classifyIndeedSearchPage: Cloudflare interstitial → soft_blocked', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: 'Just a moment... Verify you are human. Ray ID: abc123',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: 8_000,
        html: '',
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyIndeedSearchPage: real no-results fixture → empty_confirmed', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=xyzqqq',
        bodyText: 'We didn\'t find any results for this search.',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: NO_RESULTS_HTML.length,
        html: NO_RESULTS_HTML,
    });
    assert.equal(r.state, 'empty_confirmed');
});

test('classifyIndeedSearchPage: 200 + large page + 0 anchors + no signals → dom_changed', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: 'Some long marketing prose without job cards',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: 200_000,
        html: '<html><body>...nothing matching empty-result regex...</body></html>',
    });
    assert.equal(r.state, 'dom_changed');
});

test('classifyIndeedSearchPage: tiny body + no positive signal → network_error', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: '',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: 5_000,
        html: '',
    });
    assert.equal(r.state, 'network_error');
});

test('classifyIndeedSearchPage: Cloudflare text wins over anchors (defensive)', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: 'access denied — please verify you are human',
        anchorCount: 16,
        sawAuthBounce: false,
        bytes: 100_000,
        html: '',
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyIndeedSearchPage: auth_required wins over cards (cookies invalid, partial render)', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://secure.indeed.com/auth?continue=...&from=page-two-signin',
        bodyText: 'Sign in',
        anchorCount: 16,
        sawAuthBounce: true,
        bytes: 100_000,
        html: '',
    });
    assert.equal(r.state, 'auth_required');
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test 'test/scrapers/indeed-classify-page.test.js'
```
Expected: FAIL — `classifyIndeedSearchPage is not a function`.

- [ ] **Step 3: Add the classifier in `scrapers/indeed.js`**

Insert IMMEDIATELY AFTER `parseJobCard`:

```js
// Pure page-state classifier for the Indeed search-results page.
//   results          → real results page, anchors are extractable
//   empty_confirmed  → real "0 results" page (indeedNoResults() matches)
//   auth_required    → bounced to secure.indeed.com/auth (cookies invalid
//                      OR pagination beyond anonymous cap)
//   soft_blocked     → Cloudflare interstitial / verify-human page
//   dom_changed      → page rendered but anchors absent and no other signal
//   network_error    → page didn't render meaningfully
const INDEED_DOM_CHANGED_BYTES_THRESHOLD = 50_000;

export function classifyIndeedSearchPage({ url, bodyText, anchorCount, sawAuthBounce, bytes, html }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/cloudflare|verify you are human|just a moment|ray id|additional verification|access denied/i.test(t)
        || /captcha|challenge/i.test(u)) {
        return { state: 'soft_blocked', signal: 'cloudflare-style block page' };
    }
    if (sawAuthBounce || /secure\.indeed\.com\/auth/.test(u)) {
        return { state: 'auth_required', signal: 'bounced to secure.indeed.com/auth' };
    }
    if (anchorCount > 0) {
        return { state: 'results', signal: `anchors=${anchorCount}` };
    }
    if (indeedNoResults(html)) {
        return { state: 'empty_confirmed', signal: 'indeedNoResults() matched' };
    }
    if ((bytes ?? 0) >= INDEED_DOM_CHANGED_BYTES_THRESHOLD) {
        return { state: 'dom_changed', signal: `large render (${bytes}b) but 0 anchors and no empty/auth/block signal` };
    }
    return { state: 'network_error', signal: `small body (${bytes}b), no positive page signal` };
}
```

- [ ] **Step 4: Run test, verify PASS**

```bash
node --test 'test/scrapers/indeed-classify-page.test.js'
```
Expected: PASS (8 tests).

Full suite:
```bash
node --test 'test/**/*.test.js'
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scrapers/indeed.js test/scrapers/indeed-classify-page.test.js
git commit -m "$(cat <<'EOF'
feat(indeed): classifyIndeedSearchPage — pure 6-state classifier

Mirrors Monster + Dice classifiers with one Indeed-specific addition:
auth_required state for secure.indeed.com/auth bounces (pagination beyond
anonymous cap or stale cookies). Block-text + auth-bounce both win over
the anchorCount check (defensive — cards could be a stale prerender).
Empty-confirmed leans on the existing indeedNoResults() helper.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Cooldown module — `src/core/indeed-cooldown.js`

**Files:**
- Create: `src/core/indeed-cooldown.js`
- Create: `test/core/indeed-cooldown.test.js`

Mirror of `src/core/monster-cooldown.js` with Indeed-specific marker filename and env variable.

- [ ] **Step 1: Write the failing test**

Create `test/core/indeed-cooldown.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cooldownPath,
    cooldownMs,
    readCooldownMarker,
    writeCooldownMarker,
    isOnCooldown,
} from '../../src/core/indeed-cooldown.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');

test('cooldownPath: ends with .blacklight-indeed-cooldown in the homedir', () => {
    const p = cooldownPath();
    assert.ok(p.endsWith('.blacklight-indeed-cooldown'), `got ${p}`);
});

test('cooldownMs: defaults to 60 minutes when env unset', () => {
    assert.equal(cooldownMs({}), 60 * 60 * 1000);
});

test('cooldownMs: reads positive integer env INDEED_BLOCK_COOLDOWN_MIN', () => {
    assert.equal(cooldownMs({ INDEED_BLOCK_COOLDOWN_MIN: '15' }), 15 * 60 * 1000);
    assert.equal(cooldownMs({ INDEED_BLOCK_COOLDOWN_MIN: '120' }), 120 * 60 * 1000);
});

test('cooldownMs: ignores zero / negative / garbage env values (falls back to 60-min default)', () => {
    assert.equal(cooldownMs({ INDEED_BLOCK_COOLDOWN_MIN: '0' }), 60 * 60 * 1000);
    assert.equal(cooldownMs({ INDEED_BLOCK_COOLDOWN_MIN: '-5' }), 60 * 60 * 1000);
    assert.equal(cooldownMs({ INDEED_BLOCK_COOLDOWN_MIN: 'abc' }), 60 * 60 * 1000);
    assert.equal(cooldownMs({ INDEED_BLOCK_COOLDOWN_MIN: '' }), 60 * 60 * 1000);
});

test('readCooldownMarker: ENOENT → {blockedUntil: null}', () => {
    const readFile = () => { const e = new Error('no'); e.code = 'ENOENT'; throw e; };
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.deepEqual(r, { blockedUntil: null });
});

test('readCooldownMarker: future ISO → {blockedUntil: Date}', () => {
    const future = new Date('2026-06-10T13:00:00.000Z').toISOString();
    const readFile = () => future;
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.ok(r.blockedUntil instanceof Date);
    assert.equal(r.blockedUntil.toISOString(), future);
});

test('readCooldownMarker: stale (past) ISO → {blockedUntil: null}', () => {
    const past = new Date('2026-06-10T11:00:00.000Z').toISOString();
    const readFile = () => past;
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.deepEqual(r, { blockedUntil: null });
});

test('readCooldownMarker: garbage file → {blockedUntil: null}', () => {
    const readFile = () => 'not-an-iso-timestamp';
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.deepEqual(r, { blockedUntil: null });
});

test('writeCooldownMarker: writes to <path>.tmp then renames', () => {
    const calls = [];
    const writeFile = (p, content) => calls.push({ op: 'writeFile', path: p, content });
    const rename = (from, to) => calls.push({ op: 'rename', from, to });
    writeCooldownMarker({
        writeFile, rename, now: NOW, cooldownMs: 60 * 60 * 1000, path: '/tmp/x',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].op, 'writeFile');
    assert.equal(calls[0].path, '/tmp/x.tmp');
    assert.equal(calls[0].content, new Date('2026-06-10T13:00:00.000Z').toISOString());
    assert.equal(calls[1].op, 'rename');
    assert.equal(calls[1].from, '/tmp/x.tmp');
    assert.equal(calls[1].to, '/tmp/x');
});

test('isOnCooldown: null marker → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: null }, NOW), false);
});

test('isOnCooldown: future blockedUntil → true', () => {
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-10T13:00:00.000Z') }, NOW), true);
});

test('isOnCooldown: past blockedUntil → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-10T11:00:00.000Z') }, NOW), false);
});

test('isOnCooldown: blockedUntil equal to now → false (expired)', () => {
    assert.equal(isOnCooldown({ blockedUntil: NOW }, NOW), false);
});
```

- [ ] **Step 2: Run test, verify FAIL**

```bash
node --test 'test/core/indeed-cooldown.test.js'
```
Expected: FAIL — `Cannot find module 'src/core/indeed-cooldown.js'`.

- [ ] **Step 3: Implement the module**

Create `src/core/indeed-cooldown.js`:

```js
// Cross-run cooldown for Indeed. When scrapeIndeed detects a Cloudflare
// soft-block or a classifier network_error, it writes an ISO-8601 expiry
// timestamp into ~/.blacklight-indeed-cooldown. Subsequent scrapeIndeed
// calls read the marker at entry and short-circuit with BlockedError if
// it's still in the future — no browser launch, no wasted timeout budget.
//
// Mirror of src/core/monster-cooldown.js with Indeed-specific path + env.
// Intentional duplication; can refactor to a shared module if a third
// platform needs the same shape.

import os from 'node:os';
import path from 'node:path';
import nodeFs from 'node:fs';

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;  // 60 min — matches Monster's tuned default
const MARKER_FILENAME = '.blacklight-indeed-cooldown';

export function cooldownPath() {
    return path.join(os.homedir(), MARKER_FILENAME);
}

export function cooldownMs(env = process.env) {
    const raw = env?.INDEED_BLOCK_COOLDOWN_MIN;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_COOLDOWN_MS;
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOLDOWN_MS;
    return n * 60 * 1000;
}

export function readCooldownMarker({ readFile, now, path: markerPath }) {
    let raw;
    try { raw = readFile(markerPath, 'utf-8'); }
    catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) return { blockedUntil: null };
        throw e;
    }
    if (raw === null || raw === undefined) return { blockedUntil: null };
    const trimmed = String(raw).trim();
    if (!trimmed) return { blockedUntil: null };
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return { blockedUntil: null };
    const blockedUntil = new Date(ms);
    if (blockedUntil <= now) return { blockedUntil: null };
    return { blockedUntil };
}

export function writeCooldownMarker({ writeFile, rename, now, cooldownMs: ms, path: markerPath }) {
    const expiry = new Date(now.getTime() + ms).toISOString();
    const tmp = `${markerPath}.tmp`;
    writeFile(tmp, expiry);
    rename(tmp, markerPath);
}

export function isOnCooldown(marker, now) {
    return !!(marker && marker.blockedUntil instanceof Date && marker.blockedUntil > now);
}

// Convenience accessors using the real node:fs APIs.
export function defaultReadFile() { return (p, e) => nodeFs.readFileSync(p, e); }
export function defaultWriteFile() { return (p, d) => nodeFs.writeFileSync(p, d); }
export function defaultRename() { return (from, to) => nodeFs.renameSync(from, to); }
```

- [ ] **Step 4: Run test, verify PASS**

```bash
node --test 'test/core/indeed-cooldown.test.js'
```
Expected: PASS (14 tests).

Full suite:
```bash
node --test 'test/**/*.test.js'
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/indeed-cooldown.js test/core/indeed-cooldown.test.js
git commit -m "$(cat <<'EOF'
feat(indeed): src/core/indeed-cooldown.js — file-backed cooldown helpers

Mirror of monster-cooldown.js with Indeed-specific marker filename
(~/.blacklight-indeed-cooldown) and env var (INDEED_BLOCK_COOLDOWN_MIN).
60-min default. Pure helpers injectable for unit tests. Intentional
duplication — refactor to a shared module if a third platform needs the
same shape.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Rewrite `scrapeIndeed` orchestrator

**Files:**
- Modify: `scrapers/indeed.js` (rewrite the `scrapeIndeed` function body + add imports)

This is the largest task. The pure helpers from Tasks 2-5 are now composed with the cooldown module from Task 6. The existing helpers (`buildSearchUrl`, `getIndeedDomain`, `loadCookies`, `humanDelay`, `parseExpiry`, `closePopups`, `indeedNoResults`, `extractJobDetails`, `extractJobDetailsInParallel`) stay intact.

- [ ] **Step 1: Read the current orchestrator**

```bash
sed -n '565,783p' scrapers/indeed.js
```

Confirm you understand the existing structure:
- Acquires a credential (returns null on failure → silent anonymous mode today)
- Launches CloakBrowser with humanize:true
- Loads cookies if credential present
- Per-page loop: build URL, goto, wait 10s, parse with cheerio + `extractJobsFromSearchPage`, check `indeedNoResults`, push pagination
- Calls `extractJobDetailsInParallel` for per-job detail navigation
- Returns the normalized jobs array

The rewrite preserves all of this; it just replaces the silent failure paths with typed throws + cooldown wiring.

- [ ] **Step 2: Apply the orchestrator edits**

(a) **Add imports** near the existing imports at the top of `scrapers/indeed.js`:

```js
import { AuthError, BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
import {
    cooldownPath, cooldownMs, readCooldownMarker, writeCooldownMarker, isOnCooldown,
    defaultReadFile, defaultWriteFile, defaultRename,
} from '../src/core/indeed-cooldown.js';
```

(b) **Add a `CONFIG` constant** above the `scrapeIndeed` export (if not already present at orchestrator scope — the current file has `CONFIG` near the top for fingerprints; if a separate orchestrator-level CONFIG would clash, just inline the values):

```js
const CLOUDFLARE_GRACE_MS = 10_000;
const DETAIL_DOM_CHANGED_THRESHOLD = 0.30;
```

(c) **Replace the entire body** of `export async function scrapeIndeed(jobTitle, location, sessionId = null) { ... }`. Find the current export (around line 565) and replace from that line through the function's closing `}`. The new body:

```js
export async function scrapeIndeed(jobTitle, location, sessionId = null) {
    // Cross-run cooldown gate. If a recent Cloudflare block wrote the
    // marker, short-circuit immediately — no browser launch.
    {
        const now = new Date();
        const marker = readCooldownMarker({
            readFile: defaultReadFile(),
            now,
            path: cooldownPath(),
        });
        if (isOnCooldown(marker, now)) {
            throw new BlockedError(
                `Indeed IP cooldown active until ${marker.blockedUntil.toISOString()} — skipping scrape`,
                { platform: 'indeed', kind: 'cloudflare-cooldown' },
            );
        }
    }

    logProgress('Indeed', `Searching for "${jobTitle}" in "${location}"`);

    // Credential lease — drop the silent anonymous-fallback path.
    let credential = null;
    try {
        credential = await getCredentialsAPIClient().acquire('indeed', sessionId);
    } catch (e) {
        if (process.env.INDEED_ALLOW_ANONYMOUS !== '1') {
            throw new AuthError(`No Indeed credential available from API: ${e.message}`, { platform: 'indeed', cause: e });
        }
        logProgress('Indeed', `WARN: credential acquire failed but INDEED_ALLOW_ANONYMOUS=1 — running anonymous (page 1 only)`);
    }
    if (!credential && process.env.INDEED_ALLOW_ANONYMOUS !== '1') {
        throw new AuthError('No Indeed credential available from API', { platform: 'indeed' });
    }

    const domain = getIndeedDomain(location);
    const fingerprint = getRandomFingerprint();
    logProgress('Indeed', `🚀 Launching CloakBrowser (${fingerprint.userAgent.includes('Win') ? 'Windows' : 'other'})...`);
    const browser = await launch({ headless: true, humanize: true });

    const collectedJobs = [];
    let collectedAnything = false;

    try {
        const context = await browser.newContext({
            userAgent: fingerprint.userAgent,
            viewport: fingerprint.viewport,
            locale: fingerprint.locale,
            timezoneId: fingerprint.timezone,
        });
        if (credential) {
            await loadCookies(credential, context);
        }
        const page = await context.newPage();
        await closePopups(page);

        const allRawJobs = [];
        let domChangedCardCount = 0;
        let totalCardsProcessed = 0;

        for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES && allRawJobs.length < CONFIG.MAX_JOBS; pageNum++) {
            const start = (pageNum - 1) * 10;
            const url = buildSearchUrl(domain, jobTitle, location, start);
            logProgress('Indeed', `Page ${pageNum}: ${url}`);

            try {
                await page.goto(url, { waitUntil: 'load', timeout: 45000 });
            } catch (e) {
                if (collectedAnything) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                throw new NetworkError(`Indeed page.goto failed: ${e.message}`, { platform: 'indeed', cause: e });
            }
            await new Promise((r) => setTimeout(r, CLOUDFLARE_GRACE_MS));

            const probe = await page.evaluate(() => ({
                finalUrl: window.location.href,
                bodyText: (document.body?.innerText || '').slice(0, 4000),
                bytes: document.documentElement?.outerHTML?.length ?? 0,
                anchorCount: document.querySelectorAll('.job_seen_beacon').length
                    || document.querySelectorAll('[data-jk]').length,
            }));
            const html = await page.content();
            const sawAuthBounce = /secure\.indeed\.com\/auth/.test(probe.finalUrl);
            const verdict = classifyIndeedSearchPage({
                url: probe.finalUrl,
                bodyText: probe.bodyText,
                anchorCount: probe.anchorCount,
                sawAuthBounce,
                bytes: probe.bytes,
                html,
            });
            logProgress('Indeed', `Page ${pageNum} classified: ${verdict.state} (${verdict.signal})`);

            if (verdict.state === 'soft_blocked') {
                writeCooldownMarker({
                    writeFile: defaultWriteFile(),
                    rename: defaultRename(),
                    now: new Date(),
                    cooldownMs: cooldownMs(),
                    path: cooldownPath(),
                });
                if (collectedAnything) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                throw new BlockedError(`Indeed blocked: ${verdict.signal}`, { platform: 'indeed', kind: 'cloudflare' });
            }
            if (verdict.state === 'auth_required') {
                if (collectedAnything) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                throw new AuthError(`Indeed auth required: ${verdict.signal}`, { platform: 'indeed' });
            }
            if (verdict.state === 'dom_changed') {
                if (collectedAnything) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(`Indeed DOM changed: ${verdict.signal}`, { platform: 'indeed' });
            }
            if (verdict.state === 'network_error') {
                writeCooldownMarker({
                    writeFile: defaultWriteFile(),
                    rename: defaultRename(),
                    now: new Date(),
                    cooldownMs: cooldownMs(),
                    path: cooldownPath(),
                });
                if (collectedAnything) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                throw new NetworkError(`Indeed page didn't render: ${verdict.signal}`, { platform: 'indeed' });
            }
            if (verdict.state === 'empty_confirmed') {
                logProgress('Indeed', `Page ${pageNum}: confirmed no results — stopping pagination`);
                break;
            }

            // results — extract via parseJobCard per card
            const $ = cheerio.load(html);
            const cardSelectors = [
                '.job_seen_beacon', '[data-testid="job-card"]', '.resultContent',
                'a[data-jk]', 'li[data-jk]', 'div[data-jk]',
            ];
            let $cards = $([]);
            for (const sel of cardSelectors) {
                $cards = $(sel);
                if ($cards.length > 0) {
                    logProgress('Indeed', `Page ${pageNum}: ${$cards.length} cards via ${sel}`);
                    break;
                }
            }
            let pageNewCount = 0;
            $cards.each((_, el) => {
                const $card = $(el);
                totalCardsProcessed++;
                const row = parseJobCard($, $card, domain);
                if (!row) return;
                if (row.__domChanged) { domChangedCardCount++; return; }
                if (allRawJobs.some((j) => j.jobKey === row.jobKey)) return;
                allRawJobs.push(row);
                pageNewCount++;
            });

            collectedAnything = collectedAnything || allRawJobs.length > 0;
            logProgress('Indeed', `Page ${pageNum}: ${pageNewCount} new unique, total: ${allRawJobs.length}`);

            if (pageNewCount === 0) break;
            await humanDelay(2000, 5000);
        }

        // Per-card DOM-changed batch gate.
        if (totalCardsProcessed > 0) {
            const rate = domChangedCardCount / totalCardsProcessed;
            if (rate > DETAIL_DOM_CHANGED_THRESHOLD) {
                if (collectedAnything) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(
                    `Indeed card-level DOM-changed rate too high (${domChangedCardCount}/${totalCardsProcessed})`,
                    { platform: 'indeed' },
                );
            }
        }

        if (allRawJobs.length === 0) {
            return { jobs: [], emptyConfirmed: true };
        }

        // Detail enrichment (existing path)
        const detailedJobs = await extractJobDetailsInParallel(context, allRawJobs, CONFIG.CONCURRENT_TABS);
        for (const j of detailedJobs) {
            collectedJobs.push(normalizeJobData(j, 'Indeed'));
        }
        collectedAnything = collectedAnything || collectedJobs.length > 0;
        logProgress('Indeed', `Completed: ${collectedJobs.length} jobs`);
        if (collectedJobs.length === 0) return { jobs: [], emptyConfirmed: true };
        return collectedJobs;
    } finally {
        try { await browser.close(); } catch { /* already closed */ }
    }
}
```

DO NOT delete `extractJobsFromSearchPage`, `extractJobDetails`, `extractJobDetailsInParallel`, or other existing helpers. They may still be called from above (verify with a quick grep after editing). If `extractJobsFromSearchPage` becomes truly unused, leave it as dead code for now — a follow-up slice can clean it up.

- [ ] **Step 3: Run the full test suite**

```bash
node --test 'test/**/*.test.js'
```
Expected: all green. The pure helpers from Tasks 2-6 are independently tested; the orchestrator rewrite composes them.

- [ ] **Step 4: Smoke-verify module shape**

```bash
node -e "import('./scrapers/indeed.js').then(m => console.log(Object.keys(m).sort().join(', ')))"
```
Expected: includes at minimum `classifyIndeedSearchPage, extractJobKey, indeedJobUrl, indeedNoResults, parseJobCard, scrapeIndeed`.

- [ ] **Step 5: Commit**

```bash
git add scrapers/indeed.js
git commit -m "$(cat <<'EOF'
feat(indeed): rewrite scrapeIndeed — typed errors, classifier, cooldown, no anonymous

- Cooldown gate at entry: BlockedError(cloudflare-cooldown) without
  browser launch when marker is active.
- AuthError thrown when credential lease fails (was silently degrading
  to anonymous page-1-only mode). INDEED_ALLOW_ANONYMOUS=1 overrides.
- Per-page classifier (6 states) drives the loop:
    soft_blocked → BlockedError + marker write
    auth_required → AuthError (no marker; credential problem ≠ IP block)
    dom_changed → DomChangedError
    network_error → NetworkError + marker write (cascade prevention)
    empty_confirmed → stop pagination, return {jobs:[],emptyConfirmed:true}
    results → parseJobCard per card
- Per-card sentinel aggregation: > 30% __domChanged across the batch
  triggers DomChangedError at end-of-pagination.
- Partial-result policy preserves earlier pages on later throws.

Existing helpers preserved: buildSearchUrl, getIndeedDomain, loadCookies,
humanDelay, parseExpiry, closePopups, indeedNoResults, extractJobDetails,
extractJobDetailsInParallel. Cloudflare-passing tuning unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `strictEmpty: true` in the registry

**Files:**
- Modify: `src/scrapers/registry.js`

- [ ] **Step 1: Read the current registry**

```bash
cat src/scrapers/registry.js
```

Find: `indeed: new BaseScraper('indeed', scrapeIndeed),`

- [ ] **Step 2: Apply the edit**

Replace that line with:

```js
indeed: new BaseScraper('indeed', scrapeIndeed, { strictEmpty: true }),
```

No other changes. Do not touch the Monster, LinkedIn, Dice, etc. entries.

- [ ] **Step 3: Verify Indeed still appears in PLATFORM_NAMES**

```bash
node -e "import('./src/scrapers/registry.js').then(m => console.log(m.PLATFORM_NAMES))"
```
Expected: array contains `'indeed'`.

- [ ] **Step 4: Run the full test suite**

```bash
node --test 'test/**/*.test.js'
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/registry.js
git commit -m "$(cat <<'EOF'
feat(indeed): strictEmpty:true in registry

0-jobs-on-200 from Indeed now surfaces as BlockedError via BaseScraper's
strict-empty gate instead of being recorded as a successful empty
scrape. The scraper returns {jobs:[], emptyConfirmed:true} for genuine
no-results pages so this gate doesn't false-positive.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Debug harness `scripts/test-indeed-scrape.js`

**Files:**
- Create: `scripts/test-indeed-scrape.js`
- Modify: `package.json` (add `"indeed:test-scrape": "node scripts/test-indeed-scrape.js"`)

- [ ] **Step 1: Create the harness**

Create `scripts/test-indeed-scrape.js`:

```js
#!/usr/bin/env node
// Test harness — runs scrapeIndeed live for one role and analyzes the
// URL quality + per-job field completeness. Mirrors test-monster-scrape.js
// and test-dice-scrape.js.
//   npm run indeed:test-scrape -- "software engineer"
//   INDEED_TEST_LOC="United States" npm run indeed:test-scrape
//   INDEED_CLEAR_COOLDOWN=1 npm run indeed:test-scrape -- "<role>"
import fs from 'node:fs';
import { scrapeIndeed } from '../scrapers/indeed.js';
import { classifyUrl } from '../src/core/url-quality.js';
import { cooldownPath } from '../src/core/indeed-cooldown.js';

const role = process.argv.slice(2).join(' ').trim() || 'software engineer';
const loc  = process.env.INDEED_TEST_LOC || 'United States';

console.log(`Role     : ${role}`);
console.log(`Location : ${loc}\n`);

if (process.env.INDEED_CLEAR_COOLDOWN === '1') {
    try { fs.unlinkSync(cooldownPath()); console.log(`Cleared cooldown marker at ${cooldownPath()}`); }
    catch (e) { if (e.code !== 'ENOENT') console.log(`(cooldown clear: ${e.message})`); }
}

async function main() {
    const t0 = Date.now();
    let result;
    try {
        result = await scrapeIndeed(role, loc, null);
    } catch (e) {
        console.log(`\n❌ Scrape threw ${e.name}: ${e.message}`);
        if (e?.name === 'BlockedError' && e?.kind === 'cloudflare-cooldown') {
            console.log('(in active Cloudflare cooldown — pass INDEED_CLEAR_COOLDOWN=1 to override)');
            process.exit(4);
        }
        process.exit(2);
    }
    const elapsed = Date.now() - t0;
    const jobs = Array.isArray(result) ? result : result.jobs;
    const emptyConfirmed = Array.isArray(result) ? false : !!result.emptyConfirmed;
    const partial = Array.isArray(result) ? false : !!result.partial;

    console.log(`\n=== Scraped ${jobs.length} job(s) in ${elapsed}ms ===`);
    console.log(`emptyConfirmed=${emptyConfirmed} partial=${partial}\n`);

    const counts = { permalink: 0, profile_in: 0, empty: 0, other: 0 };
    const badTitle = []; const badCompany = [];
    jobs.forEach((j, i) => {
        const url = j.job?.url ?? 'N/A';
        const q = classifyUrl(url === 'N/A' ? '' : url);
        counts[q]++;
        const titleVal = j.job?.title ?? '';
        const companyVal = j.company?.name ?? '';
        if (!titleVal || titleVal === 'N/A' || titleVal.length <= 1) badTitle.push(i);
        if (!companyVal || companyVal === 'N/A') badCompany.push(i);
        if (i < 5) {
            console.log(`#${i + 1} [${q}]`);
            console.log(`   title    : ${titleVal || '(missing)'}`);
            console.log(`   company  : ${companyVal || '(missing)'}`);
            console.log(`   location : ${j.location?.formatted ?? j.location}`);
            console.log(`   url      : ${url}`);
            console.log('');
        }
    });

    console.log('=== URL quality summary ===');
    console.log(`   PERMALINK : ${counts.permalink}/${jobs.length}`);
    console.log(`   OTHER     : ${counts.other}/${jobs.length}`);
    console.log(`   EMPTY     : ${counts.empty}/${jobs.length}`);
    console.log(`   PROFILE_IN: ${counts.profile_in}/${jobs.length} (must be 0)`);
    console.log(`   bad title : ${badTitle.length} (must be 0)`);
    console.log(`   bad company: ${badCompany.length} (must be 0)`);

    // Indeed URLs (/viewjob?jk=...) classify as 'other' by the shared regex;
    // the real bad-row signal is empty/profile_in URLs or missing title/company.
    const badUrlCount = counts.empty + counts.profile_in;
    if (jobs.length > 0 && (badUrlCount / jobs.length > 0.1 || badTitle.length > 0 || badCompany.length > 0)) {
        console.log('\n⚠ Bad rows detected — extractor likely broken.');
        process.exit(3);
    }
    process.exit(0);
}
main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

Edit `package.json`. Find the `"scripts"` block via `grep -n '"scripts"' package.json`. Add this entry near the existing `"dice:test-scrape"` and `"monster:test-scrape"` entries (preserve JSON validity and all existing entries):

```json
"indeed:test-scrape": "node scripts/test-indeed-scrape.js",
```

Verify:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).scripts['indeed:test-scrape'])"
```
Expected: `node scripts/test-indeed-scrape.js`.

- [ ] **Step 3: Module load check (no live scrape)**

```bash
node -e "import('./scripts/test-indeed-scrape.js').catch(e => { if (e?.name === 'BrowserError' || e?.name === 'TimeoutError') process.exit(0); throw e; })" &
PID=$!
sleep 2
kill $PID 2>/dev/null || true
echo "load check ok"
```
Expected: no `SyntaxError` / `ReferenceError` / module-not-found errors before the kill.

- [ ] **Step 4: Run the full test suite (regression)**

```bash
node --test 'test/**/*.test.js'
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-indeed-scrape.js package.json
git commit -m "$(cat <<'EOF'
feat(indeed): test-indeed-scrape harness + npm run indeed:test-scrape

Mirrors scripts/test-monster-scrape.js + test-dice-scrape.js. Runs
scrapeIndeed end-to-end, prints per-job URL-quality summary, exits 4 on
BlockedError(kind:cloudflare-cooldown), exit 3 on bad-row rate > 10%,
exit 0 otherwise. INDEED_CLEAR_COOLDOWN=1 deletes the marker before
running.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Probe-script docstring (verify-only)

**Files:**
- Verify: `scripts/indeed-deep-probe.mjs` already has an investigation-harness docstring (committed in the spec commit).

- [ ] **Step 1: Verify docstring is present**

```bash
head -3 scripts/indeed-deep-probe.mjs
```

Expected: first 1-3 lines mention "investigation" / "NOT part of the runtime scraper" / similar.

If absent, prepend:

```js
// Investigation harness — NOT part of the runtime scraper. Probes
// Cloudflare reachability, card selectors, pagination, no-results signal,
// structured data, and a 5x reliability hammer. Re-run when Indeed ships
// a UI refresh and the live scraper starts failing.
//
// Usage: node scripts/indeed-deep-probe.mjs
```

If a prepend was needed, commit:

```bash
git add scripts/indeed-deep-probe.mjs
git commit -m "$(cat <<'EOF'
docs(indeed): mark probe script as investigation harness

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Otherwise (docstring already present), skip the commit and report the no-op.

---

## Final verification

After all 10 tasks land:

- [ ] **Step 1: Full test suite**

```bash
node --test 'test/**/*.test.js'
```
Expected: all green. Test count grew by at least 40 (7 from Task 2 + 5 from Task 3 + 6 from Task 4 + 8 from Task 5 + 14 from Task 6).

- [ ] **Step 2: Module shape**

```bash
node -e "import('./scrapers/indeed.js').then(m => console.log(Object.keys(m).sort().join(', ')))"
```
Expected: includes `classifyIndeedSearchPage, extractJobKey, indeedJobUrl, indeedNoResults, parseJobCard, scrapeIndeed`.

```bash
node -e "import('./src/core/indeed-cooldown.js').then(m => console.log(Object.keys(m).sort().join(', ')))"
```
Expected: `cooldownMs, cooldownPath, defaultRename, defaultReadFile, defaultWriteFile, isOnCooldown, readCooldownMarker, writeCooldownMarker`.

- [ ] **Step 3: Manual cooldown gate smoke**

```bash
rm -f ~/.blacklight-indeed-cooldown
node -e '
import("./src/core/indeed-cooldown.js").then(({ writeCooldownMarker, defaultWriteFile, defaultRename, cooldownPath }) => {
    writeCooldownMarker({
        writeFile: defaultWriteFile(),
        rename: defaultRename(),
        now: new Date(),
        cooldownMs: 60 * 60 * 1000,
        path: cooldownPath(),
    });
});
'
node -e '
import("./scrapers/indeed.js").then(({ scrapeIndeed }) => {
    const t0 = Date.now();
    scrapeIndeed("software engineer", "United States", null)
        .catch((e) => {
            const ms = Date.now() - t0;
            console.log("threw", e.name, "kind=", e.kind, "in", ms, "ms");
            process.exit(e.name === "BlockedError" && e.kind === "cloudflare-cooldown" && ms < 2000 ? 0 : 1);
        });
});
'
echo "exit: $?"
rm -f ~/.blacklight-indeed-cooldown
```

Expected: `threw BlockedError kind= cloudflare-cooldown in <N> ms` with `N < 2000`. Exit 0.

- [ ] **Step 4: Live smoke**

(Optional — only if you have a working Indeed credential in `config/credentials.json` AND the IP is fresh.)

```bash
INDEED_CLEAR_COOLDOWN=1 npm run indeed:test-scrape -- "software engineer"
```
Expected: either AuthError (no credential available) or a clean scrape returning ≥ 16 jobs with PERMALINK/OTHER classification (Indeed URLs hit `/viewjob` which classifies as `other` — that's fine; the harness uses the bad-row rate check).

- [ ] **Step 5: Hand off to `superpowers:finishing-a-development-branch`** to choose merge / PR / keep.

---

## Self-review

- **Spec coverage:**
  - § A (search-page extraction) → Tasks 5, 7
  - § B (per-card extraction) → Tasks 2, 3, 4, 7
  - § C (drop anonymous fallback) → Task 7 (orchestrator explicitly throws AuthError)
  - § D (classifier) → Task 5
  - § E (typed errors + partial-result) → Task 7
  - § F (cooldown module) → Task 6
  - § G (`strictEmpty:true`) → Task 8
  - § H (tests) → Tasks 1-6
  - § I (debug harness) → Task 9
  - § J (probe disposition) → Task 10
- **Placeholder scan:** every code step shows full code; no "TBD" / "similar to Task N".
- **Type consistency:** `extractJobKey($, $card) → string|null` consistent across Tasks 2, 4, 7. `indeedJobUrl(domain, key) → string|null` consistent in Tasks 3, 4, 7. `parseJobCard($, $card, domain)` consistent in Tasks 4, 7. `classifyIndeedSearchPage({url, bodyText, anchorCount, sawAuthBounce, bytes, html})` consistent in Tasks 5, 7. Cooldown helpers shape identical to `monster-cooldown.js`.
- **Test count delta:** 7 + 5 + 6 + 8 + 14 = 40+ new test cases across 5 new files. Plus existing `indeed-block.test.js` stays.
