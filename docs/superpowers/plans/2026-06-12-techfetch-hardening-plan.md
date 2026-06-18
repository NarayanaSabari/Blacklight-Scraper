# TechFetch Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `scrapers/techfetch.js` to anonymous-first operation (kill the 10-minute credential wait), with login as an on-demand fallback, lifted to the fleet pattern (typed errors, classifier, strictEmpty, fixtures, harness).

**Architecture:** Two module-scope pure helpers (`canonicalTechFetchJobUrl`, `classifyTechFetchListPage`) + a pure row mapper (`parseTechFetchRow`) extracted from the class's `extractJobs`; `search()` gains its own navigation (no longer assumes post-login state); `scrapeJobs` drops the unconditional `login()`; `scrapeTechFetch` goes anonymous-first with a single-attempt credential fallback on `auth_required`. Preserved: `navigateWithRetry` backoff, `fetchPageWithBrowser` LoadJobs AJAX pagination, per-page detail enrichment, lease `reportSuccess`/`reportFailure` semantics, playwright-extra + StealthPlugin + JSDOM stack.

**Tech Stack:** Node 24 ESM, `node:test`, JSDOM (already a dep), playwright-extra. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-12-techfetch-hardening-design.md`

---

## Constraints

1. Do NOT modify `scrapers/linkedin.js`, `scrapers/monster.js`, `scrapers/dice.js`, `scrapers/indeed.js`, `scrapers/glassdoor.js`.
2. NEVER stage `.gitignore`, `pnpm-lock.yaml`, `.claude/`, `node_modules/`. Stage by name only.
3. Tests: `node --test 'test/**/*.test.js'` (quoted glob). Unit tests never hit techfetch.com.
4. Every commit ends with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
5. NEVER print credential email/password values anywhere (logs may show credential ID + masked password length only — existing convention).
6. Working dir `/Users/sabari/Developer/freelancing/Blacklight-Scraper`, branch `emdash/techfetch-hardening` (created off main AFTER the Glassdoor slice merges).
7. Baseline: 382 tests green.

## File map

| Path | Action |
|---|---|
| `scrapers/techfetch.js` | modify — pure helpers at module scope, search() self-navigation, anonymous-first orchestrator |
| `src/scrapers/registry.js` | modify (+strictEmpty for techfetch) |
| `scripts/test-techfetch-scrape.js` | new harness |
| `package.json` | add `techfetch:test-scrape` |
| `test/fixtures/techfetch-card.html` | new (from /tmp, anon probe) |
| `test/fixtures/techfetch-list.html` | new (from /tmp) |
| `test/fixtures/techfetch-no-results.html` | new (captured in Task 1) |
| `test/scrapers/techfetch-job-url.test.js` | new |
| `test/scrapers/techfetch-parse-row.test.js` | new |
| `test/scrapers/techfetch-classify-page.test.js` | new |

---

## Task 1: Fixtures (incl. live no-results capture)

- [ ] **Step 1:** `ls -la /tmp/techfetch-card.html /tmp/techfetch-list.html` (regenerate with `node scripts/techfetch-anon-probe.mjs` if missing — ~1 min, anonymous).
- [ ] **Step 2:** `cp /tmp/techfetch-card.html test/fixtures/techfetch-card.html && cp /tmp/techfetch-list.html test/fixtures/techfetch-list.html`
- [ ] **Step 3:** Capture the no-results page live (the one probe gap). Run this inline script from the repo root:

```bash
node --input-type=module -e '
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
chromium.use(StealthPlugin());
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto("https://www.techfetch.com/js/js_s_jobs.aspx", { waitUntil: "domcontentloaded", timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
await page.waitForSelector("#txtKeyword", { timeout: 8000 });
await page.fill("#txtKeyword", "xyzqqqzzz12345unobtanium");
await page.click(String.raw`input[type="submit"], button[type="submit"], #btnSearch`);
await new Promise((r) => setTimeout(r, 6000));
const shape = await page.evaluate(() => ({
    url: window.location.href.replace(/[?#].*$/, ""),
    rows: document.querySelectorAll("[id*=_divJob]").length,
    snippet: (document.body?.innerText || "").slice(0, 300).replace(/\s+/g, " "),
}));
console.log("no-results shape:", JSON.stringify(shape, null, 2));
fs.writeFileSync("test/fixtures/techfetch-no-results.html", await page.content());
await browser.close();
'
```

Record the EXACT no-results phrase from the snippet (expected something like "No jobs found" / "no results") — Task 4's classifier regex must match it. Then verify: `grep -ioE "no (more )?jobs|no results|not found|0 jobs" test/fixtures/techfetch-no-results.html | sort -u | head -5` → at least one hit. Also confirm `grep -c "_divJob" test/fixtures/techfetch-no-results.html` is 0 (or note the count if suggested rows render).

- [ ] **Step 4:** Verify list fixture: `grep -c "_divJob" test/fixtures/techfetch-list.html` → ≥ 15.
- [ ] **Step 5:** Commit the three fixtures: `test(techfetch): anon list/card fixtures + live no-results capture`.

---

## Task 2: `canonicalTechFetchJobUrl` (pure)

**Files:** modify `scrapers/techfetch.js` (add at MODULE SCOPE, after the imports/log setup, BEFORE `class TechFetchScraper`); create `test/scrapers/techfetch-job-url.test.js`.

- [ ] **Step 1:** Failing tests:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTechFetchJobUrl } from '../../scrapers/techfetch.js';

test('canonical: absolutizes relative hrefs', () => {
    assert.equal(
        canonicalTechFetchJobUrl('/job-description/senior-java-dev-jackson-ms-j3631463&aid=tfjstfviewjob'),
        'https://www.techfetch.com/job-description/senior-java-dev-jackson-ms-j3631463&aid=tfjstfviewjob',
    );
});
test('canonical: strips utm_* query params but keeps aid (unverified to strip)', () => {
    assert.equal(
        canonicalTechFetchJobUrl('/job-description/x-j999&aid=tfjstfviewjob&utm_source=techfetch&utm_medium=web&utm_campaign=tfjobsearch'),
        'https://www.techfetch.com/job-description/x-j999&aid=tfjstfviewjob',
    );
});
test('canonical: absolute http URL passes through (utm still stripped)', () => {
    assert.equal(
        canonicalTechFetchJobUrl('https://www.techfetch.com/job-description/y-j1&utm_source=a'),
        'https://www.techfetch.com/job-description/y-j1',
    );
});
test('canonical: null/empty → null', () => {
    assert.equal(canonicalTechFetchJobUrl(null), null);
    assert.equal(canonicalTechFetchJobUrl(''), null);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (NOTE: TechFetch hrefs are not standard URLs — `&aid=` appears without a `?`, so `new URL` query parsing doesn't apply; treat as string ops):

```js
// TechFetch job URLs embed parameters with bare '&' (no '?'):
//   /job-description/<slug>-j<digits>&aid=tfjstfviewjob&utm_source=...
// Strip utm_* segments (tracking noise) but KEEP &aid — the probe only
// verified the aid-bearing form resolves. Pure string handling: these
// are not standard URLs.
export function canonicalTechFetchJobUrl(href) {
    if (!href) return null;
    const abs = href.startsWith('http') ? href : `https://www.techfetch.com${href}`;
    return abs.replace(/&utm_[^&]*/g, '');
}
```

- [ ] **Step 4:** Run → PASS (4); full suite green (386).
- [ ] **Step 5:** Commit `feat(techfetch): canonicalTechFetchJobUrl — absolutize + strip utm noise`.

---

## Task 3: `parseTechFetchRow` (pure, JSDOM-fixture-driven)

**Files:** modify `scrapers/techfetch.js`; create `test/scrapers/techfetch-parse-row.test.js`.

- [ ] **Step 1:** Failing tests:

```js
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
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement at module scope (port the field logic from the class's `extractJobs` inner loop — company from logo href `/job-openings/<x>` or img alt, location/rate/desc best-effort):

```js
// Maps one [id*="_divJob"] row element to a flat record. Load-bearing:
// title text + href (sentinel when missing — ASP.NET id rename signal).
// Company/location/rate/description best-effort. Pure DOM-element-in,
// object-out: callable from the class (live) and tests (JSDOM fixtures).
export function parseTechFetchRow(jobDiv) {
    if (!jobDiv) return null;
    const titleSpan = jobDiv.querySelector('[id*="_lblTitle"]');
    const titleLink = titleSpan?.querySelector('a');
    const jobTitle = titleLink?.textContent?.trim() ?? '';
    const href = titleLink?.getAttribute('href') ?? '';
    if (!titleSpan || !titleLink || !jobTitle) return { __domChanged: true, reason: 'missing_title_anchor' };
    if (!href) return { __domChanged: true, reason: 'missing_href' };
    const logoDiv = jobDiv.querySelector('[id*="_jllogo"]');
    const company = logoDiv?.querySelector('a')?.getAttribute('href')?.split('/job-openings/')?.[1]
        || logoDiv?.querySelector('img')?.getAttribute('alt')
        || 'N/A';
    return {
        jobTitle,
        jobLink: canonicalTechFetchJobUrl(href),
        company,
        location: jobDiv.querySelector('[id*="_lblLocation"]')?.textContent?.trim() || 'N/A',
        rate: jobDiv.querySelector('[id*="_lblRate"]')?.textContent?.trim() || 'N/A',
        description: jobDiv.querySelector('[id*="_lblDesc"], [id*="_lblJobDesc"]')?.textContent?.trim() || '',
    };
}
```

Then refactor the class's `extractJobs(html)` to use it:

```js
    extractJobs(html) {
        const dom = new JSDOM(html);
        const jobDivs = dom.window.document.querySelectorAll('[id*="_divJob"]');
        logProgress('TechFetch', `Found ${jobDivs.length} job divs on page`);
        const jobs = [];
        let domChanged = 0;
        jobDivs.forEach((jobDiv) => {
            const row = parseTechFetchRow(jobDiv);
            if (!row) return;
            if (row.__domChanged) { domChanged++; return; }
            jobs.push(row);
        });
        if (domChanged > 0) logProgress('TechFetch', `   ⚠️  ${domChanged} rows skipped (__domChanged sentinels)`);
        jobs.__domChangedCount = domChanged;   // consumed by scrapeJobs gate
        return jobs;
    }
```

(Keep the alternative-selectors debug block if you want, or drop it — the classifier now owns 0-row diagnosis. Dropping preferred.)

- [ ] **Step 4:** Run → PASS (4); full suite green (390).
- [ ] **Step 5:** Commit `feat(techfetch): parseTechFetchRow — pure sentinel row mapper`.

---

## Task 4: `classifyTechFetchListPage` (pure)

**Files:** modify `scrapers/techfetch.js`; create `test/scrapers/techfetch-classify-page.test.js`.

- [ ] **Step 1:** Failing tests (ADAPT the no-results regex/test to the EXACT phrase recorded in Task 1 Step 3 — the test below assumes a generic phrase; update both test and regex together):

```js
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
test('classify: zero rows + no-results text → empty_confirmed', () => {
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
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement at module scope:

```js
// Seed regex; Task-1 live capture phrase MUST be covered — extend if needed.
export const TECHFETCH_NO_RESULTS_RE = /no (more )?jobs|no results|not found|0 jobs/i;
const TECHFETCH_DOM_CHANGED_BYTES = 50_000;

// Pure page-state classifier for the TechFetch job-list page.
//   auth_required   → bounced to the login page
//   results         → [id*="_divJob"] rows present
//   empty_confirmed → 0 rows + no-results text
//   dom_changed     → ASP.NET shell rendered (LoadJobs fn / big page) but
//                     rows absent and no empty text → markup rename
//   network_error   → fall-through
export function classifyTechFetchListPage({ url, rowCount, hasLoadJobsFn, bodyText, bytes }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/login/i.test(u)) return { state: 'auth_required', signal: 'redirected to login page' };
    if ((rowCount ?? 0) > 0) return { state: 'results', signal: `rows=${rowCount}` };
    if (TECHFETCH_NO_RESULTS_RE.test(t)) return { state: 'empty_confirmed', signal: 'no-results text' };
    if (hasLoadJobsFn || (bytes ?? 0) >= TECHFETCH_DOM_CHANGED_BYTES) {
        return { state: 'dom_changed', signal: `shell rendered but 0 rows (bytes=${bytes}, LoadJobs=${!!hasLoadJobsFn})` };
    }
    return { state: 'network_error', signal: `small body (${bytes}b), no shell` };
}
```

- [ ] **Step 4:** Run → PASS (6); full suite green (396).
- [ ] **Step 5:** Commit `feat(techfetch): classifyTechFetchListPage — 5 states, anonymous-first aware`.

---

## Task 5: Anonymous-first orchestrator restructure

**Files:** modify `scrapers/techfetch.js` only. No new unit tests (composes locked helpers); verify via full-suite + module-shape + syntax.

- [ ] **Step 1:** Read the current flow end-to-end: `search()` (~line 196 — note its comment "Already on js_s_jobs.aspx from login"), `scrapeJobs()` (~line 631 — note `await this.login()` unconditional), `scrapeTechFetch()` (~line 749 — the credential-wait loop: `maxCredentialRetries = 10`, `credentialRetryDelay = 60000`), and the per-page detail-enrichment block inside scrapeJobs's page loop (verify enrichment is per-page; the partial-result policy depends on it).

- [ ] **Step 2:** Add typed-error import at top:

```js
import { AuthError, DomChangedError, NetworkError } from '../src/core/errors.js';
```

- [ ] **Step 3:** Make `search()` self-navigating. At the START of `search(keywords, location)`, before the existing `waitForTimeout`, add:

```js
        // Anonymous-first: navigate ourselves instead of assuming the
        // post-login landing page (probe 2026-06-12: search works without
        // login end-to-end).
        await this.navigateWithRetry('https://www.techfetch.com/js/js_s_jobs.aspx', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
```

- [ ] **Step 4:** In `scrapeJobs(...)`: REMOVE the unconditional login block:

```js
        const loginSuccess = await this.login();
        if (!loginSuccess) {
            throw new Error('Login failed. Please check credentials.');
        }
```

→ replace with nothing (just `await this.initialize();` then `await this.search(keywords, location);`).

Immediately AFTER `await this.search(...)`, add the classification gate:

```js
        // Classify the post-search page before paginating.
        const listState = await this.page.evaluate(() => ({
            url: window.location.href,
            rowCount: document.querySelectorAll('[id*="_divJob"]').length,
            hasLoadJobsFn: typeof window.LoadJobs === 'function',
            bodyText: (document.body?.innerText || '').slice(0, 3000),
            bytes: document.documentElement?.outerHTML?.length ?? 0,
        }));
        const verdict = classifyTechFetchListPage(listState);
        logProgress('TechFetch', `List page classified: ${verdict.state} (${verdict.signal})`);
        if (verdict.state === 'auth_required') {
            const e = new AuthError(`TechFetch requires login: ${verdict.signal}`, { platform: 'techfetch' });
            e.techfetchAuthRequired = true;   // orchestrator triggers the one-shot login fallback
            throw e;
        }
        if (verdict.state === 'empty_confirmed') return { jobs: [], emptyConfirmed: true };
        if (verdict.state === 'dom_changed') throw new DomChangedError(`TechFetch list DOM changed: ${verdict.signal}`, { platform: 'techfetch' });
        if (verdict.state === 'network_error') throw new NetworkError(`TechFetch list didn't render: ${verdict.signal}`, { platform: 'techfetch' });
        // results → fall through to the existing pagination loop
```

NOTE `scrapeJobs` now returns EITHER an array (results path, existing behavior) OR `{jobs:[], emptyConfirmed:true}` — the orchestrator handles both shapes.

Inside the page loop, after `const allExtracted = this.extractJobs(html);` add the sentinel gate:

```js
                const domChangedCount = allExtracted.__domChangedCount ?? 0;
                if (allExtracted.length === 0 && domChangedCount > 0) {
                    throw new DomChangedError(`TechFetch rows all failed extraction (${domChangedCount} sentinels)`, { platform: 'techfetch' });
                }
```

- [ ] **Step 5:** Rewrite `scrapeTechFetch(...)`. Replace the entire exported function with:

```js
export async function scrapeTechFetch(jobTitle, location, sessionId = null) {
    logProgress('TechFetch', `Starting TechFetch scraper for "${jobTitle}" in "${location || 'any location'}" (anonymous-first)`);

    const maxPages = location ? 5 : 2;

    // ── Attempt 1: anonymous (probe-verified working path) ──────────
    const anonScraper = new TechFetchScraper(null, null);
    let authRequired = false;
    try {
        const result = await anonScraper.scrapeJobs(jobTitle, location, maxPages, true);
        return normalizeTechFetchResult(result);
    } catch (e) {
        if (e?.techfetchAuthRequired) {
            authRequired = true;
            logProgress('TechFetch', 'Anonymous search hit a login wall — attempting credential fallback');
        } else {
            throw e;
        }
    } finally {
        await anonScraper.close?.().catch?.(() => {});
    }

    // ── Attempt 2 (only on auth_required): single credential try ────
    if (authRequired) {
        const lease = await getCredentialsAPIClient().acquire('techfetch', sessionId);
        if (!lease) {
            throw new AuthError('TechFetch requires login but no credential is available from the API', { platform: 'techfetch' });
        }
        const credential = lease.credential;
        logProgress('TechFetch', `✅ Credential fetched: id=${credential.id} (email/password masked)`);
        const scraper = new TechFetchScraper(credential.email, credential.password);
        try {
            await scraper.initialize();
            const loginOk = await scraper.login();
            if (!loginOk) {
                await lease.reportFailure('Login failed: JSLogin cookie not set', 0);
                throw new AuthError('TechFetch login failed (JSLogin cookie not set)', { platform: 'techfetch' });
            }
            const result = await scraper.scrapeJobs(jobTitle, location, maxPages, true);
            await lease.reportSuccess(`Scraped ${Array.isArray(result) ? result.length : result.jobs?.length ?? 0} jobs after login fallback`);
            return normalizeTechFetchResult(result);
        } catch (e) {
            if (e?.techfetchAuthRequired) {
                await lease.reportFailure('Login succeeded but search still bounced to login', 30);
                throw new AuthError('TechFetch still requires auth after login fallback', { platform: 'techfetch' });
            }
            if (!(e instanceof AuthError)) {
                await lease.reportFailure(`Scraping error: ${e.message}`, 30).catch(() => {});
            }
            throw e;
        } finally {
            await scraper.close?.().catch?.(() => {});
        }
    }
}
```

CHECK the class for the actual cleanup method name (`close`? `cleanup`? grep the class) and call the real one. Note `scrapeJobs` already called `this.initialize()` internally before — verify whether your restructured flow double-initializes (if scrapeJobs calls initialize, drop the explicit `await scraper.initialize()` in attempt 2 and let scrapeJobs do it; keep login BEFORE scrapeJobs by giving login its own initialize guard — simplest: make `initialize()` idempotent with `if (this.browser) return;`).

Then add `normalizeTechFetchResult` helper near the export (port the EXISTING normalization mapping from the old orchestrator verbatim — `normalizeJobData({title: job.jobTitle, company: job.company, ...}, 'TechFetch')` — find it in the old code ~line 815-835, keep all fields):

```js
function normalizeTechFetchResult(result) {
    if (!Array.isArray(result)) return result;   // {jobs:[], emptyConfirmed:true} passes through
    const normalizedJobs = result.map((job) => normalizeJobData({
        /* …port the existing field mapping verbatim… */
    }, 'TechFetch'));
    logProgress('TechFetch', `Completed: ${normalizedJobs.length} jobs`);
    return normalizedJobs;
}
```

- [ ] **Step 6:** Sanity checks:

```bash
node --check scrapers/techfetch.js && node --test 'test/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|pass|fail)"
node -e "import('./scrapers/techfetch.js').then(m => console.log(Object.keys(m).sort().join(', ')))"
```
Expected exports: `TECHFETCH_NO_RESULTS_RE, canonicalTechFetchJobUrl, classifyTechFetchListPage, parseTechFetchRow, scrapeTechFetch`.

- [ ] **Step 7:** Commit `feat(techfetch): anonymous-first orchestrator — login as one-shot fallback`.

---

## Task 6: Registry + harness

- [ ] **Step 1:** `src/scrapers/registry.js`: `techfetch: new BaseScraper('techfetch', scrapeTechFetch),` → `techfetch: new BaseScraper('techfetch', scrapeTechFetch, { strictEmpty: true }),`
- [ ] **Step 2:** Create `scripts/test-techfetch-scrape.js` (mirror `scripts/test-glassdoor-scrape.js` exactly, with: import `scrapeTechFetch`; env override `TECHFETCH_TEST_LOC` defaulting to `''` (TechFetch is US-only, keyword-driven); bad-url check `!url.includes('techfetch.com/job-description/')`; exit 4 when the catch sees `e.name === 'AuthError'`; drop the US-shaped-location line).
- [ ] **Step 3:** `package.json`: add `"techfetch:test-scrape": "node scripts/test-techfetch-scrape.js",` after the glassdoor entry.
- [ ] **Step 4:** Full suite green; `PLATFORM_NAMES` intact.
- [ ] **Step 5:** Commit `feat(techfetch): strictEmpty + test-techfetch-scrape harness`.

---

## Task 7: Live smoke (controller-run)

- [ ] **Step 1:** `npm run techfetch:test-scrape -- "java developer"` → expect ≥ 15 jobs, 0 bad rows, **no credential wait**, exit 0.
- [ ] **Step 2:** `npm run techfetch:test-scrape -- "xyzqqqzzz12345unobtanium"` → expect `emptyConfirmed=true`, 0 jobs, exit 0.
- [ ] **Step 3:** Fix-loop any failure against the classifier signal in logs; commit fixes individually.

## Self-review

- Spec §A → Tasks 3 (search self-nav lives in Task 5 Step 3), 5; §B → Task 5 Step 5; §C → Task 4; §D → Tasks 2, 3; §E → preserved; §F → Tasks 5, 6; §G → Tasks 1, 6, 7.
- Placeholder check: the one intentional non-literal is `normalizeTechFetchResult`'s field mapping ("port verbatim from old orchestrator ~line 815-835") — that's a copy instruction with a precise source location, not an invention.
- Type consistency: `classifyTechFetchListPage` input named-args match between Task 4 tests and Task 5's evaluate shape; `parseTechFetchRow` jobLink uses `canonicalTechFetchJobUrl` (Tasks 2→3); `extractJobs` returns array with `__domChangedCount` (Tasks 3→5).
