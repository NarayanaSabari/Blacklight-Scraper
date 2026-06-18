# Glassdoor Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Glassdoor's geo-redirect data-quality bug (canonical SRCH URLs + dynamic location resolution) and lift `scrapers/glassdoor.js` to the fleet robustness pattern (typed errors, classifier, strictEmpty, fixtures, harness).

**Architecture:** Four new pure helper groups in `scrapers/glassdoor.js` (`slugifyForGlassdoor` + `buildGlassdoorSearchUrl`, `pickGlassdoorLocation`, `classifyGlassdoorSearchPage`, `parseGlassdoorCard`), an in-page location resolver (`resolveGlassdoorLocation`), and an orchestrator rewrite that pins searches to explicit location IDs, fixes the hardcoded `.co.in` jobLink domain, and routes failures through typed errors with enrich-before-partial returns (Indeed lesson). Existing pieces preserved: CloakBrowser anonymous launch, homepage warmup, `loadAllJobs` load-more loop, JSON-LD-first detail extraction, parallel detail tabs.

**Tech Stack:** Node 24 ESM, `node:test` + `node:assert/strict`, cheerio, CloakBrowser. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-12-glassdoor-hardening-design.md`

---

## Constraints

1. Do NOT modify `scrapers/linkedin.js`, `scrapers/monster.js`, `scrapers/dice.js`, `scrapers/indeed.js`, `scrapers/techfetch.js`.
2. NEVER stage `.gitignore`, `pnpm-lock.yaml`, `.claude/`, `node_modules/`. Stage files by name only.
3. Tests: `node --test 'test/**/*.test.js'` (quoted glob — Node 24).
4. Every commit ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
5. Unit tests never hit glassdoor.com; live calls only in probe scripts + harness.
6. Working dir: `/Users/sabari/Developer/freelancing/Blacklight-Scraper`, branch `emdash/glassdoor-hardening`.
7. Baseline: 359 tests passing before Task 1.

## File map

| Path | Action |
|---|---|
| `scrapers/glassdoor.js` | modify (large) — add pure helpers, rewrite orchestrator, fix jobLink domain |
| `src/scrapers/registry.js` | modify (+strictEmpty for glassdoor) |
| `scripts/test-glassdoor-scrape.js` | new harness |
| `package.json` | add `glassdoor:test-scrape` script |
| `test/fixtures/glassdoor-search.html` | new (from /tmp) |
| `test/fixtures/glassdoor-card.html` | new (from /tmp) |
| `test/fixtures/glassdoor-no-results.html` | new (from /tmp) |
| `test/fixtures/glassdoor-locations.json` | new (canned findPopularLocationAjax responses) |
| `test/scrapers/glassdoor-search-url.test.js` | new |
| `test/scrapers/glassdoor-pick-location.test.js` | new |
| `test/scrapers/glassdoor-classify-page.test.js` | new |
| `test/scrapers/glassdoor-parse-card.test.js` | new |

---

## Task 1: Fixtures

**Files:** create the four fixtures above.

- [ ] **Step 1:** Verify probe artifacts exist: `ls -la /tmp/glassdoor-search.html /tmp/glassdoor-card.html /tmp/glassdoor-no-results.html` (regenerate via `node scripts/glassdoor-deep-probe.mjs` if missing).
- [ ] **Step 2:** Copy:

```bash
cp /tmp/glassdoor-search.html test/fixtures/glassdoor-search.html
cp /tmp/glassdoor-card.html test/fixtures/glassdoor-card.html
cp /tmp/glassdoor-no-results.html test/fixtures/glassdoor-no-results.html
```

- [ ] **Step 3:** Create `test/fixtures/glassdoor-locations.json` with these canned endpoint responses (captured live by `scripts/glassdoor-locid-probe.mjs` on 2026-06-12):

```json
{
  "United States": [{"compoundId":"N1","countryName":"United States","id":"N1","label":"United States","locationId":1,"locationType":"N","longName":"United States","realId":1},{"compoundId":"C5022492","countryName":"United States","id":"C5022492","label":"United States Coast Guard - Air Station Sacramento, CA (US)","locationId":5022492,"locationType":"C","longName":"United States Coast Guard - Air Station Sacramento, CA (US)","realId":5022492}],
  "New York": [{"compoundId":"C1132348","countryName":"United States","id":"C1132348","label":"New York, NY (US)","locationId":1132348,"locationType":"C","longName":"New York, NY (US)","realId":1132348},{"compoundId":"S428","countryName":"United States","id":"S428","label":"New York State, US","locationId":428,"locationType":"S","longName":"New York State, US","realId":428}],
  "California": [{"compoundId":"S2280","countryName":"United States","id":"S2280","label":"California, US","locationId":2280,"locationType":"S","longName":"California, US","realId":2280},{"compoundId":"C1146562","countryName":"United States","id":"C1146562","label":"California City, CA (US)","locationId":1146562,"locationType":"C","longName":"California City, CA (US)","realId":1146562}],
  "Texas": [{"compoundId":"S1347","countryName":"United States","id":"S1347","label":"Texas, US","locationId":1347,"locationType":"S","longName":"Texas, US","realId":1347},{"compoundId":"C1140227","countryName":"United States","id":"C1140227","label":"Texas City, TX (US)","locationId":1140227,"locationType":"C","longName":"Texas City, TX (US)","realId":1140227}],
  "garbage-no-match": []
}
```

- [ ] **Step 4:** Verify fixture shapes:

```bash
node -e 'import("cheerio").then(({load})=>{const fs=require("fs");const $=load(fs.readFileSync("test/fixtures/glassdoor-search.html","utf-8"));console.log("search cards:",$(".jobCard").length);const $n=load(fs.readFileSync("test/fixtures/glassdoor-no-results.html","utf-8"));console.log("no-results cards:",$n(".jobCard").length,"— suggested cards EXPECTED >0");})'
```

Expected: search cards ≥ 25; no-results cards > 0 (the suggested-cards nuance) AND the no-results HTML contains a no-results phrase (grep it: `grep -ioE "no results|couldn.t find|0 jobs" test/fixtures/glassdoor-no-results.html | head -3` → at least one hit; note the EXACT phrase for Task 4's classifier regex).

- [ ] **Step 5:** Commit (stage the four fixture files by name).

```
test(glassdoor): live search/card/no-results fixtures + canned location responses
```

---

## Task 2: `slugifyForGlassdoor` + `buildGlassdoorSearchUrl` (pure)

**Files:** modify `scrapers/glassdoor.js` (add both, exported, ABOVE `extractJobsFromHTML`); create `test/scrapers/glassdoor-search-url.test.js`.

- [ ] **Step 1:** Failing tests:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugifyForGlassdoor, buildGlassdoorSearchUrl } from '../../scrapers/glassdoor.js';

test('slugify: lowercase, spaces to hyphens', () => {
    assert.equal(slugifyForGlassdoor('Software Engineer'), 'software-engineer');
});
test('slugify: strips non-alphanumerics, collapses runs', () => {
    assert.equal(slugifyForGlassdoor('C++ / .NET  Developer!'), 'c-net-developer');
});
test('buildGlassdoorSearchUrl: verified live example (US country pin)', () => {
    // united-states (13 chars) + software-engineer (17) → IL.0,13_IN1_KO14,31
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'software engineer', loc: { locType: 'N', locId: 1, slug: 'united-states' } }),
        'https://www.glassdoor.com/Job/united-states-software-engineer-jobs-SRCH_IL.0,13_IN1_KO14,31.htm?fromAge=7',
    );
});
test('buildGlassdoorSearchUrl: state pin (California S2280)', () => {
    // california (10) + data-scientist (14) → IL.0,10_IS2280_KO11,25
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'data scientist', loc: { locType: 'S', locId: 2280, slug: 'california' } }),
        'https://www.glassdoor.com/Job/california-data-scientist-jobs-SRCH_IL.0,10_IS2280_KO11,25.htm?fromAge=7',
    );
});
test('buildGlassdoorSearchUrl: city pin (New York C1132348)', () => {
    // new-york (8) + nurse (5) → IL.0,8_IC1132348_KO9,14
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'nurse', loc: { locType: 'C', locId: 1132348, slug: 'new-york' } }),
        'https://www.glassdoor.com/Job/new-york-nurse-jobs-SRCH_IL.0,8_IC1132348_KO9,14.htm?fromAge=7',
    );
});
test('buildGlassdoorSearchUrl: remote sentinel pins US + remoteWorkType', () => {
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'devops engineer', loc: { remote: true } }),
        'https://www.glassdoor.com/Job/united-states-devops-engineer-jobs-SRCH_IL.0,13_IN1_KO14,29.htm?fromAge=7&remoteWorkType=1',
    );
});
```

- [ ] **Step 2:** Run → FAIL (not exported).
- [ ] **Step 3:** Implement:

```js
// Slug used inside Glassdoor's canonical /Job/...-SRCH_... URLs.
export function slugifyForGlassdoor(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Canonical search URL with an EXPLICIT location pin. Free-text
// sc.location URLs get geo-rewritten to the IP's country (probe
// 2026-06-12: US searches from an Indian IP returned India jobs);
// the _I<T><id> segment keeps results pinned from any IP.
//   loc: {locType:'N'|'S'|'C', locId:number, slug:string} | {remote:true}
export function buildGlassdoorSearchUrl({ keyword, loc }) {
    const remote = !!loc?.remote;
    const locSlug = remote ? 'united-states' : loc.slug;
    const locSeg = remote ? 'IN1' : `I${loc.locType}${loc.locId}`;
    const kwSlug = slugifyForGlassdoor(keyword);
    const L = locSlug.length;
    const K = kwSlug.length;
    const base = `https://www.glassdoor.com/Job/${locSlug}-${kwSlug}-jobs-SRCH_IL.0,${L}_${locSeg}_KO${L + 1},${L + 1 + K}.htm?fromAge=7`;
    return remote ? `${base}&remoteWorkType=1` : base;
}
```

- [ ] **Step 4:** Run → PASS (6 tests); full suite green.
- [ ] **Step 5:** Commit `feat(glassdoor): canonical SRCH URL builder — geo-pinned searches`.

---

## Task 3: `pickGlassdoorLocation` (pure)

**Files:** modify `scrapers/glassdoor.js` (add exported helper after the URL builder); create `test/scrapers/glassdoor-pick-location.test.js`.

- [ ] **Step 1:** Failing tests (uses the canned fixture):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pickGlassdoorLocation } from '../../scrapers/glassdoor.js';

const CANNED = JSON.parse(fs.readFileSync(new URL('../fixtures/glassdoor-locations.json', import.meta.url), 'utf-8'));

test('pick: remote term short-circuits to the remote sentinel (no results needed)', () => {
    assert.deepEqual(pickGlassdoorLocation([], 'Remote'), { remote: true });
    assert.deepEqual(pickGlassdoorLocation(null, 'remote '), { remote: true });
});
test('pick: exact label match preferred (United States → N1)', () => {
    const r = pickGlassdoorLocation(CANNED['United States'], 'United States');
    assert.deepEqual(r, { locType: 'N', locId: 1, slug: 'united-states' });
});
test('pick: first ranked result when no exact match (New York → city)', () => {
    const r = pickGlassdoorLocation(CANNED['New York'], 'New York');
    assert.equal(r.locType, 'C');
    assert.equal(r.locId, 1132348);
    assert.equal(r.slug, 'new-york');
});
test('pick: state results (California → S2280)', () => {
    const r = pickGlassdoorLocation(CANNED['California'], 'California');
    assert.deepEqual(r, { locType: 'S', locId: 2280, slug: 'california' });
});
test('pick: empty results → null (caller falls back to US pin)', () => {
    assert.equal(pickGlassdoorLocation(CANNED['garbage-no-match'], 'zzz'), null);
    assert.equal(pickGlassdoorLocation(undefined, 'zzz'), null);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement:

```js
// Selects the best findPopularLocationAjax result for a search term.
//   - 'remote' (any case) → {remote:true} sentinel; never hits the endpoint
//     results (geo-ambiguous: resolves to "Remote, India" from Indian IPs).
//   - exact case-insensitive label/longName match wins, else first entry
//     (endpoint ranks by relevance).
//   - null on no results → caller falls back to the US country pin.
export function pickGlassdoorLocation(results, term) {
    const t = String(term ?? '').trim().toLowerCase();
    if (t === 'remote') return { remote: true };
    if (!Array.isArray(results) || results.length === 0) return null;
    const exact = results.find((r) =>
        String(r.label ?? '').toLowerCase() === t || String(r.longName ?? '').toLowerCase() === t);
    const chosen = exact ?? results[0];
    if (!chosen?.locationType || !chosen?.locationId) return null;
    return {
        locType: chosen.locationType,
        locId: chosen.locationId,
        slug: slugifyForGlassdoor(term),
    };
}
```

- [ ] **Step 4:** Run → PASS (5); full suite green.
- [ ] **Step 5:** Commit `feat(glassdoor): pickGlassdoorLocation — endpoint-response selector`.

---

## Task 4: `classifyGlassdoorSearchPage` (pure)

**Files:** modify `scrapers/glassdoor.js`; create `test/scrapers/glassdoor-classify-page.test.js`.

Signature: `classifyGlassdoorSearchPage({url, bodyText, cardCount, bytes, noResultsText, expectedLocToken}) → {state, signal}`.

NOTE: instead of passing full `html`, the orchestrator passes `noResultsText` (boolean from an in-page check) — the no-results phrase lives in rendered text. In Task 1 Step 4 you grepped the live fixture for the exact phrase; encode that phrase (plus generic variants) into the `GLASSDOOR_NO_RESULTS_RE` regex below and assert it matches the fixture's body text in a test.

- [ ] **Step 1:** Failing tests:

```js
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
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (adjust the regex to ALSO cover the exact fixture phrase found in Task 1):

```js
export const GLASSDOOR_NO_RESULTS_RE = /no results|couldn.?t find|didn.?t find any|0 jobs matching|we did not find/i;
const GLASSDOOR_DOM_CHANGED_BYTES = 100_000;

export function classifyGlassdoorSearchPage({ url, bodyText, cardCount, bytes, noResultsText, expectedLocToken }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/cloudflare|verify you are human|just a moment|ray id|security check|help us protect/i.test(t) || /captcha|challenge/i.test(u)) {
        return { state: 'soft_blocked', signal: 'block-page text' };
    }
    if (noResultsText) {
        return { state: 'empty_confirmed', signal: 'no-results text (suggested cards ignored)' };
    }
    if (expectedLocToken && u.includes('SRCH_') && !u.includes(expectedLocToken)) {
        return { state: 'geo_redirected', signal: `SRCH URL lost location pin ${expectedLocToken}` };
    }
    if ((cardCount ?? 0) > 0) return { state: 'results', signal: `cards=${cardCount}` };
    if ((bytes ?? 0) >= GLASSDOOR_DOM_CHANGED_BYTES) return { state: 'dom_changed', signal: `large render (${bytes}b), 0 cards, no signals` };
    return { state: 'network_error', signal: `small body (${bytes}b)` };
}
```

- [ ] **Step 4:** Run → PASS (7); full suite green. If the fixture-regex test fails, extend `GLASSDOOR_NO_RESULTS_RE` with the exact phrase from the fixture — do NOT delete the test.
- [ ] **Step 5:** Commit `feat(glassdoor): classifyGlassdoorSearchPage — 6 states incl. geo_redirected`.

---

## Task 5: `parseGlassdoorCard` (pure)

**Files:** modify `scrapers/glassdoor.js`; create `test/scrapers/glassdoor-parse-card.test.js`.

- [ ] **Step 1:** Failing tests:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { parseGlassdoorCard } from '../../scrapers/glassdoor.js';

const CARD = fs.readFileSync(new URL('../fixtures/glassdoor-card.html', import.meta.url), 'utf-8');

test('parse: real fixture card yields a valid row with absolute link on the serving domain', () => {
    const $ = cheerio.load(CARD);
    const $card = $('.jobCard').length ? $('.jobCard').first() : $.root().children().first();
    const row = parseGlassdoorCard($, $card, 'https://www.glassdoor.co.in/Job/x.htm');
    assert.ok(row && !row.__domChanged, JSON.stringify(row).slice(0, 200));
    assert.ok(row.jobTitle.length > 1);
    assert.ok(row.jobLink.startsWith('https://www.glassdoor.co.in/'), row.jobLink);
});
test('parse: link resolves against the page base, NOT hardcoded .co.in', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-title" id="job-title-123">Engineer</a><a data-test="job-link" href="/job-listing/x.htm"></a><span data-test="job-employer">Acme</span></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/Job/y.htm');
    assert.equal(row.jobLink, 'https://www.glassdoor.com/job-listing/x.htm');
});
test('parse: missing title → __domChanged sentinel', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-link" href="/job-listing/x.htm"></a></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/');
    assert.equal(row.__domChanged, true);
    assert.match(row.reason, /title/i);
});
test('parse: no link and no jobId → __domChanged sentinel', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-title">Engineer</a></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/');
    assert.equal(row.__domChanged, true);
});
test('parse: rating/salary/easyApply are best-effort (absent → defaults, no sentinel)', () => {
    const $ = cheerio.load('<div class="jobCard"><a data-test="job-title" id="job-title-9">E</a><a data-test="job-link" href="/job-listing/z.htm"></a><span data-test="job-employer">Co</span></div>');
    const row = parseGlassdoorCard($, $('.jobCard'), 'https://www.glassdoor.com/');
    assert.ok(!row.__domChanged);
    assert.equal(row.companyRating, null);
    assert.equal(row.easyApply, false);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement — port the field logic from `extractJobsFromHTML` (keep its selectors incl. hashed-class fallbacks as best-effort), with these changes: title required; link-or-jobId required; `jobLink = href ? new URL(href, pageBaseUrl).toString() : null`. Return shape: `{jobId, jobTitle, companyName, location, salaryEstimate, jobLink, easyApply, companyRating}` or `{__domChanged, reason}`.

```js
// Maps one .jobCard to a flat row. Load-bearing: title + (link or jobId).
// Company/rating/salary/easyApply are best-effort — hashed CSS-module
// fallback classes rot on Glassdoor rebuilds and must never kill a row.
// jobLink resolves against the SERVING page URL (geo redirects flip the
// domain; the old hardcoded .co.in prefix emitted wrong-domain links).
export function parseGlassdoorCard($, $card, pageBaseUrl) {
    const jobTitle = $card.find('[data-test="job-title"]').text().trim();
    const href = $card.find('[data-test="job-link"]').attr('href')
        || $card.find('a[href*="/job-listing/"]').attr('href') || '';
    const jobId = $card.find('[data-test="job-title"]').attr('id')?.replace('job-title-', '')
        || href.match(/jl=(\d+)/)?.[1] || null;
    if (!jobTitle) return { __domChanged: true, reason: 'missing_title' };
    if (!href && !jobId) return { __domChanged: true, reason: 'missing_link_and_id' };
    const companyName = $card.find('[data-test="job-employer"]').text().trim()
        || $card.find('[class*="EmployerProfile_compactEmployerName"]').text().trim() || '';
    const ratingText = $card.find('[class*="rating-single-star_RatingText"]').text().trim();
    return {
        jobId,
        jobTitle,
        companyName,
        location: $card.find('[data-test="emp-location"]').text().trim(),
        salaryEstimate: $card.find('[data-test="detailSalary"]').text().trim(),
        jobLink: href ? new URL(href, pageBaseUrl).toString() : null,
        easyApply: $card.find('[class*="JobCard_easyApplyTag"]').length > 0,
        companyRating: ratingText ? parseFloat(ratingText) : null,
    };
}
```

- [ ] **Step 4:** Run → PASS (5); full suite green. If the real-fixture test fails on a selector, inspect `test/fixtures/glassdoor-card.html` and adapt selectors (fixture is ground truth).
- [ ] **Step 5:** Commit `feat(glassdoor): parseGlassdoorCard — sentinel extractor, serving-domain links`.

---

## Task 6: Orchestrator rewrite

**Files:** modify `scrapers/glassdoor.js` only. No new unit tests (composes Task 2-5 helpers, all locked); verification = full-suite regression + module-shape smoke.

- [ ] **Step 1:** Read the current orchestrator: `grep -n "export async function scrapeGlassdoor" scrapers/glassdoor.js` then read from that line to EOF. Confirm the pieces you must preserve: CloakBrowser launch block, homepage warmup, `loadAllJobs(page, 30)`, `extractJobDetailsInParallel(context, jobs, CONFIG.CONCURRENT_TABS)`, the final `normalizeJobData(...)` mapping.

- [ ] **Step 2:** Add imports at the top:

```js
import { AuthError, BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
```

(`AuthError` unused is fine to omit — import only what you use: `BlockedError`, `DomChangedError`, `NetworkError`.)

- [ ] **Step 3:** Add the in-page location resolver ABOVE `scrapeGlassdoor` (NOT exported — it needs a live page):

```js
// Resolves free-text location → {locType, locId, slug} via Glassdoor's
// autocomplete endpoint. Runs in-page (session cookies required). Falls
// back to the US country pin on any failure — never free-text URLs,
// which geo-rewrite to the IP's country (spec: probe 2026-06-12).
async function resolveGlassdoorLocation(page, term) {
    const sentinel = pickGlassdoorLocation(null, term);   // handles 'remote'
    if (sentinel?.remote) return sentinel;
    let results = null;
    try {
        results = await page.evaluate(async (t) => {
            const r = await fetch(`/findPopularLocationAjax.htm?maxLocationsToReturn=5&term=${encodeURIComponent(t)}`, { headers: { accept: 'application/json' } });
            if (!r.ok) return null;
            return await r.json();
        }, term);
    } catch { /* fall through to fallback */ }
    const picked = pickGlassdoorLocation(results, term);
    if (picked) return picked;
    log.warn(`Glassdoor location "${term}" did not resolve — falling back to United States pin`);
    return { locType: 'N', locId: 1, slug: 'united-states' };
}
```

- [ ] **Step 4:** Replace the body of `export async function scrapeGlassdoor(jobTitle, location, sessionId = null) {...}`:

```js
export async function scrapeGlassdoor(jobTitle, location, sessionId = null) {
    logProgress('Glassdoor', `Searching for "${jobTitle}" in "${location}"`);
    void sessionId; // anonymous platform — kept for orchestrator signature compat

    logProgress('Glassdoor', `🚀 Launching CloakBrowser stealth Chromium...`);
    const browser = await launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    const page = await context.newPage();

    const collectedJobs = [];
    let rawJobs = [];

    // Runs detail enrichment + normalization over rawJobs so partial-result
    // returns carry actual jobs (Indeed lesson: never emit {jobs:[],partial:true}
    // when raw cards were already extracted).
    const enrichAndCollect = async () => {
        if (rawJobs.length === 0 || collectedJobs.length > 0) return;
        try {
            await extractJobDetailsInParallel(context, rawJobs, CONFIG.CONCURRENT_TABS);
            for (const job of rawJobs) {
                collectedJobs.push(normalizeJobData({
                    title: job.jobTitle,
                    company: job.companyName,
                    location: job.location,
                    url: job.jobLink,
                    description: job.details?.fullDescription || 'N/A',
                    salary: job.salaryEstimate || 'N/A',
                    rating: job.companyRating,
                    easyApply: job.easyApply,
                }, 'Glassdoor'));
            }
        } catch (e) {
            log.warn(`Glassdoor enrichment failed during partial emission: ${e.message}`);
        }
    };

    try {
        // Homepage warmup — also primes session cookies for the location endpoint.
        await page.goto('https://www.glassdoor.com/index.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(humanDelay(3000, 5000));

        const loc = await resolveGlassdoorLocation(page, location);
        const searchUrl = buildGlassdoorSearchUrl({ keyword: jobTitle, loc });
        const expectedLocToken = loc.remote ? '_IN1' : `_I${loc.locType}${loc.locId}`;
        logProgress('Glassdoor', `Pinned search URL: ${searchUrl}`);

        try {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            throw new NetworkError(`Glassdoor search page.goto failed: ${e.message}`, { platform: 'glassdoor', cause: e });
        }
        await page.waitForTimeout(humanDelay(5000, 8000));

        const probe = await page.evaluate((noResRe) => ({
            finalUrl: window.location.href,
            bodyText: (document.body?.innerText || '').slice(0, 4000),
            cardCount: document.querySelectorAll('.jobCard').length,
            bytes: document.documentElement?.outerHTML?.length ?? 0,
            noResultsText: new RegExp(noResRe, 'i').test(document.body?.innerText || ''),
        }), GLASSDOOR_NO_RESULTS_RE.source);

        const verdict = classifyGlassdoorSearchPage({
            url: probe.finalUrl,
            bodyText: probe.bodyText,
            cardCount: probe.cardCount,
            bytes: probe.bytes,
            noResultsText: probe.noResultsText,
            expectedLocToken,
        });
        logProgress('Glassdoor', `Search page classified: ${verdict.state} (${verdict.signal})`);

        if (verdict.state === 'soft_blocked') {
            throw new BlockedError(`Glassdoor blocked: ${verdict.signal}`, { platform: 'glassdoor', kind: 'cloudflare' });
        }
        if (verdict.state === 'geo_redirected') {
            throw new BlockedError(`Glassdoor geo-redirected the pinned search: ${verdict.signal}`, { platform: 'glassdoor', kind: 'geo-redirect' });
        }
        if (verdict.state === 'empty_confirmed') {
            return { jobs: [], emptyConfirmed: true };
        }
        if (verdict.state === 'dom_changed') {
            throw new DomChangedError(`Glassdoor DOM changed: ${verdict.signal}`, { platform: 'glassdoor' });
        }
        if (verdict.state === 'network_error') {
            throw new NetworkError(`Glassdoor page didn't render: ${verdict.signal}`, { platform: 'glassdoor' });
        }

        // results — load more, then extract via parseGlassdoorCard
        await page.waitForTimeout(humanDelay(2000, 4000));
        await loadAllJobs(page, 30);

        const html = await page.content();
        const pageBaseUrl = page.url();
        const $ = cheerio.load(html);
        let domChangedCount = 0;
        $('.jobCard').each((_, el) => {
            const row = parseGlassdoorCard($, $(el), pageBaseUrl);
            if (!row) return;
            if (row.__domChanged) { domChangedCount++; return; }
            if (rawJobs.some((j) => j.jobId && j.jobId === row.jobId)) return;
            rawJobs.push(row);
        });
        rawJobs = rawJobs.slice(0, 30);
        logProgress('Glassdoor', `Extracted ${rawJobs.length} unique cards (${domChangedCount} dom-changed sentinels)`);

        const totalCards = rawJobs.length + domChangedCount;
        if (totalCards > 0 && domChangedCount / totalCards > 0.30) {
            throw new DomChangedError(`Glassdoor card-level DOM-changed rate too high (${domChangedCount}/${totalCards})`, { platform: 'glassdoor' });
        }
        if (rawJobs.length === 0) {
            // results verdict but nothing extractable — selector drift
            throw new DomChangedError('Glassdoor: results page but 0 extractable cards', { platform: 'glassdoor' });
        }

        await enrichAndCollect();
        logProgress('Glassdoor', `Completed! ${collectedJobs.length} jobs with details`);
        if (collectedJobs.length === 0) return { jobs: [], emptyConfirmed: true };
        return collectedJobs;
    } catch (error) {
        // Partial-result policy: if cards were already extracted, enrich +
        // return them rather than discarding the work.
        if (rawJobs.length > 0 && !(error instanceof BlockedError && error.kind === 'geo-redirect')) {
            await enrichAndCollect();
            if (collectedJobs.length > 0) {
                logProgress('Glassdoor', `Partial return: ${collectedJobs.length} jobs before ${error.name}`);
                return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
            }
        }
        throw error;
    } finally {
        try { await browser.close(); } catch { /* already closed */ }
    }
}
```

NOTE the geo-redirect exclusion in the catch: geo-redirected results are wrong-country data — never return them, even partially.

- [ ] **Step 5:** Delete the now-dead `extractJobsFromHTML` ONLY IF nothing references it (`grep -n "extractJobsFromHTML" scrapers/glassdoor.js` → only the definition). If referenced elsewhere, leave it.

- [ ] **Step 6:** Full suite → all green. Module shape: `node -e "import('./scrapers/glassdoor.js').then(m => console.log(Object.keys(m).sort().join(', ')))"` → expect `GLASSDOOR_NO_RESULTS_RE, buildGlassdoorSearchUrl, classifyGlassdoorSearchPage, parseGlassdoorCard, pickGlassdoorLocation, scrapeGlassdoor, slugifyForGlassdoor`.

- [ ] **Step 7:** Commit `feat(glassdoor): rewrite scrapeGlassdoor — geo-pinned URLs, classifier, typed errors`.

---

## Task 7: Registry + harness

**Files:** modify `src/scrapers/registry.js` (+1 word), create `scripts/test-glassdoor-scrape.js`, modify `package.json`.

- [ ] **Step 1:** Registry: `glassdoor: new BaseScraper('glassdoor', scrapeGlassdoor),` → `glassdoor: new BaseScraper('glassdoor', scrapeGlassdoor, { strictEmpty: true }),`. Touch nothing else.

- [ ] **Step 2:** Create `scripts/test-glassdoor-scrape.js` (mirror of `scripts/test-indeed-scrape.js`, simplified — no cooldown):

```js
#!/usr/bin/env node
// Test harness — runs scrapeGlassdoor live for one role+location and
// analyzes per-job field completeness. Mirrors the other harnesses.
//   npm run glassdoor:test-scrape -- "software engineer"
//   GLASSDOOR_TEST_LOC="California" npm run glassdoor:test-scrape
import { scrapeGlassdoor } from '../scrapers/glassdoor.js';

const role = process.argv.slice(2).join(' ').trim() || 'software engineer';
const loc  = process.env.GLASSDOOR_TEST_LOC || 'United States';
console.log(`Role     : ${role}`);
console.log(`Location : ${loc}\n`);

async function main() {
    const t0 = Date.now();
    let result;
    try {
        result = await scrapeGlassdoor(role, loc, null);
    } catch (e) {
        console.log(`\n❌ Scrape threw ${e.name}${e.kind ? `(${e.kind})` : ''}: ${e.message}`);
        process.exit(2);
    }
    const elapsed = Date.now() - t0;
    const jobs = Array.isArray(result) ? result : result.jobs;
    const emptyConfirmed = Array.isArray(result) ? false : !!result.emptyConfirmed;
    const partial = Array.isArray(result) ? false : !!result.partial;
    console.log(`\n=== Scraped ${jobs.length} job(s) in ${elapsed}ms ===`);
    console.log(`emptyConfirmed=${emptyConfirmed} partial=${partial}\n`);

    let badTitle = 0, badCompany = 0, badUrl = 0, usLoc = 0;
    jobs.forEach((j, i) => {
        const title = j.job?.title ?? '';
        const company = j.company?.name ?? '';
        const url = j.job?.url ?? '';
        const locStr = String(j.location?.formatted ?? j.location ?? '');
        if (!title || title === 'N/A' || title.length <= 1) badTitle++;
        if (!company || company === 'N/A') badCompany++;
        if (!url || url === 'N/A' || !/glassdoor\.(com|co\.in)/.test(url)) badUrl++;
        if (/,\s*[A-Z]{2}\b|United States|Remote/i.test(locStr)) usLoc++;
        if (i < 5) console.log(`#${i + 1} ${title} @ ${company} [${locStr}]\n   ${url}\n`);
    });
    console.log('=== quality ===');
    console.log(`   bad title  : ${badTitle} (must be 0)`);
    console.log(`   bad company: ${badCompany} (must be 0)`);
    console.log(`   bad url    : ${badUrl} (must be 0)`);
    console.log(`   US-shaped locations: ${usLoc}/${jobs.length} (geo check)`);
    if (jobs.length > 0 && (badTitle > 0 || badCompany > 0 || badUrl / jobs.length > 0.1)) {
        console.log('\n⚠ Bad rows detected — extractor likely broken.');
        process.exit(3);
    }
    process.exit(0);
}
main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
```

- [ ] **Step 3:** `package.json` scripts: add `"glassdoor:test-scrape": "node scripts/test-glassdoor-scrape.js",` near the other `*:test-scrape` entries. Verify with `node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).scripts['glassdoor:test-scrape'])"`.

- [ ] **Step 4:** Full suite green; `PLATFORM_NAMES` still includes glassdoor.

- [ ] **Step 5:** Commit `feat(glassdoor): strictEmpty + test-glassdoor-scrape harness`.

---

## Task 8: Live smoke (controller-run)

- [ ] **Step 1:** `npm run glassdoor:test-scrape -- "software engineer"` (location defaults to United States; run from this non-US IP).
Expected: ≥ 20 jobs, 0 bad title/company/url, **US-shaped locations ≥ 90%** (THE geo fix proof), exit 0.
- [ ] **Step 2:** `GLASSDOOR_TEST_LOC="California" npm run glassdoor:test-scrape -- "data scientist"` → state-pin path works.
- [ ] **Step 3:** Any failure → diagnose against the classifier signal printed in the logs, fix, re-run. Commit fixes individually.

## Self-review

- Spec § A → Task 6 Step 3 (+ Task 3 pure selector); § B → Task 2; § C → Task 4; § D → Task 5; § E → preserved (Task 6 keeps detail path); § F → Task 6 Step 4; § G → Tasks 1, 7. Geo fix verified by Task 8 Step 1's US-shaped-location gate.
- No placeholders; all code steps carry full code.
- Type consistency: `loc` object `{locType, locId, slug} | {remote:true}` consistent across Tasks 2, 3, 6; classifier input named args consistent between Tasks 4 and 6; `parseGlassdoorCard($, $card, pageBaseUrl)` consistent between Tasks 5 and 6.
