# Glassdoor scraper — hardening + geo-redirect fix

**Date:** 2026-06-12
**Scope:** Lift `scrapers/glassdoor.js` (584 lines) to the Monster/Dice/Indeed robustness pattern AND fix the geo-redirect data-quality bug that silently returns wrong-country jobs when scraping from a non-US IP.

## Ground truth (live probes 2026-06-11/12)

Probe harnesses: `scripts/glassdoor-deep-probe.mjs`, `scripts/glassdoor-us-url-probe.mjs`, `scripts/glassdoor-locid-probe.mjs`. Artifacts: `/tmp/glassdoor-deep-probe.json`, `/tmp/glassdoor-{search,card,detail,no-results,us-forced}.html`.

| Property | Today |
|---|---|
| **Geo-redirect bug (confirmed)** | `Job/jobs.htm?sc.keyword=X&sc.location=United States` from a non-US IP → Glassdoor redirects to `glassdoor.co.in` AND **rewrites the search to the IP's country** (`india-software-engineer-jobs-SRCH_IL...`). Location parameter silently swallowed; results are India jobs. |
| **Fix (verified)** | Canonical SRCH URL with explicit location ID — `/Job/united-states-software-engineer-jobs-SRCH_IL.0,13_IN1_KO14,31.htm?fromAge=7` — keeps results pinned to the requested country even from a non-US IP. Domain still cosmetically redirects to `.co.in` (with `&countryRedir` appended) but **all 30 sampled cards were US jobs**. |
| **Location resolution endpoint (verified)** | `GET /findPopularLocationAjax.htm?maxLocationsToReturn=3&term=<text>` (in-page fetch, session cookies needed) returns ranked JSON: `United States→{locationType:"N",locationId:1}`, `New York→C/1132348`, `California→S/2280`, `Texas→S/1347`. |
| **"Remote" caveat** | Resolves to "Remote, India" (S12563) from this IP — geo-ambiguous. Special-case: pin `IN1` (US) + append `&remoteWorkType=1`. |
| Card selectors | `.jobCard`, `[data-test="jobListing"]`, `[data-jobid]`, `a[data-test="job-title"]` — all return 30/30. Healthy. |
| Detail page | **Full JSON-LD JobPosting present** + `[class*="JobDetails_jobDescription"]` + salary estimate. JSON-LD-first extraction is sound (current code already does this). |
| No-results page | **Still renders ~5 "suggested job" cards** + "no results" body text. Card-count alone CANNOT detect empties — text check must come first. |
| Cloudflare | CloakBrowser passes cleanly; 5/5 hammer, no blocks. Existing `extractJobDetailsFromHTML` already detects `Security|Just a moment` titles. |
| Hardcoded domain bug | `jobLink: 'https://www.glassdoor.co.in' + href` — wrong domain for non-India scrapes. Fix: use the page's final hostname. |
| Brittle selectors | Company/rating/easyApply fallbacks use hashed CSS-module classes (`EmployerProfile_compactEmployerName__9MGcV`) that rot on every Glassdoor rebuild. Title/location/salary/link use stable `data-test` attrs. |

## Current gaps (vs the fleet pattern)

1. No typed errors — untyped throws propagate raw.
2. No page-state classifier — 0 cards indistinguishable between empty / blocked / DOM-changed.
3. No `strictEmpty` in registry.
4. No fixture-driven tests (zero Glassdoor tests exist).
5. No debug harness.
6. Geo-redirect + hardcoded `.co.in` (above) — silent wrong-country data.
7. `loginSuccess` vestige variable (never acted on).

## Design

### A) Location resolution — `resolveGlassdoorLocation(page, term)`

In-page fetch (needs session cookies, so runs AFTER homepage warmup):

```js
// returns {locType:'N'|'S'|'C', locId:number, label} or null on no-match
async function resolveGlassdoorLocation(page, term) { /* page.evaluate(fetch(...)) */ }
```

- Take the **first** result (endpoint ranks by relevance).
- Pure helper `pickGlassdoorLocation(results, term)` does the selection logic (exported, unit-tested): prefer exact case-insensitive `label`/`longName` prefix match, else first entry; return null for empty/garbage input.
- **"remote"** (case-insensitive trim) never hits the endpoint → returns the sentinel `{remote: true}`; URL builder pins `IN1` + `remoteWorkType=1`.
- Resolution failure (endpoint error / no results) → fall back to `{locType:'N', locId:1}` (US pin) + `log.warn`. Never free-text — that re-opens the geo bug.

### B) Canonical URL — `buildGlassdoorSearchUrl({keyword, location})` (pure)

```
/Job/{locSlug}-{kwSlug}-jobs-SRCH_IL.0,{L}_I{T}{id}_KO{L+1},{L+1+K}.htm?fromAge=7
```

- `L` = locSlug length, `K` = kwSlug length, `T` = locationType (N/S/C), slugify = lowercase + non-alnum→hyphen + collapse.
- Example (verified live): `united-states` (13) + `software-engineer` (17) → `SRCH_IL.0,13_IN1_KO14,31`.
- Remote: locSlug `united-states`, `_IN1`, plus `&remoteWorkType=1`.
- Always `fromAge=7` (existing behavior).

### C) Classifier — `classifyGlassdoorSearchPage({url, bodyText, cardCount, bytes, html, expectedLocToken})` (pure)

Resolution order (justified by probe):

1. `soft_blocked` — block-text regex (`cloudflare|verify you are human|just a moment|ray id|security check|help us protect`) in bodyText or `captcha|challenge` in URL.
2. `empty_confirmed` — no-results text (`no results|couldn't find|0 jobs matching`) — **before card count** because suggested cards render on empty pages.
3. `geo_redirected` — final URL's SRCH segment no longer contains `expectedLocToken` (e.g. `_IN1`, `_IS2280`, `_IC1132348`). Detects Glassdoor rewriting the pinned search. NEW state, Glassdoor-specific.
4. `results` — `cardCount > 0`.
5. `dom_changed` — bytes ≥ 100KB, no other signal.
6. `network_error` — fall-through.

### D) Search-page extraction — `parseGlassdoorCard($, $card, baseUrl)` (pure)

- Stable `data-test` selectors load-bearing: title (`[data-test="job-title"]`), employer (`[data-test="job-employer"]` with hashed-class fallback best-effort), location (`[data-test="emp-location"]`), link (`[data-test="job-link"]`), salary (`[data-test="detailSalary"]`).
- `jobLink` = `new URL(href, baseUrl).toString()` — **baseUrl from `page.url()`**, never hardcoded.
- Sentinel: missing title or (missing link AND missing jobId) → `{__domChanged, reason}`; rating/easyApply/salary best-effort (no sentinel).
- jobId from `job-title` id attr or `jl=` URL param (existing logic, kept).

### E) Detail extraction

Keep current shape (JSON-LD-first, DOM fallback, block-title check). No rewrite — already sound. Wrap so a 100%-failure batch surfaces as warning, not silence.

### F) Orchestrator + typed errors

- Keep: CloakBrowser anonymous launch, homepage warmup, `loadAllJobs` load-more loop (button verified present), 30-job cap, parallel detail tabs.
- Replace untyped failures: `BlockedError({kind:'cloudflare'})`, `DomChangedError`, `NetworkError`, and **`GeoRedirectError`?** No — YAGNI on a new error class; `geo_redirected` → `DomChangedError` with a `geo` note? Wrong semantics. Use `ValidationError`? Also wrong. **Decision: `BlockedError({kind:'geo-redirect'})`** — operationally it means "this IP/session can't serve the requested location"; remediation (proxy/VPN) matches BlockedError semantics, and `kind` discriminates.
- Partial-result policy: detail enrichment for Glassdoor happens per-batch AFTER card extraction (like Indeed) — partial returns must run enrichment first (Indeed lesson, `enrichAndCollect` pattern).
- `{jobs:[], emptyConfirmed:true}` on `empty_confirmed`.
- **No cooldown module** — probe showed zero blocks (5/5); CloakBrowser handles Cloudflare. Add later if stress shows otherwise (YAGNI).
- Drop the `loginSuccess` vestige.

### G) Registry + harness + tests

- `glassdoor: new BaseScraper('glassdoor', scrapeGlassdoor, { strictEmpty: true })`.
- `scripts/test-glassdoor-scrape.js` + `npm run glassdoor:test-scrape` (mirror of the other harnesses; bad-row gate; no cooldown exit code).
- Fixtures: `test/fixtures/glassdoor-{search,card,no-results}.html` (from probe artifacts; detail HTML is 660KB — extract just the JSON-LD block into `glassdoor-detail-jsonld.json` instead).
- Pure tests: `buildGlassdoorSearchUrl` (slug math!), `classifyGlassdoorSearchPage` (6 states incl. the suggested-cards-on-empty case), `parseGlassdoorCard` (fixture + sentinels + domain handling), `pickGlassdoorLocation` (endpoint-response fixtures).

## Out of scope

- LinkedIn/Monster/Dice/Indeed/TechFetch scrapers (ring-fenced).
- Proxies, cooldown module, auth (Glassdoor is anonymous).
- Backend changes.

## Success criteria

- Live: `npm run glassdoor:test-scrape -- "software engineer"` from this (non-US) IP returns ≥ 20 jobs with **US locations**, 0 bad titles/companies, jobLinks on the actual serving domain.
- No-results fixture → `empty_confirmed` (suggested cards do NOT extract).
- Forced wrong-loc URL → `geo_redirected` → `BlockedError(kind:'geo-redirect')`.
- All existing 359 tests + ~30 new pass.
