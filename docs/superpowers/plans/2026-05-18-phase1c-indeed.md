# Phase 1C-Indeed — Block Detection Wiring (flag-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the proven `assertNotBlocked()` detection + a positively-confirmed-empty signal into `scrapers/indeed.js`, and fix I13 (premature `loginSuccess`) + I2 (page-1 zero treated as end-of-results) — **entirely gated behind `SCRAPER_STRICT_EMPTY`**, so with the flag OFF (default) Indeed behaves byte-identically to today, and flipping it ON per-host activates the full silent-block fix (a Cloudflare/DataDome challenge throws → cooldown → `blocked` metric instead of a silent successful 0-job scrape).

**Architecture:** Read the flag once into a module const `STRICT`. All *behavior-changing* additions are `if (STRICT)`-guarded: a post-navigation `assertNotBlocked()` call (the audit's proven pure detector from Plan 1A), the I13 deferral of `loginSuccess`, and the I2 page-1-zero-→-throw distinction. The only *always-on* change is observability-safe: the scraper returns `{ jobs, emptyConfirmed }` (BaseScraper's Plan-1A contract accepts Array *or* this shape) where `emptyConfirmed` is set true only when a pure helper `indeedNoResults(html)` positively detects Indeed's "did not match any jobs" marker — this only affects logging/`zeroResultSessions` metric (Plan 1B), never scrape behavior. The pure helper is unit-tested; `assertNotBlocked` is already unit-tested (Plan 1A).

**Tech Stack:** Node.js 20+ ESM (host runs **Node v24.14.0**), `node:test` + `node:assert/strict`. No new dependencies. `scrapers/indeed.js` is browser-automation (CloakBrowser) and not end-to-end unit-testable without a browser; testability is achieved by extracting the one new decision as a **pure** helper and relying on `assertNotBlocked` already being proven in `test/core/block-detection.test.js`.

> **Node 24 note:** `node --test <dir>` broken on Node 24; `package.json` uses `node --test 'test/**/*.test.js'`. Reporter prints `ℹ pass/fail N`. Success = "the task's new tests pass AND `fail 0`"; suite carries 50 tests from prior phases (cumulative counts illustrative).

**Source spec:** `docs/superpowers/specs/2026-05-18-blacklight-scraper-anti-bot-audit-design.md` — **I1/F4** (Cloudflare challenge → 0 cards → silent `reportSuccess`), **I13** (`loginSuccess=true` set before any navigation, disabling the catch-block cooldown taxonomy), **I2** (any zero-card page treated as end-of-results, so a page-1 block aborts all pagination). The substantive **C1** for Indeed. **M5 contract:** only ever pass `assertNotBlocked` a block-page title, never a scraped job title — satisfied here because the call sees the *search results page* document (title/url/html), not an extracted job's title.

**Production-safety contract:** With `SCRAPER_STRICT_EMPTY` unset/`!== 'true'` (the default, and what `server.js`/runbooks ship today), `scrapeIndeed` is byte-behaviorally identical to the pre-1C version: `loginSuccess` is set true early as before, any zero-card page `break`s as before, and `assertNotBlocked` is never called. The only difference when OFF is the return value is wrapped as `{ jobs, emptyConfirmed }` instead of a bare array — which `BaseScraper.normalizeResult` (Plan 1A) already handles identically for scraping, affecting only Plan 1B's zero-jobs *logging/metric* dimension. No new dependency, no scraper-flow change when OFF. Flipping the flag ON is the single, per-host, instantly-reversible activation the operator owns.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `scrapers/indeed.js` | Indeed scraper | Modify (import; `STRICT` const; `indeedNoResults` helper; gated `assertNotBlocked`; I13; I2; `{jobs,emptyConfirmed}` return) |
| `test/scrapers/indeed-block.test.js` | Pure-helper unit tests + wiring guards | **Create** |

Tests live under `test/` mirroring the scraper. Only the pure `indeedNoResults` helper and static wiring/gating guarantees are unit-tested (the CloakBrowser flow is not unit-testable; `assertNotBlocked` correctness is already covered by `test/core/block-detection.test.js`).

---

## Task 1: Pure `indeedNoResults(html)` helper (positively-confirmed-empty)

**Files:**
- Modify: `scrapers/indeed.js` (add an exported pure helper near `extractJobsFromSearchPage`)
- Create: `test/scrapers/indeed-block.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/indeed-block.test.js`:

```js
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

test('indeedNoResults: false/empty-safe on empty or junk input', () => {
    assert.equal(indeedNoResults(''), false);
    assert.equal(indeedNoResults(null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scrapers/indeed-block.test.js`
Expected: FAIL — `indeedNoResults` is not exported from `scrapers/indeed.js`.

- [ ] **Step 3: Add the pure helper**

In `scrapers/indeed.js`, immediately ABOVE the `function extractJobsFromSearchPage(html, domain) {` definition, add:

```js
/**
 * Positively detect Indeed's "no results" page so a genuine empty search
 * is distinguishable from a silent block / DOM change. Pure + safe on
 * junk input. Indeed renders a `jobsearch-NoResult` container and/or the
 * phrase "did not match any jobs".
 * @param {string} html
 * @returns {boolean}
 */
export function indeedNoResults(html) {
    if (!html || typeof html !== 'string') return false;
    if (html.includes('jobsearch-NoResult')) return true;
    return /did not match any jobs/i.test(html);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scrapers/indeed-block.test.js`
Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0` (50 prior + 5 = 55; exact count illustrative).

- [ ] **Step 6: Commit**

```bash
git add scrapers/indeed.js test/scrapers/indeed-block.test.js
git commit -m "feat(indeed): pure indeedNoResults() confirmed-empty detector (I1 prep)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Flag-gated block detection + I13 + I2 + emptyConfirmed return

**Files:**
- Modify: `scrapers/indeed.js` (import; `STRICT` const; gated `assertNotBlocked`; I13; I2; return shape)
- Modify: `test/scrapers/indeed-block.test.js` (append static wiring/gating guards)

- [ ] **Step 1: Write the failing guard tests**

Append to `test/scrapers/indeed-block.test.js`:

```js
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
    // The flag is read once into a module const.
    assert.match(SRC, /const\s+STRICT\s*=\s*process\.env\.SCRAPER_STRICT_EMPTY\s*===\s*['"]true['"]/);
    // assertNotBlocked is only ever called under a STRICT guard.
    for (const m of SRC.matchAll(/assertNotBlocked\s*\(/g)) {
        const before = SRC.slice(Math.max(0, m.index - 400), m.index);
        assert.ok(/if\s*\(\s*STRICT\s*\)/.test(before),
            'assertNotBlocked() call is not guarded by `if (STRICT)`');
    }
});

test('scrapeIndeed returns the {jobs, emptyConfirmed} contract shape', () => {
    assert.match(SRC, /return\s*\{\s*jobs:\s*normalizedJobs\s*,\s*emptyConfirmed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scrapers/indeed-block.test.js`
Expected: FAIL — no `assertNotBlocked` import, no `STRICT` const, return is still `return normalizedJobs;`.

- [ ] **Step 3: Add the import**

In `scrapers/indeed.js`, immediately AFTER the line `import { getCredentialsAPIClient } from '../src/api/credentials.js';`, add:

```js
import { assertNotBlocked } from '../src/core/block-detection.js';

// Flag-gated hardening (audit I1/I13/I2). Read once. When this is NOT
// 'true' (the default/shipped state) Indeed behaves byte-identically to
// the pre-1C scraper: loginSuccess set early, any 0-card page ends
// pagination, no block detection. Flipping SCRAPER_STRICT_EMPTY=true
// per-host activates: a Cloudflare/DataDome challenge throws (→ cooldown
// + 'blocked' metric) instead of a silent successful 0-job scrape.
const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true';
```

- [ ] **Step 4: Fix I13 (defer `loginSuccess` only in STRICT mode)**

In `scrapeIndeed`, the block currently reads:

```js
        // No homepage warmup — visiting https://www.indeed.com triggers
        // a regional redirect (e.g. in.indeed.com from Indian IPs), which
        // then makes the navigation back to www.indeed.com look bot-like
        // to Cloudflare. Probe confirmed direct-to-search returns 200.
        loginSuccess = true;
```

Replace ONLY the `loginSuccess = true;` line with:

```js
        // I13: setting loginSuccess=true before any navigation makes the
        // catch-block cooldown taxonomy (auth=0 / rate-limit=60 / other=30)
        // dead code. In STRICT mode we defer it until page 0 is confirmed
        // past Cloudflare AND card-bearing (see the loop). When NOT strict
        // we keep the legacy early-true so behavior is byte-identical.
        if (!STRICT) loginSuccess = true;
```

- [ ] **Step 5: Wire gated `assertNotBlocked` + I2 + confirmed-empty in the page loop**

In `scrapeIndeed`'s pagination loop, the region currently reads:

```js
            // waitUntil:'load' gives Cloudflare's JS challenge time to run.
            // domcontentloaded fires while still on the challenge page and
            // we end up parsing the "Additional Verification Required" page.
            await page.goto(searchUrl, {
                waitUntil: 'load',
                timeout: 60000
            });
            await page.waitForTimeout(humanDelay(8000, 12000));
            
            // Close any popups
            await closePopups(page);

            // Extract jobs from current page
            const html = await page.content();
            const pageJobs = extractJobsFromSearchPage(html, domain);
            
            logProgress('Indeed', `Page ${pageNum + 1}: Found ${pageJobs.length} jobs`);

            if (pageJobs.length === 0) {
                logProgress('Indeed', 'No more jobs found, stopping pagination');
                break;
            }
```

Replace that exact region with:

```js
            // waitUntil:'load' gives Cloudflare's JS challenge time to run.
            // domcontentloaded fires while still on the challenge page and
            // we end up parsing the "Additional Verification Required" page.
            const navResp = await page.goto(searchUrl, {
                waitUntil: 'load',
                timeout: 60000
            });
            await page.waitForTimeout(humanDelay(8000, 12000));
            
            // Close any popups
            await closePopups(page);

            // Extract jobs from current page
            const html = await page.content();

            // STRICT: throw on a Cloudflare/DataDome/auth-wall challenge so
            // a block becomes a loud failure (cooldown + 'blocked' metric)
            // instead of a silent successful 0-job scrape (audit I1/F4).
            // M5: this inspects the SEARCH RESULTS document, never a job title.
            if (STRICT) {
                assertNotBlocked({
                    status: typeof navResp?.status === 'function' ? navResp.status() : null,
                    finalUrl: page.url(),
                    title: await page.title().catch(() => ''),
                    html,
                    platform: 'indeed',
                });
            }

            const pageJobs = extractJobsFromSearchPage(html, domain);
            
            logProgress('Indeed', `Page ${pageNum + 1}: Found ${pageJobs.length} jobs`);

            // I13: not blocked and page 0 — we are genuinely past Cloudflare.
            if (STRICT && pageNum === 0) loginSuccess = true;

            if (pageJobs.length === 0) {
                // I2: page-0 zero is NOT "end of results" — it is a block
                // or a DOM change UNLESS Indeed positively shows its
                // no-results marker. Later pages legitimately end here.
                if (STRICT && pageNum === 0 && !indeedNoResults(html)) {
                    throw new Error('Indeed page 1 returned 0 jobs with no "no results" marker — suspected block / DOM change');
                }
                if (pageNum === 0 && indeedNoResults(html)) {
                    logProgress('Indeed', 'Indeed reports no matching jobs (confirmed empty)');
                    sawConfirmedEmpty = true;
                }
                logProgress('Indeed', 'No more jobs found, stopping pagination');
                break;
            }
```

Then, in the same function, add the `sawConfirmedEmpty` declaration next to the existing `const allJobs = [];` / `const seenJobIds = new Set();` lines — change:

```js
        const allJobs = [];
        const seenJobIds = new Set();
```

to:

```js
        const allJobs = [];
        const seenJobIds = new Set();
        let sawConfirmedEmpty = false;
```

- [ ] **Step 6: Return the `{ jobs, emptyConfirmed }` contract shape**

In `scrapeIndeed`, the success path currently ends:

```js
        await lease.reportSuccess(`Scraped ${normalizedJobs.length} jobs successfully`);

        return normalizedJobs;
```

Replace with:

```js
        await lease.reportSuccess(`Scraped ${normalizedJobs.length} jobs successfully`);

        // BaseScraper (Plan 1A) accepts an Array OR { jobs, emptyConfirmed }.
        // emptyConfirmed:true only when Indeed positively showed its
        // no-results marker — so a genuine empty is logged as confirmed
        // (no zero-result alert) while an unexplained empty stays a
        // suspected-silent-block signal. Behavior-neutral when STRICT off.
        return { jobs: normalizedJobs, emptyConfirmed: sawConfirmedEmpty && normalizedJobs.length === 0 };
```

- [ ] **Step 7: Run the guard tests + full suite**

Run: `node --test test/scrapers/indeed-block.test.js`
Expected: all pass (5 helper + 3 guards = 8), 0 fail.

Run: `npm test`
Expected: whole suite green, `fail 0`.

- [ ] **Step 8: Verify merge-inertness (STRICT off = legacy behavior)**

Run: `node -e "const s=require('node:fs').readFileSync('scrapers/indeed.js','utf8'); const m=[...s.matchAll(/assertNotBlocked\s*\(/g)]; console.log(m.every(x=>/if\s*\(\s*STRICT\s*\)/.test(s.slice(x.index-400,x.index)))?'OK: all assertNotBlocked gated':'FAIL: ungated call'); console.log(/if \(!STRICT\) loginSuccess = true;/.test(s)?'OK: I13 legacy path preserved':'FAIL: I13 legacy path missing');"`
Expected: prints `OK: all assertNotBlocked gated` and `OK: I13 legacy path preserved`.

- [ ] **Step 9: Commit**

```bash
git add scrapers/indeed.js test/scrapers/indeed-block.test.js
git commit -m "feat(indeed): flag-gated block detection + I13 + I2 fixes (strict OFF = inert)

assertNotBlocked + deferred loginSuccess + page-1-zero-throw all gated by
SCRAPER_STRICT_EMPTY. Default (off) is byte-identical to pre-1C Indeed;
flipping the flag per-host activates the silent-block fix. Returns the
{jobs,emptyConfirmed} BaseScraper contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Verification + handoff notes

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-phase1c-indeed-NOTES.md`

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: every file green; final `fail 0`. Record pass count.

- [ ] **Step 2: Confirm only Indeed touched**

Run: `git diff origin/main -- scrapers/ ':!scrapers/indeed.js'` and `git diff origin/main -- src/`
Expected: BOTH empty (Plan 1C-Indeed touches only `scrapers/indeed.js` + `test/scrapers/indeed-block.test.js`; no other scraper, no `src/`).

- [ ] **Step 3: Confirm flag-gated inertness statically**

Run: `grep -n "STRICT" scrapers/indeed.js`
Expected: shows `const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true'` and every `assertNotBlocked`/deferred-loginSuccess/page-1-throw under a `STRICT` guard; the `if (!STRICT) loginSuccess = true;` legacy path present.

- [ ] **Step 4: Write the handoff note**

Create `docs/superpowers/plans/2026-05-18-phase1c-indeed-NOTES.md`:

```markdown
# Phase 1C-Indeed — completion notes

Status: COMPLETE. All tests green (`npm test`, fail 0).

Delivered (flag-gated; SCRAPER_STRICT_EMPTY OFF by default = byte-identical
to pre-1C Indeed):
- pure indeedNoResults(html) confirmed-empty detector (unit-tested).
- import + STRICT const; assertNotBlocked() wired post-navigation, gated.
- I13: loginSuccess deferred to confirmed page-0 (STRICT only; legacy
  early-true preserved when off).
- I2: page-0 zero with no no-results marker throws (STRICT only); later
  pages still legitimately end pagination.
- scrapeIndeed returns { jobs, emptyConfirmed } (BaseScraper Plan-1A
  contract). emptyConfirmed observability is always on (harmless off).

Production impact when OFF (shipped default): NONE — verified the legacy
early loginSuccess, break-on-any-zero, and no assertNotBlocked call.
Activation = set SCRAPER_STRICT_EMPTY=true on a host (instantly
reversible). M5 honored: assertNotBlocked sees the search-results
document, never a scraped job title.

Remaining Plan 1C scrapers (same flag-gated template, parallelizable —
disjoint files): glassdoor.js (I3/I14), dice.js (T9), techfetch.js
(T1/T2/T3/T4), linkedin.js (L1/L2). monster.js is de-registered (skip
until residential proxies). Only AFTER all are wired should the operator
flip SCRAPER_STRICT_EMPTY=true per host (start with one, watch the
zero-result / blocked alerts from Plan 1B).
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-18-phase1c-indeed-NOTES.md
git commit -m "docs(plan): Phase 1C-Indeed completion + remaining-scraper handoff

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** I1/F4 (block → throw, gated) → Task 2 Step 5 ✓; I13 (defer loginSuccess) → Task 2 Step 4 + Step 5 ✓; I2 (page-1 zero ≠ end) → Task 2 Step 5 ✓; confirmed-empty signal → Task 1 helper + Task 2 Step 5/6 ✓; M5 (only block-page doc to assertNotBlocked, never a job title) → satisfied by calling on the search-results document, asserted in the plan rationale ✓.

**2. Placeholder scan:** No TBD/TODO. Every code step shows exact before/after in full context; every run step has an exact command + expected result. The "browser flow not unit-testable" reality is handled honestly via a pure extracted helper + static wiring/gating guards + reuse of Plan 1A's proven `assertNotBlocked` tests — not a placeholder, a deliberate testability strategy.

**3. Type/name consistency:** `STRICT`, `indeedNoResults`, `sawConfirmedEmpty`, `assertNotBlocked`, return `{ jobs: normalizedJobs, emptyConfirmed }` are consistent across Tasks 1–3 and match `assertNotBlocked`'s signature (`{status,finalUrl,title,html,platform}`) shipped in Plan 1A and the BaseScraper `{jobs,emptyConfirmed}` contract shipped in Plan 1A.

**4. Scope:** One scraper file + its test. Flag-gated so OFF = provably byte-identical (Task 2 Step 8 + Task 3 Step 3 verify). The remaining four scrapers are the same template as separate, parallelizable plans (disjoint files), correctly carved out in the NOTES. No issues requiring rework.
