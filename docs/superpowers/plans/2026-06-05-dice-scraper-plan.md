# Dice Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `scrapers/dice.js` from a working-but-silent scraper into a hardened one (typed errors, page-state classifier, fixture tests, `strictEmpty:true`, debug harness) that keeps the Schema.org JSON-LD path as the canonical extraction surface and drops two probe-confirmed-dead features (recruiter, easyApply).

**Architecture:** A single self-contained `scrapers/dice.js` exports small pure helpers (`parseStructuredData`, `parseSalary`, `parseEmploymentType`, `extractJobFromStructuredData`, `classifyDiceSearchPage`, `extractSkills`, `extractWorkplaceType`) alongside the main `scrapeDice()`. The orchestrator keeps the 2-stage search→detail flow but routes every failure through typed errors and the page-state classifier. `BaseScraper` is configured `strictEmpty:true` for Dice only.

**Tech Stack:** Node 24 + ESM + `node:test` + `node:assert/strict` + `jsdom` (already in deps) for fixture-based DOM tests + `cheerio` (already in deps) for parsing HTML in tests + CloakBrowser (already in deps) for the live runtime.

**Spec:** `docs/superpowers/specs/2026-06-05-dice-scraper-design.md`

---

## Constraints (read before starting)

1. **`scrapers/linkedin.js` and `scrapers/monster.js` MUST NOT be modified** (different platforms; sanity guard).
2. **Pre-existing dirty files MUST stay unstaged:** `.gitignore`, `pnpm-lock.yaml`. Stage files by name; never `git add .` / `git add -A` / `git commit -a`.
3. **No new dependencies.** `jsdom`, `cheerio`, `cloakbrowser`, `crawlee` are already in `package.json`.
4. **Tests:** every pure helper gets a `*.test.js` under `test/scrapers/`. Use `node --test 'test/**/*.test.js'` (quoted glob — bare-dir broken on Node 24 per repo MEMORY).
5. **Every commit ends with** `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
6. **Never echo secrets.** No API keys, no cookies, no passwords in logs.
7. **Live network calls only inside the debug harness** (Task 9) — unit tests must not hit dice.com.
8. **Stage explicitly per task** — do not commit unrelated work.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scrapers/dice.js` | **rewrite** | Full scraper: exports pure helpers + `scrapeDice()` orchestrator. ~280 LOC (down from 361 — recruiter + easyApply dropped) |
| `src/scrapers/registry.js` | **modify** | `dice` entry gets `{strictEmpty:true}` options arg |
| `scripts/test-dice-scrape.js` | **new** | Debug harness mirroring `scripts/test-monster-scrape.js` |
| `package.json` | **modify** | Add `"dice:test-scrape": "node scripts/test-dice-scrape.js"` |
| `test/fixtures/dice-search.html` | **new** | Saved real search page from `/tmp/dice-search.html` |
| `test/fixtures/dice-detail.html` | **new** | Saved real detail page from `/tmp/dice-detail.html` |
| `test/fixtures/dice-structured-data.json` | **new** | Extracted `<script id="jobDetailStructuredData">` JSON from the detail-page fixture |
| `test/scrapers/dice-parse-structured-data.test.js` | **new** | Pure JSON.parse wrapper tests |
| `test/scrapers/dice-parse-salary.test.js` | **new** | Salary mapping tests (range / single / period / missing) |
| `test/scrapers/dice-parse-employment-type.test.js` | **new** | Employment type mapping (single string + array forms) |
| `test/scrapers/dice-extract-job.test.js` | **new** | Composed extractor against the fixture |
| `test/scrapers/dice-classify-page.test.js` | **new** | Pure classifier with inline string inputs |
| `test/scrapers/dice-search-extract.test.js` | **new** | Search-page anchor extraction via jsdom against the fixture |

---

## Task 1: Save fixtures

**Files:**
- Create: `test/fixtures/dice-search.html` (copied from `/tmp/dice-search.html`)
- Create: `test/fixtures/dice-detail.html` (copied from `/tmp/dice-detail.html`)
- Create: `test/fixtures/dice-structured-data.json` (extracted from the detail page)

- [ ] **Step 1: Confirm source artifacts exist**

Run: `ls -la /tmp/dice-search.html /tmp/dice-detail.html`
Expected: both files exist, non-zero size (the search page is ~360 KB, the detail page is ~200-500 KB).

If either is missing (e.g. system rebooted), regenerate by running `node scripts/dice-deep-probe.mjs` first (takes ~3 min — the probe writes both files into `/tmp/`).

- [ ] **Step 2: Copy the two HTML fixtures**

```bash
mkdir -p test/fixtures
cp /tmp/dice-search.html test/fixtures/dice-search.html
cp /tmp/dice-detail.html test/fixtures/dice-detail.html
```

- [ ] **Step 3: Extract the structured-data JSON from the detail fixture**

Run this one-liner to pull the `<script id="jobDetailStructuredData">` body out of the detail HTML and save it as parseable JSON:

```bash
node -e '
const fs = require("fs");
const html = fs.readFileSync("test/fixtures/dice-detail.html","utf-8");
const m = html.match(/<script[^>]*id=["\x27]jobDetailStructuredData["\x27][^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error("no jobDetailStructuredData script found"); process.exit(1); }
const obj = JSON.parse(m[1]);
fs.writeFileSync("test/fixtures/dice-structured-data.json", JSON.stringify(obj, null, 2));
console.log("ok wrote", JSON.stringify(obj).length, "bytes; @type=", obj["@type"], "title=", obj.title);
'
```

Expected output: `ok wrote <N> bytes; @type= JobPosting title= <real title>`. If it errors with "no jobDetailStructuredData script found," the detail fixture is malformed — re-run the deep probe to regenerate `/tmp/dice-detail.html`.

- [ ] **Step 4: Verify all three fixtures**

```bash
wc -c test/fixtures/dice-{search,detail}.html test/fixtures/dice-structured-data.json
node -e 'const j=require("./test/fixtures/dice-structured-data.json"); console.log("@type=", j["@type"], "fields=", Object.keys(j).length)'
```

Expected: HTML fixtures both > 100 KB; JSON fixture has `@type === "JobPosting"` and several fields.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/dice-search.html test/fixtures/dice-detail.html test/fixtures/dice-structured-data.json
git commit -m "$(cat <<'EOF'
test(dice): commit live search + detail + structured-data fixtures

Saved from the deep probe at /tmp. Used as the ground-truth fixtures for
pure-extractor tests in subsequent tasks so we don't have to hit dice.com
from CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pure parser — `parseStructuredData`

**Files:**
- Modify: `scrapers/dice.js` (export `parseStructuredData`)
- Create: `test/scrapers/dice-parse-structured-data.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/dice-parse-structured-data.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStructuredData } from '../../scrapers/dice.js';

const FIXTURE = fs.readFileSync(new URL('../fixtures/dice-structured-data.json', import.meta.url), 'utf-8');

test('parseStructuredData: real fixture parses to a JobPosting object', () => {
    const { data, error } = parseStructuredData(FIXTURE);
    assert.equal(error, null);
    assert.equal(data['@type'], 'JobPosting');
    assert.ok(data.title.length > 0);
});

test('parseStructuredData: empty string → error', () => {
    const { data, error } = parseStructuredData('');
    assert.equal(data, null);
    assert.match(error, /empty/i);
});

test('parseStructuredData: null/undefined → error', () => {
    assert.equal(parseStructuredData(null).data, null);
    assert.match(parseStructuredData(null).error, /empty/i);
    assert.equal(parseStructuredData(undefined).data, null);
});

test('parseStructuredData: malformed JSON → error', () => {
    const { data, error } = parseStructuredData('{"unterminated":');
    assert.equal(data, null);
    assert.match(error, /JSON|parse/i);
});

test('parseStructuredData: non-object JSON → error', () => {
    const { data, error } = parseStructuredData('"a string"');
    assert.equal(data, null);
    assert.match(error, /object/i);
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `node --test 'test/scrapers/dice-parse-structured-data.test.js'`
Expected: FAIL — `parseStructuredData is not a function`.

- [ ] **Step 3: Add the helper in `scrapers/dice.js`**

Open `scrapers/dice.js`. Locate the existing top of the file (imports + `log` + `logProgress` helper). After the existing imports and before the first existing function, insert:

```js
// Parses the body of <script id="jobDetailStructuredData">. Pure given a
// string. Returns {data, error}: data is the parsed object on success,
// or null with a human-readable error string. The caller turns the
// error into a typed ParseError or DomChangedError depending on context.
export function parseStructuredData(scriptText) {
    if (scriptText === null || scriptText === undefined || scriptText === '') {
        return { data: null, error: 'empty structured-data script body' };
    }
    let parsed;
    try { parsed = JSON.parse(scriptText); }
    catch (e) { return { data: null, error: `JSON parse failed: ${e.message}` }; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { data: null, error: 'structured data is not an object' };
    }
    return { data: parsed, error: null };
}
```

DO NOT modify the existing `scrapeDice`, `fetchRecruiterProfile`, or any other function yet — those go in later tasks.

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test 'test/scrapers/dice-parse-structured-data.test.js'`
Expected: PASS (5 tests).

Then: `node --test 'test/**/*.test.js'`
Expected: full suite passes (240 baseline + 5 new = 245).

- [ ] **Step 5: Commit**

```bash
git add scrapers/dice.js test/scrapers/dice-parse-structured-data.test.js
git commit -m "$(cat <<'EOF'
feat(dice): parseStructuredData — pure JSON.parse wrapper

Returns {data, error} so the caller can choose ParseError vs
DomChangedError vs silent-skip semantics. Replaces the silent return
the current scraper does when the script body is missing or unparseable.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure parser — `parseSalary`

**Files:**
- Modify: `scrapers/dice.js` (export `parseSalary`)
- Create: `test/scrapers/dice-parse-salary.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/dice-parse-salary.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary } from '../../scrapers/dice.js';

test('parseSalary: modern MonetaryAmount range with year period', () => {
    const r = parseSalary({
        '@type': 'MonetaryAmount',
        currency: 'USD',
        minValue: 60000,
        maxValue: 65000,
        unitText: 'YEAR',
    });
    assert.equal(r.min, 60000);
    assert.equal(r.max, 65000);
    assert.equal(r.currency, 'USD');
    assert.equal(r.period, 'YEAR');
    assert.equal(r.formatted, '$60,000 - $65,000/yr');
});

test('parseSalary: hourly variant', () => {
    const r = parseSalary({ minValue: 40, maxValue: 60, unitText: 'HOUR', currency: 'USD' });
    assert.equal(r.formatted, '$40 - $60/hr');
});

test('parseSalary: single value (no max)', () => {
    const r = parseSalary({ minValue: 100000, unitText: 'YEAR', currency: 'USD' });
    assert.equal(r.min, 100000);
    assert.equal(r.max, null);
    assert.equal(r.formatted, '$100,000/yr');
});

test('parseSalary: legacy nested value.minValue shape', () => {
    const r = parseSalary({ value: { minValue: 50000, maxValue: 70000 }, currency: 'USD' });
    assert.equal(r.min, 50000);
    assert.equal(r.max, 70000);
});

test('parseSalary: missing baseSalary → all null', () => {
    const r = parseSalary(null);
    assert.deepEqual(r, { min: null, max: null, currency: 'USD', period: null, formatted: 'N/A' });
});

test('parseSalary: undefined → all null', () => {
    const r = parseSalary(undefined);
    assert.equal(r.formatted, 'N/A');
});

test('parseSalary: no period → no suffix in formatted', () => {
    const r = parseSalary({ minValue: 70000, maxValue: 90000, currency: 'USD' });
    assert.equal(r.period, null);
    assert.equal(r.formatted, '$70,000 - $90,000');
});

test('parseSalary: non-USD currency preserved', () => {
    const r = parseSalary({ minValue: 50000, maxValue: 70000, currency: 'EUR', unitText: 'YEAR' });
    assert.equal(r.currency, 'EUR');
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `node --test 'test/scrapers/dice-parse-salary.test.js'`
Expected: FAIL — `parseSalary is not a function`.

- [ ] **Step 3: Add the helper in `scrapers/dice.js`**

Insert this code in `scrapers/dice.js` IMMEDIATELY AFTER the existing `parseStructuredData` function (which ends with `return { data: parsed, error: null }; }`):

```js
// Parses the baseSalary block from a JobPosting JSON-LD. Handles both
// the modern "MonetaryAmount" shape (minValue/maxValue at top level) and
// the legacy "value.minValue" nested shape. Returns a stable object with
// {min, max, currency, period, formatted}. The formatted string is the
// human-readable label downstream UIs render.
export function parseSalary(baseSalary) {
    const fallback = { min: null, max: null, currency: 'USD', period: null, formatted: 'N/A' };
    if (baseSalary === null || baseSalary === undefined) return fallback;
    const min = baseSalary.minValue ?? baseSalary.value?.minValue ?? null;
    const max = baseSalary.maxValue ?? baseSalary.value?.maxValue ?? null;
    const currency = baseSalary.currency || 'USD';
    const period = baseSalary.unitText || null;
    if (min === null && max === null) return { ...fallback, currency, period };
    const fmt = (v) => (v !== null && v !== undefined) ? `$${Number(v).toLocaleString()}` : null;
    const suffix = period === 'HOUR' ? '/hr' : period === 'YEAR' ? '/yr' : '';
    const formatted = [fmt(min), fmt(max)].filter(Boolean).join(' - ') + suffix;
    return { min, max, currency, period, formatted };
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test 'test/scrapers/dice-parse-salary.test.js'`
Expected: PASS (8 tests).

Then: `node --test 'test/**/*.test.js'`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add scrapers/dice.js test/scrapers/dice-parse-salary.test.js
git commit -m "$(cat <<'EOF'
feat(dice): parseSalary — stable {min,max,currency,period,formatted}

Handles modern MonetaryAmount shape AND the legacy value.minValue
fallback. Defaults to a clean N/A row when baseSalary is missing.
Eliminates the inline ternary-chain in the current scraper.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pure parser — `parseEmploymentType`

**Files:**
- Modify: `scrapers/dice.js` (export `parseEmploymentType`)
- Create: `test/scrapers/dice-parse-employment-type.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/dice-parse-employment-type.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmploymentType } from '../../scrapers/dice.js';

test('parseEmploymentType: FULL_TIME → full_time', () => {
    assert.equal(parseEmploymentType('FULL_TIME'), 'full_time');
});

test('parseEmploymentType: PART_TIME → part_time', () => {
    assert.equal(parseEmploymentType('PART_TIME'), 'part_time');
});

test('parseEmploymentType: CONTRACTOR → contract', () => {
    assert.equal(parseEmploymentType('CONTRACTOR'), 'contract');
});

test('parseEmploymentType: TEMPORARY → temporary', () => {
    assert.equal(parseEmploymentType('TEMPORARY'), 'temporary');
});

test('parseEmploymentType: INTERN → internship', () => {
    assert.equal(parseEmploymentType('INTERN'), 'internship');
});

test('parseEmploymentType: array form → comma-separated', () => {
    assert.equal(parseEmploymentType(['FULL_TIME', 'PART_TIME']), 'full_time, part_time');
});

test('parseEmploymentType: unknown string → lowercase passthrough', () => {
    assert.equal(parseEmploymentType('SOMETHING_NEW'), 'something_new');
});

test('parseEmploymentType: null / undefined / empty → N/A', () => {
    assert.equal(parseEmploymentType(null), 'N/A');
    assert.equal(parseEmploymentType(undefined), 'N/A');
    assert.equal(parseEmploymentType(''), 'N/A');
});

test('parseEmploymentType: empty array → N/A', () => {
    assert.equal(parseEmploymentType([]), 'N/A');
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `node --test 'test/scrapers/dice-parse-employment-type.test.js'`
Expected: FAIL — `parseEmploymentType is not a function`.

- [ ] **Step 3: Add the helper in `scrapers/dice.js`**

Insert this code IMMEDIATELY AFTER `parseSalary`:

```js
const EMPLOYMENT_TYPE_MAP = Object.freeze({
    FULL_TIME: 'full_time',
    PART_TIME: 'part_time',
    CONTRACTOR: 'contract',
    TEMPORARY: 'temporary',
    INTERN: 'internship',
});

// Maps Dice's employmentType (single string or array of strings) into our
// canonical lower-snake_case form. Unknown values pass through lowercased.
// Missing/empty → 'N/A' (matches the rest of the normalize.js defaults).
export function parseEmploymentType(rawType) {
    if (rawType === null || rawType === undefined || rawType === '') return 'N/A';
    if (Array.isArray(rawType)) {
        if (rawType.length === 0) return 'N/A';
        return rawType.map((t) => EMPLOYMENT_TYPE_MAP[t] ?? String(t).toLowerCase()).join(', ');
    }
    return EMPLOYMENT_TYPE_MAP[rawType] ?? String(rawType).toLowerCase();
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test 'test/scrapers/dice-parse-employment-type.test.js'`
Expected: PASS (9 tests).

Then: `node --test 'test/**/*.test.js'`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add scrapers/dice.js test/scrapers/dice-parse-employment-type.test.js
git commit -m "$(cat <<'EOF'
feat(dice): parseEmploymentType — canonical lower-snake_case mapper

Handles single-string + array forms of Dice's employmentType field.
Unknown values pass through lowercased; missing/empty defaults to 'N/A'
so downstream rows stay schema-consistent.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Composed extractor — `extractJobFromStructuredData`

**Files:**
- Modify: `scrapers/dice.js` (export `extractJobFromStructuredData`)
- Create: `test/scrapers/dice-extract-job.test.js`

`extractJobFromStructuredData(jsonLd, requestUrl)` is the canonical Node-side mapping function. It returns a flat object the orchestrator will pass to `normalizeJobData`. Returns the special `{__domChanged: true, reason}` sentinel when required fields are missing, mirroring the Monster pattern.

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/dice-extract-job.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractJobFromStructuredData } from '../../scrapers/dice.js';

const FIXTURE_JSON = JSON.parse(fs.readFileSync(new URL('../fixtures/dice-structured-data.json', import.meta.url), 'utf-8'));

test('extractJobFromStructuredData: fixture yields a valid row', () => {
    const r = extractJobFromStructuredData(FIXTURE_JSON, 'https://www.dice.com/job-detail/abc');
    assert.ok(r, 'should not be null');
    assert.ok(!r.__domChanged, `expected non-sentinel result, got: ${JSON.stringify(r)}`);
    assert.ok(r.title.length > 0);
    assert.ok(r.company.length > 0);
    assert.equal(typeof r.url, 'string');
});

test('extractJobFromStructuredData: missing title → __domChanged sentinel', () => {
    const r = extractJobFromStructuredData({ '@type': 'JobPosting', hiringOrganization: { name: 'X' } }, 'https://x');
    assert.deepEqual(r, { __domChanged: true, reason: 'missing_title' });
});

test('extractJobFromStructuredData: missing hiringOrganization.name → __domChanged sentinel', () => {
    const r = extractJobFromStructuredData({ '@type': 'JobPosting', title: 'Engineer' }, 'https://x');
    assert.deepEqual(r, { __domChanged: true, reason: 'missing_company' });
});

test('extractJobFromStructuredData: TELECOMMUTE → isRemote true', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'Engineer',
        hiringOrganization: { name: 'X' },
        jobLocationType: 'TELECOMMUTE',
    }, 'https://x');
    assert.equal(r.isRemote, true);
});

test('extractJobFromStructuredData: array employmentType collapsed to string', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'Engineer',
        hiringOrganization: { name: 'X' },
        employmentType: ['FULL_TIME', 'PART_TIME'],
    }, 'https://x');
    assert.equal(r.employmentType, 'full_time, part_time');
});

test('extractJobFromStructuredData: identifier.value populates jobId; falls back to URL tail', () => {
    const withId = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
        identifier: { '@type': 'PropertyValue', value: 'uuid-here' },
    }, 'https://www.dice.com/job-detail/xyz');
    assert.equal(withId.jobId, 'uuid-here');

    const noId = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
    }, 'https://www.dice.com/job-detail/url-tail');
    assert.equal(noId.jobId, 'url-tail');
});

test('extractJobFromStructuredData: jobLocation.address parses into city+state', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
        jobLocation: { address: { addressLocality: 'Salt Lake City', addressRegion: 'UT' } },
    }, 'https://x');
    assert.equal(r.city, 'Salt Lake City');
    assert.equal(r.state, 'UT');
    assert.equal(r.locationFormatted, 'Salt Lake City, UT');
});

test('extractJobFromStructuredData: ISO dates parsed to YYYY-MM-DD', () => {
    const r = extractJobFromStructuredData({
        '@type': 'JobPosting', title: 'X', hiringOrganization: { name: 'Y' },
        datePosted: '2026-05-15T08:30:00Z',
        validThrough: '2026-06-15T08:30:00Z',
    }, 'https://x');
    assert.equal(r.postedDate, '2026-05-15');
    assert.equal(r.validThrough, '2026-06-15');
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `node --test 'test/scrapers/dice-extract-job.test.js'`
Expected: FAIL — `extractJobFromStructuredData is not a function`.

- [ ] **Step 3: Add the extractor in `scrapers/dice.js`**

Insert this code IMMEDIATELY AFTER `parseEmploymentType`:

```js
// Maps a JobPosting JSON-LD object into the flat record we pass to
// normalizeJobData. Returns the row on success, or
// { __domChanged: true, reason } when a load-bearing field is missing —
// caller aggregates these and throws DomChangedError when the rate
// crosses the batch threshold (Section E of the spec).
export function extractJobFromStructuredData(jsonLd, requestUrl) {
    if (!jsonLd?.title) return { __domChanged: true, reason: 'missing_title' };
    const company = jsonLd?.hiringOrganization?.name;
    if (!company) return { __domChanged: true, reason: 'missing_company' };

    const jobId = jsonLd.identifier?.value || String(requestUrl).split('/').filter(Boolean).pop();
    const addr = jsonLd.jobLocation?.address ?? {};
    const city = addr.addressLocality ?? null;
    const state = addr.addressRegion ?? null;
    const country = addr.addressCountry ?? null;
    const locationFormatted = city && state ? `${city}, ${state}` : (city || state || 'N/A');
    const isRemote = jsonLd.jobLocationType === 'TELECOMMUTE';

    const salary = parseSalary(jsonLd.baseSalary);
    const employmentType = parseEmploymentType(jsonLd.employmentType);

    const fmtDate = (v) => {
        if (!v) return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().split('T')[0];
    };

    return {
        jobId,
        title: jsonLd.title,
        company,
        companyProfileUrl: jsonLd.hiringOrganization?.sameAs ?? null,
        companyLogoUrl: jsonLd.hiringOrganization?.logo ?? null,
        locationFormatted,
        city,
        state,
        country,
        isRemote,
        salaryFormatted: salary.formatted,
        salaryMin: salary.min,
        salaryMax: salary.max,
        salaryCurrency: salary.currency,
        salaryPeriod: salary.period,
        employmentType,
        postedDate: fmtDate(jsonLd.datePosted),
        validThrough: fmtDate(jsonLd.validThrough),
        description: jsonLd.description ?? '',
        url: jsonLd.url || requestUrl,
    };
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test 'test/scrapers/dice-extract-job.test.js'`
Expected: PASS (8 tests).

Then: `node --test 'test/**/*.test.js'`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add scrapers/dice.js test/scrapers/dice-extract-job.test.js
git commit -m "$(cat <<'EOF'
feat(dice): extractJobFromStructuredData — composed extractor + sentinels

Pure mapping from JobPosting JSON-LD to a flat record. Returns
{__domChanged, reason} when title or hiringOrganization.name is missing,
mirroring Monster's aria-label sentinel pattern. Orchestrator aggregates
sentinels and throws DomChangedError when the batch rate is too high.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Page-state classifier — `classifyDiceSearchPage`

**Files:**
- Modify: `scrapers/dice.js` (export `classifyDiceSearchPage`)
- Create: `test/scrapers/dice-classify-page.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/dice-classify-page.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiceSearchPage } from '../../scrapers/dice.js';

test('classifyDiceSearchPage: anchors > 0 → results', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'Search Results 1 - 60 of...',
        anchorCount: 60,
        bytes: 350_000,
    });
    assert.equal(r.state, 'results');
});

test('classifyDiceSearchPage: "no jobs found" text + 0 anchors → empty_confirmed', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=unobtainium&page=1',
        bodyText: 'No jobs found matching your search.',
        anchorCount: 0,
        bytes: 280_000,
    });
    assert.equal(r.state, 'empty_confirmed');
});

test('classifyDiceSearchPage: Cloudflare interstitial → soft_blocked', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'Please verify you are human. Ray ID: abc123. Cloudflare.',
        anchorCount: 0,
        bytes: 12_000,
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyDiceSearchPage: 0 anchors + no empty text + large rendered page → dom_changed', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'Some long marketing page with totally different structure that did render fully.',
        anchorCount: 0,
        bytes: 200_000,
    });
    assert.equal(r.state, 'dom_changed');
});

test('classifyDiceSearchPage: 0 anchors + small body + no signal → network_error', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: '',
        anchorCount: 0,
        bytes: 8_000,
    });
    assert.equal(r.state, 'network_error');
});

test('classifyDiceSearchPage: cards present but Cloudflare text → soft_blocked still wins', () => {
    // Defensive: if both signals are present somehow, the block signal
    // is canonical because cards could be a stale prerender.
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'access denied — verify human',
        anchorCount: 60,
        bytes: 350_000,
    });
    assert.equal(r.state, 'soft_blocked');
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `node --test 'test/scrapers/dice-classify-page.test.js'`
Expected: FAIL — `classifyDiceSearchPage is not a function`.

- [ ] **Step 3: Add the classifier in `scrapers/dice.js`**

Insert this code IMMEDIATELY AFTER `extractJobFromStructuredData`:

```js
// Pure page-state classifier for the search-results page.
//   results          → real results page, anchors are extractable
//   empty_confirmed  → real "0 results" page (no false alarm)
//   soft_blocked     → Cloudflare / access-denied page (defensive)
//   dom_changed      → page rendered fully but the anchors we expect are absent
//   network_error    → page didn't render meaningfully (small body, nothing positive)
const DICE_DOM_CHANGED_BYTES_THRESHOLD = 50_000;

export function classifyDiceSearchPage({ url, bodyText, anchorCount, bytes }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/cloudflare|access denied|please verify|ray id|verify you are human/i.test(t) ||
        /captcha|challenge/i.test(u)) {
        return { state: 'soft_blocked', signal: 'cloudflare-style block page' };
    }
    if (anchorCount > 0) {
        return { state: 'results', signal: `anchors=${anchorCount}` };
    }
    if (/no jobs (found|match)|0 results/i.test(t)) {
        return { state: 'empty_confirmed', signal: 'no-jobs-found text' };
    }
    if ((bytes ?? 0) >= DICE_DOM_CHANGED_BYTES_THRESHOLD) {
        return { state: 'dom_changed', signal: `large render (${bytes}b) but 0 anchors and no empty-results text` };
    }
    return { state: 'network_error', signal: `small body (${bytes}b), no positive signal` };
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test 'test/scrapers/dice-classify-page.test.js'`
Expected: PASS (6 tests).

Then: `node --test 'test/**/*.test.js'`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add scrapers/dice.js test/scrapers/dice-classify-page.test.js
git commit -m "$(cat <<'EOF'
feat(dice): classifyDiceSearchPage — pure page-state classifier

Mirrors Monster's classifier. Disambiguates "0 anchors" into one of:
empty_confirmed (real 0 results), soft_blocked (Cloudflare interstitial),
dom_changed (page rendered but selectors stale), network_error (small/
empty body — page didn't load).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Search-page jsdom extraction test

**Files:**
- Create: `test/scrapers/dice-search-extract.test.js`

This task adds a fixture-driven test that exercises the search-page selector waterfall against the saved search HTML. It uses jsdom (already in deps) the same way Monster does.

- [ ] **Step 1: Write the test**

Create `test/scrapers/dice-search-extract.test.js`:

```js
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
    assert.ok(urls.length >= 30, `expected at least 30 unique URLs, got ${urls.length}`);
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
```

- [ ] **Step 2: Run test, verify PASS**

Run: `node --test 'test/scrapers/dice-search-extract.test.js'`
Expected: PASS (3 tests). This test only depends on the fixture + jsdom; no scraper code change.

Note: this is a fixture-verification test, not a function-under-test test. It locks the assumption that the saved search HTML has anchors discoverable by both selectors. If a future Dice DOM rotation breaks the primary selector, this test goes red and forces a fixture refresh.

- [ ] **Step 3: Commit**

```bash
git add test/scrapers/dice-search-extract.test.js
git commit -m "$(cat <<'EOF'
test(dice): search-page jsdom fixture test — selector waterfall lock

Verifies the saved search-results fixture surfaces job-detail anchors
via both the primary selector (a[href*=/job-detail/]) and the backup
([data-testid*=job-card] a[...]). Forces a fixture refresh when Dice
rotates either selector in production.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rewrite `scrapeDice` orchestrator

**Files:**
- Modify: `scrapers/dice.js` — rewrite the orchestrator body; delete `fetchRecruiterProfile`; delete inline recruiterId + easyApply RSC sniffs

This is the largest task. The pure helpers from Tasks 2-6 are now composed into a browser-driven 2-stage loop with typed errors, classifier, and partial-result policy.

- [ ] **Step 1: Read the current orchestrator and recruiter helper**

Run: `sed -n '20,70p' scrapers/dice.js` and `sed -n '65,360p' scrapers/dice.js | head -100` to confirm:
- `fetchRecruiterProfile(recruiterId, browser)` lives at the top of the file
- `scrapeDice(jobTitle, location)` is the exported entry point with a `CheerioCrawler` per-job handler

This task replaces both.

- [ ] **Step 2: Apply the edits**

In `scrapers/dice.js`:

(a) **Add an import** alongside the existing imports at the top:

```js
import { BlockedError, DomChangedError, NetworkError, ParseError } from '../src/core/errors.js';
```

(b) **Delete the entire `async function fetchRecruiterProfile(...)` function** (it lives at the top of the file, ~40 lines).

(c) **Replace the entire `export async function scrapeDice(jobTitle, location) { ... }` function** (find the current export and remove everything from that line through its closing `}` including the `finally` block). Replace with:

```js
const CONFIG = {
    MAX_PAGES: 5,
    MAX_JOBS: 100,
    SEARCH_NAV_TIMEOUT_MS: 30000,
    SEARCH_RENDER_WAIT_MS: 2000,
    DETAIL_NAV_TIMEOUT_MS: 30000,
    DETAIL_RENDER_WAIT_MS: 2000,
    DETAIL_CONCURRENCY: 10,
    DETAIL_CONTEXTS: 5,
    DETAIL_DOM_CHANGED_THRESHOLD: 0.30,  // > 30% bad rows = batch DOM changed
};

export function buildSearchUrl(jobTitle, location, pageNum) {
    const q = encodeURIComponent(jobTitle);
    const w = encodeURIComponent(location);
    return `https://www.dice.com/jobs?q=${q}&location=${w}&filters.postedDate=SEVEN&page=${pageNum}`;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function scrapeDice(jobTitle, location, sessionId = null) {
    void sessionId;
    logProgress('Dice', `Searching for "${jobTitle}" in "${location}"`);
    const browser = await launch({ headless: true });
    const contextsToCleanup = [];
    const collectedJobs = [];
    let collectedAnything = false;

    try {
        // ─── Stage 1: search-page URL collection ──────────────────────────
        const searchContext = await browser.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 } });
        contextsToCleanup.push(searchContext);
        const searchPage = await searchContext.newPage();
        const seenUrls = new Set();
        const jobUrls = [];
        let consecutiveEmpty = 0;

        for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES && jobUrls.length < CONFIG.MAX_JOBS; pageNum++) {
            const url = buildSearchUrl(jobTitle, location, pageNum);
            logProgress('Dice', `Search page ${pageNum}: ${url}`);
            try {
                await searchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.SEARCH_NAV_TIMEOUT_MS });
            } catch (e) {
                if (jobUrls.length === 0) throw new NetworkError(`Dice search goto failed: ${e.message}`, { platform: 'dice', cause: e });
                logProgress('Dice', `Search page ${pageNum} nav failed — returning ${jobUrls.length} URLs collected so far`);
                break;
            }
            // Soft wait for the cards (best-effort — classifier owns the verdict).
            await searchPage.waitForSelector('a[href*="/job-detail/"]', { timeout: 5000 }).catch(() => {});

            const probe = await searchPage.evaluate(() => {
                const primary = [...new Set([...document.querySelectorAll('a[href*="/job-detail/"]')]
                    .map((a) => a.href).filter(Boolean))];
                const backup = [...new Set([...document.querySelectorAll('[data-testid*="job-card"] a[href*="/job-detail/"]')]
                    .map((a) => a.href).filter(Boolean))];
                return {
                    bodyText: (document.body?.innerText || '').slice(0, 4000),
                    bytes: document.documentElement?.outerHTML?.length ?? 0,
                    primary,
                    backup,
                };
            });
            const anchors = probe.primary.length > 0 ? probe.primary : probe.backup;
            const verdict = classifyDiceSearchPage({
                url: searchPage.url(),
                bodyText: probe.bodyText,
                anchorCount: anchors.length,
                bytes: probe.bytes,
            });
            logProgress('Dice', `Page ${pageNum} classified: ${verdict.state} (${verdict.signal})`);

            if (verdict.state === 'soft_blocked') {
                if (jobUrls.length === 0) throw new BlockedError(`Dice blocked: ${verdict.signal}`, { platform: 'dice', kind: 'cloudflare' });
                break;
            }
            if (verdict.state === 'dom_changed') {
                if (jobUrls.length === 0) throw new DomChangedError(`Dice DOM changed: ${verdict.signal}`, { platform: 'dice' });
                break;
            }
            if (verdict.state === 'network_error') {
                if (jobUrls.length === 0) throw new NetworkError(`Dice search didn't render: ${verdict.signal}`, { platform: 'dice' });
                break;
            }
            if (verdict.state === 'empty_confirmed') {
                consecutiveEmpty++;
                if (consecutiveEmpty >= 2) break;
                continue;
            }
            // results
            let newCount = 0;
            for (const u of anchors) {
                if (seenUrls.has(u)) continue;
                seenUrls.add(u);
                jobUrls.push(u);
                newCount++;
                if (jobUrls.length >= CONFIG.MAX_JOBS) break;
            }
            logProgress('Dice', `Page ${pageNum}: ${anchors.length} anchors, ${newCount} new unique, total: ${jobUrls.length}`);
            if (newCount === 0) consecutiveEmpty++; else consecutiveEmpty = 0;
            if (consecutiveEmpty >= 2) break;
        }
        await searchContext.close();

        if (jobUrls.length === 0) {
            // Reached natural end-of-results without throwing — confirmed empty.
            return { jobs: [], emptyConfirmed: true };
        }

        // ─── Stage 2: per-job detail extraction ───────────────────────────
        const jobsToProcess = jobUrls.slice(0, CONFIG.MAX_JOBS);
        const jobContexts = [];
        for (let i = 0; i < CONFIG.DETAIL_CONTEXTS; i++) {
            const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true, bypassCSP: true });
            jobContexts.push(ctx);
            contextsToCleanup.push(ctx);
        }
        let ctxRR = 0;
        const getCtx = () => { const c = jobContexts[ctxRR]; ctxRR = (ctxRR + 1) % jobContexts.length; return c; };

        let domChangedCount = 0;
        let processedCount = 0;

        const crawler = new CheerioCrawler({
            maxConcurrency: CONFIG.DETAIL_CONCURRENCY,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 180,
            async requestHandler({ request }) {
                processedCount++;
                logProgress('Dice', `Detail ${processedCount}/${jobsToProcess.length}: ${request.url}`);
                const jobPage = await getCtx().newPage();
                let pageHtml = '';
                try {
                    await jobPage.goto(request.url, { waitUntil: 'domcontentloaded', timeout: CONFIG.DETAIL_NAV_TIMEOUT_MS });
                    await jobPage.waitForTimeout(CONFIG.DETAIL_RENDER_WAIT_MS);
                    pageHtml = await jobPage.content();
                } catch (e) {
                    logProgress('Dice', `Detail nav failed: ${request.url} — ${e.message}`);
                    try { await jobPage.close(); } catch {}
                    return;
                } finally {
                    try { await jobPage.close(); } catch {}
                }

                const $job = cheerio.load(pageHtml);
                const scriptBody = $job('script[id="jobDetailStructuredData"]').html();
                const { data: jsonLd, error: parseErr } = parseStructuredData(scriptBody ?? '');
                if (parseErr) {
                    logProgress('Dice', `Detail dropped (${parseErr}): ${request.url}`);
                    domChangedCount++;
                    return;
                }
                if (jsonLd['@type'] !== 'JobPosting') {
                    logProgress('Dice', `Detail dropped (@type=${jsonLd['@type']}): ${request.url}`);
                    domChangedCount++;
                    return;
                }
                const row = extractJobFromStructuredData(jsonLd, request.url);
                if (row.__domChanged) {
                    logProgress('Dice', `Detail dropped (${row.reason}): ${request.url}`);
                    domChangedCount++;
                    return;
                }
                // Skills + workplace type still pulled via Cheerio.
                const skills = extractSkills($job);
                const workplaceType = extractWorkplaceType($job);

                const normalized = normalizeJobData({
                    id: row.jobId,
                    title: row.title,
                    company: row.company,
                    companyProfileUrl: row.companyProfileUrl,
                    companyLogoUrl: row.companyLogoUrl,
                    location: row.locationFormatted,
                    city: row.city,
                    state: row.state,
                    country: row.country,
                    isRemote: row.isRemote,
                    workplaceType,
                    salary: row.salaryFormatted,
                    salary_min: row.salaryMin,
                    salary_max: row.salaryMax,
                    salary_currency: row.salaryCurrency,
                    salary_period: row.salaryPeriod,
                    postedDate: row.postedDate,
                    validThrough: row.validThrough,
                    description: stripHtmlTags(row.description),
                    employmentType: row.employmentType,
                    skills,
                    url: row.url,
                }, 'Dice');
                collectedJobs.push(normalized);
                collectedAnything = true;
                logProgress('Dice', `✅ ${row.title} at ${row.company} (total ${collectedJobs.length})`);
            },
        });

        await crawler.run(jobsToProcess.map((url) => ({ url })));

        // Batch-level DOM-changed gate.
        if (processedCount > 0) {
            const rate = domChangedCount / processedCount;
            if (rate > CONFIG.DETAIL_DOM_CHANGED_THRESHOLD) {
                if (collectedAnything) {
                    return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                }
                throw new DomChangedError(
                    `Dice detail-page DOM-changed rate too high (${domChangedCount}/${processedCount}, threshold ${CONFIG.DETAIL_DOM_CHANGED_THRESHOLD})`,
                    { platform: 'dice' },
                );
            }
        }

        logProgress('Dice', `Completed: ${collectedJobs.length} jobs (${domChangedCount}/${processedCount} dropped)`);
        if (collectedJobs.length === 0) return { jobs: [], emptyConfirmed: true };
        return collectedJobs;
    } finally {
        for (const ctx of contextsToCleanup) {
            try { await ctx.close(); } catch (err) { log.warn(`Failed to close context: ${err.message}`); }
        }
        try { await browser.close(); } catch (err) { log.warn(`Failed to close browser: ${err.message}`); }
    }
}
```

(d) The `extractSkills` and `extractWorkplaceType` helpers are referenced inside the requestHandler but not yet defined. Insert them ALONGSIDE the other pure helpers (e.g. right after `classifyDiceSearchPage`). Both take a Cheerio instance:

```js
// Reads the skills list from the rendered detail page. The Skills heading
// is an <h3>; the list is the immediately-following <ul>. Returns [] when
// the heading is absent (Dice has been known to ship pages without it).
export function extractSkills($job) {
    const skills = [];
    const heading = $job('h3').filter((_, el) => $job(el).text().trim() === 'Skills');
    if (!heading.length) return skills;
    heading.next('ul').find('li').each((_, el) => {
        const v = $job(el).text().trim();
        if (v) skills.push(v);
    });
    return skills;
}

// Reads the workplace-type badge text (e.g. "Remote", "Hybrid", "On-site").
// Returns null when absent.
export function extractWorkplaceType($job) {
    const badge = $job('[data-testid="locationTypeBadge"]');
    if (!badge.length) return null;
    return badge.text().trim() || null;
}
```

- [ ] **Step 3: Run the full test suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all green. The new orchestrator only uses already-tested helpers (Tasks 2-6). Existing tests should pass without modification.

- [ ] **Step 4: Smoke-verify module shape**

Run:
```bash
node -e "import('./scrapers/dice.js').then(m => console.log(Object.keys(m).sort().join(', ')))"
```
Expected: includes at minimum `buildSearchUrl, classifyDiceSearchPage, extractJobFromStructuredData, extractSkills, extractWorkplaceType, parseEmploymentType, parseSalary, parseStructuredData, scrapeDice`.

- [ ] **Step 5: Commit**

```bash
git add scrapers/dice.js
git commit -m "$(cat <<'EOF'
feat(dice): rewrite scrapeDice — typed errors, classifier, partial results, no recruiter

- Search loop now runs every page through classifyDiceSearchPage and
  throws BlockedError / DomChangedError / NetworkError where the old
  code silently broke out of the loop. Partial-result early return
  preserves earlier pages on later-page failures.
- Detail loop now drops bad rows (parse error, wrong @type, missing
  title/company) into a counter. If > 30% of processed rows drop,
  the batch throws DomChangedError (or returns partial if any rows
  succeeded).
- Removed fetchRecruiterProfile + the recruiterId / easyApply RSC
  regex sniffs (probe confirmed 0/10 hits — dead in production).
  Cuts per-job navigation in half.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Debug harness `scripts/test-dice-scrape.js` + npm script

**Files:**
- Create: `scripts/test-dice-scrape.js`
- Modify: `package.json` (add `"dice:test-scrape"`)

- [ ] **Step 1: Create the harness**

Create `scripts/test-dice-scrape.js` with this exact content:

```js
#!/usr/bin/env node
// Test harness — runs scrapeDice live for one role and analyzes the
// URL quality + per-job field completeness. Mirrors test-monster-scrape.js.
//   npm run dice:test-scrape -- "software engineer"        (role)
//   DICE_TEST_LOC="United States" npm run dice:test-scrape
import { scrapeDice } from '../scrapers/dice.js';
import { classifyUrl } from '../src/core/url-quality.js';

const role = process.argv.slice(2).join(' ').trim() || 'software engineer';
const loc  = process.env.DICE_TEST_LOC || 'United States';

console.log(`Role     : ${role}`);
console.log(`Location : ${loc}\n`);

async function main() {
    const t0 = Date.now();
    let result;
    try {
        result = await scrapeDice(role, loc, null);
    } catch (e) {
        console.log(`\n❌ Scrape threw ${e.name}: ${e.message}`);
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

    if (jobs.length > 0 && counts.permalink / jobs.length < 0.5) {
        console.log('\n⚠ PERMALINK rate < 50% — extractor likely broken.');
        process.exit(3);
    }
    process.exit(0);
}
main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

Edit `package.json`. Find the `"scripts"` block (via `grep -n '"scripts"' package.json`). Add this entry near the existing `"monster:test-scrape"` entry, preserving JSON validity and all existing entries:

```json
"dice:test-scrape": "node scripts/test-dice-scrape.js",
```

Verify:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf-8')).scripts['dice:test-scrape'])"
```
Expected output: `node scripts/test-dice-scrape.js`.

- [ ] **Step 3: Module load check (no live scrape)**

```bash
node -e "import('./scripts/test-dice-scrape.js').catch(e => { if (e?.name === 'BrowserError' || e?.name === 'TimeoutError') process.exit(0); throw e; })" &
PID=$!
sleep 2
kill $PID 2>/dev/null || true
echo "load check ok"
```
Expected: no `SyntaxError` / `ReferenceError` / module-not-found in stdout. CloakBrowser may begin launching (the script auto-runs `main()` on import); kill is benign.

- [ ] **Step 4: Run the full test suite (regression check)**

Run: `node --test 'test/**/*.test.js'`
Expected: all green. The harness is unrelated to unit tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-dice-scrape.js package.json
git commit -m "$(cat <<'EOF'
feat(dice): test-dice-scrape harness + npm run dice:test-scrape

Mirrors scripts/test-monster-scrape.js. Runs scrapeDice end-to-end,
prints per-job URL-quality summary, exits non-zero if PERMALINK < 50% or
if any title/company is missing/'N/A'. Used to verify after a Dice DOM
change without polluting CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Wire `strictEmpty:true` in the registry

**Files:**
- Modify: `src/scrapers/registry.js`

- [ ] **Step 1: Read the current registry**

Run: `cat src/scrapers/registry.js`

You should see `dice: new BaseScraper('dice', scrapeDice),` somewhere in the SCRAPERS Object.freeze block.

- [ ] **Step 2: Apply the edit**

Replace the existing line:

```js
dice: new BaseScraper('dice', scrapeDice),
```

with:

```js
dice: new BaseScraper('dice', scrapeDice, { strictEmpty: true }),
```

No other changes. Do NOT touch the Monster, LinkedIn, or other entries.

- [ ] **Step 3: Verify Dice still appears in PLATFORM_NAMES**

```bash
node -e "import('./src/scrapers/registry.js').then(m => console.log(m.PLATFORM_NAMES))"
```
Expected: array still contains `'dice'` (and `'monster'`, `'linkedin'`, etc).

- [ ] **Step 4: Run the full test suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all green. No existing test depends on Dice being non-strict.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/registry.js
git commit -m "$(cat <<'EOF'
feat(dice): strictEmpty:true in registry

0-jobs-on-200 from Dice now surfaces as BlockedError via BaseScraper's
strict-empty gate instead of being recorded as a successful empty scrape.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Probe-script docstrings

**Files:**
- Modify: `scripts/dice-deep-probe.mjs` (add header docstring if absent)
- Modify: `scripts/dice-recruiter-probe.mjs` (add header docstring if absent)

- [ ] **Step 1: Inspect the existing top comments**

Run: `head -10 scripts/dice-deep-probe.mjs scripts/dice-recruiter-probe.mjs`

If both files' first 1-3 lines already mention "investigation harness" / "NOT part of the runtime" / "probe" / similar — they are fine and you can skip the edit.

Both files were committed in the spec commit (2026-06-05). Inspect their current docstrings before editing.

- [ ] **Step 2: If `scripts/dice-deep-probe.mjs` needs the docstring**

Prepend (insert BEFORE the existing first line):

```js
// Investigation harness — NOT part of the runtime scraper. Run by hand
// when debugging Dice behavior. Probes search-page DOM, detail-page
// structured data, pagination, anti-bot, and the network log. Re-run
// when Dice ships a UI refresh and the live scraper starts failing.
//
// Usage:
//   node scripts/dice-deep-probe.mjs
//   PROBE_ROLE="data engineer" PROBE_LOC="New York" node scripts/dice-deep-probe.mjs
```

- [ ] **Step 3: If `scripts/dice-recruiter-probe.mjs` needs the docstring**

Prepend:

```js
// Investigation harness — NOT part of the runtime scraper. Visits 10
// Dice detail pages and counts how many have a recruiterId regex hit,
// then follows the recruiter profile pages to measure parse success.
// Originally established that the recruiter feature is dead (0/10 hits
// as of 2026-06-05) and that the dropping it from scrapeDice is safe.
//
// Usage:
//   node scripts/dice-recruiter-probe.mjs
```

- [ ] **Step 4: Verify**

```bash
head -5 scripts/dice-deep-probe.mjs scripts/dice-recruiter-probe.mjs
```
Expected: first 1-3 lines of each file mention "investigation" / "NOT part of the runtime".

- [ ] **Step 5: Commit (only if a file changed)**

If both files already had appropriate docstrings (no edits needed), skip the commit and report so.

If a file was edited:

```bash
git add scripts/dice-deep-probe.mjs scripts/dice-recruiter-probe.mjs
git commit -m "$(cat <<'EOF'
docs(dice): mark probe scripts as investigation harnesses

Explicit "NOT part of the runtime" docstrings so future operators
running grep over scripts/ know these are debug tools.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Stage only files that actually changed.

---

## Final verification

After all 11 tasks land:

- [ ] **Step 1: Full test suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all green; test count grew by ~33+ (5 new Dice test files).

- [ ] **Step 2: Live smoke**

Run: `npm run dice:test-scrape -- "software engineer"`
Expected: ≥ 30 jobs returned; PERMALINK rate = 100%; bad title and bad company both 0; exit code 0.

If the smoke shows < 50% permalink or any bad-title row, investigate before declaring complete (regression vs Dice DOM change).

- [ ] **Step 3: Module shape**

```bash
node -e "import('./scrapers/dice.js').then(m => console.log(Object.keys(m).sort().join(', ')))"
```
Expected: includes `buildSearchUrl, classifyDiceSearchPage, extractJobFromStructuredData, extractSkills, extractWorkplaceType, parseEmploymentType, parseSalary, parseStructuredData, scrapeDice`.

- [ ] **Step 4: Hand off to `superpowers:finishing-a-development-branch`** to pick between merge / PR / keep.

---

## Self-review

- **Spec coverage:**
  - § A (search-page extraction) → Tasks 7, 8
  - § B (detail-page structured-data) → Tasks 2, 3, 4, 5, 8
  - § C (drop recruiter + easyApply) → Task 8 (orchestrator rewrite explicitly deletes both)
  - § D (page-state classifier) → Tasks 6, 8
  - § E (typed errors + partial results) → Task 8 (composes all the above)
  - § F (tests + harness) → Tasks 1, 2, 3, 4, 5, 6, 7, 9
  - § G (registry strictEmpty:true) → Task 10
  - § H (probe scripts disposition) → Task 11
- **Placeholder scan:** every code step shows full code; no "TBD" / "implement later" / "similar to Task N".
- **Type consistency:** `parseStructuredData → {data, error}` consistent across Tasks 2, 8. `parseSalary → {min, max, currency, period, formatted}` consistent in Tasks 3, 5. `extractJobFromStructuredData → row | {__domChanged, reason}` consistent in Tasks 5, 8. `classifyDiceSearchPage({url, bodyText, anchorCount, bytes}) → {state, signal}` consistent in Tasks 6, 8. `extractSkills($)` / `extractWorkplaceType($)` defined in Task 8 and used in same task.
- **Test count delta:** +5 new test files: parse-structured-data (5 tests), parse-salary (8), parse-employment-type (9), extract-job (8), classify-page (6), search-extract (3) ≈ 39 new test cases. Plus the 240 baseline ≈ 280 total.
