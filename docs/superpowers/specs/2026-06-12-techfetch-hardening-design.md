# TechFetch scraper — anonymous-first + hardening

**Date:** 2026-06-12
**Scope:** Restructure `scrapers/techfetch.js` (909 lines) to anonymous-first operation with login as an on-demand fallback, and lift it to the fleet robustness pattern (typed errors, classifier, strictEmpty, fixtures, harness).

## Ground truth (live probes 2026-06-11/12)

Probe harnesses: `scripts/techfetch-deep-probe.mjs`, `scripts/techfetch-anon-probe.mjs`. Artifacts: `/tmp/techfetch-deep-probe.json`, `/tmp/techfetch-{card,list,detail}.html`.

| Property | Today |
|---|---|
| **Anonymous search (verified end-to-end)** | `js_s_jobs.aspx` loads without login; `#txtKeyword` fill + submit → `js_job_list.aspx` with **20 job rows**. No login redirect. |
| **Anonymous detail page** | Loads fully (197KB), all `lbl*` fields present (`lblJobDesc`, `lblRate`, `lblLocation`, `lblSpecSkill`, …). |
| **Anonymous pagination** | `window.LoadJobs('/js/ajs_job_list.aspx?From=2')` swap verified working. |
| **Credential availability** | **None in the API.** Current login-first code waits up to 10 minutes (10 × 60s) then throws an untyped Error — the scraper is effectively dead today. |
| Card shape | `[id*="_divJob"]` rows; title at `[id*="_lblTitle"] a`; href form `/job-description/<slug>-j<digits>&aid=tfjstfviewjob&utm_…` (the `&aid` is literally part of their path-ish URL); location at `[id*="_lblLocation"]`. |
| Detail page | Multiple `ctlNN_lbl*` groups (main job + related jobs) — existing extraction already handles. Stack: playwright-extra + StealthPlugin + JSDOM. |
| No-results signal | Not yet captured live (probe gap) — plan Task 1 captures it with a garbage-keyword search before implementation. |
| Existing strengths to preserve | Lease-keyed `reportSuccess`/`reportFailure` (LinkedIn-pattern, already correct), `navigateWithRetry` exponential backoff, in-place `LoadJobs` AJAX pagination (the "session state intact" fix), rich detail extraction with desktop+mobile selector pairs. |

## User decision (2026-06-12)

**Anonymous-first with login as optional fallback** (explicitly chosen over drop-login-entirely and keep-login-first).

## Design

### A) Flow restructure — anonymous-first

```
scrapeTechFetch(jobTitle, location, sessionId)
  → launch browser (no credential, no wait)
  → js_s_jobs.aspx → fill #txtKeyword → submit
  → classifyTechFetchListPage(...)
      results        → extract rows, paginate via LoadJobs, detail-enrich, return
      empty_confirmed→ {jobs:[], emptyConfirmed:true}
      auth_required  → ONE credential attempt (see B)
      dom_changed    → DomChangedError
      network_error  → NetworkError
```

The 10-retry × 60s credential wait loop **dies**. Anonymous needs no credential at all.

### B) Login fallback (only on `auth_required`)

- `apiClient.acquire('techfetch', sessionId)` — **single attempt, no wait loop**.
- No lease → `AuthError('TechFetch requires login but no credential available', {platform:'techfetch'})`.
- Lease → existing login flow (`js_login.aspx`, `txtemailid`/`txtpwd`, JSLogin-cookie-as-truth) → retry the search **once**. Second `auth_required` → `lease.reportFailure(…, 0)` + `AuthError`.
- Success path keeps `lease.reportSuccess(...)`; all lease semantics preserved.
- Today this path is dormant (anonymous works; no credential exists) — it's insurance against a future paywall, surfaced loudly when it trips.

### C) Classifier — `classifyTechFetchListPage({url, rowCount, hasLoadJobsFn, bodyText, bytes})` (pure)

1. `auth_required` — URL matches `/login/i` (`js_login.aspx` redirect).
2. `results` — `rowCount > 0`.
3. `empty_confirmed` — no-results text (exact signal captured in plan Task 1; seed regex `no (more )?jobs|no results|not found` refined against the live fixture).
4. `dom_changed` — `hasLoadJobsFn === true` but 0 rows and no empty text (the ASP.NET shell rendered, list markup changed), or bytes ≥ 50KB.
5. `network_error` — fall-through.

No `soft_blocked`: TechFetch has no anti-bot wall (no Cloudflare/DataDome observed); the stealth stack stays as-is. If one ever appears it'll surface as `dom_changed`/`network_error` and we add the state then.

### D) Row extraction — `parseTechFetchRow(rowHtml)` / module-scope pure helper

- Extracted from the class so it's fixture-testable (JSDOM in tests, same as runtime — the scraper already uses JSDOM).
- Load-bearing: title text, href. Sentinel `{__domChanged, reason}` on missing.
- **URL canonicalization** — `canonicalTechFetchJobUrl(href)` (pure): absolute-ize against `https://www.techfetch.com`, strip `utm_*` params; **keep `&aid=…`** unless the plan's live verify step proves the stripped form resolves (probe showed the full form works; stripping utm is safe, stripping aid unverified → keep aid by default).
- Location, postedDate, rate etc. best-effort (existing selectors preserved).

### E) Detail extraction

Existing rich extraction preserved (works anonymously per probe). Wrapped: per-job failures already retry; a batch-level 100% failure surfaces as a warning + partial flag, not silence.

### F) Typed errors / partial-result / registry

- `AuthError`, `DomChangedError`, `NetworkError`, `ParseError` replace untyped `Error`s.
- Partial-result policy: detail enrichment is per-page-batch in the existing code; on mid-run throw with ≥1 enriched job collected → `{jobs, emptyConfirmed:false, partial:true}` (run enrichment for pending raw rows first — Indeed lesson).
- `techfetch: new BaseScraper('techfetch', scrapeTechFetch, { strictEmpty: true })`.

### G) Harness + tests

- `scripts/test-techfetch-scrape.js` + `npm run techfetch:test-scrape`. Exit 2 generic, 3 bad-row, 4 AuthError (credential needed but unavailable).
- Fixtures: `test/fixtures/techfetch-{list,card,no-results}.html` (+ detail lbl-field sample if small enough; else skip — detail extraction is preserved code, not new).
- Pure tests: `classifyTechFetchListPage`, `parseTechFetchRow`, `canonicalTechFetchJobUrl`.

## Out of scope

- Other scrapers (ring-fenced). Proxies. Cooldown module (no anti-bot observed). Backend changes. Migrating off playwright-extra→CloakBrowser (works as-is; separate slice if ever needed).

## Success criteria

- Live: `npm run techfetch:test-scrape -- "java developer"` returns ≥ 15 jobs anonymously with 0 bad titles/links, **no credential wait**.
- Garbage keyword → `empty_confirmed` → `{jobs:[], emptyConfirmed:true}` (no strict-empty false alarm).
- All prior tests + ~25 new pass.
