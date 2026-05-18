# Blacklight Scraper — Deep Anti-Bot Durability Audit & Remediation Plan

- **Date:** 2026-05-18
- **Repo:** Unified Job Scraper (`unified-job-scraper` v2.0.0), Node.js 20 ESM
- **Audit lens (weighted):** Anti-bot durability — (a) resistance to being blocked/challenged, (b) resilience to site DOM changes. All other categories (reliability, correctness, security, observability, supply-chain, code-quality) ranked objectively; anti-bot durability weighted heaviest on ties.
- **Method:** Six independent read-only deep-read agents, one per domain (core pipeline; shared stealth foundation; LinkedIn; TechFetch/Dice/Monster; Indeed/Glassdoor; observability/security/supply-chain/docs). No code was run. Every finding cites `file:line`.
- **Status:** Plan only. **No implementation** until specific items are individually greenlit.
- **Finding count:** 79 (11 C · 13 F · 10 L · 17 T · 16 I · 12 O).

---

## 1. Executive summary

Six agents audited six independent domains without shared context. **All six independently surfaced the same defect.** That convergence is the central result:

> **A blocked or DOM-changed scraper returns an empty array. The framework records that as `success`. The orchestrator submits `success`/0-jobs to the backend and completes the role. The credential is reported *healthy* and the poisoned cookie is immediately re-leased to the next run. No failing metric is emitted, `classify.js` never runs (nothing throws), the heartbeat stays green, and `scraper_up` is hard-coded to `1`. No alert fires.**

The headline test — *"If every scraper got 100% blocked tonight, how and when would anyone find out?"* — answers itself: **not from this system, and not for days**, until a human notices downstream candidate-matching produced nothing.

This is the dominant anti-bot durability failure. Every other finding is either a **cause** of it (no centralized block detection, no "blocked" error type, no zero-jobs metric) or a **second-order risk** (credential-lease leaks, supply-chain drift, DOM fragility, doc/code contradictions).

The remediation plan is therefore structured **loud-first**: Phase 1 converts the entire class of silent failures into loud, classified, alertable failures **without changing how scraping is performed** (near-zero production risk), then later phases reduce how often blocks happen and harden the rest.

### 1.1 The silent-failure chain, confirmed at every layer

| Layer | Mechanism (file:line) | Findings |
|---|---|---|
| Framework | `BaseScraper.execute` records `recordSession(platform,'success')` for any non-throwing return incl. `[]`; no challenge inspection (`src/core/base-scraper.js:38-67`) | F3, F12 |
| LinkedIn | Block / both-DOM-fail → `extractPosts` returns `[]` → `lease.reportSuccess("Scraped 0 posts successfully")` (`scrapers/linkedin.js:1028-1047,1337-1340`); no mid-scrape block check | L1, L2 |
| TechFetch | Empty/challenge list page → `[]` → `lease.reportSuccess("Scraped 0 jobs successfully")` (`scrapers/techfetch.js:632-666,811-846`); search-form error swallowed (`:196-226`) | T1, T4 |
| Dice / Monster | CF/DataDome 200-challenge → 0 cards → silent empty return (`scrapers/dice.js:96-181,343-349`; `scrapers/monster.js:113-155`) | T9, T15 |
| Indeed / Glassdoor | CF challenge → 0 cards → `break` → `reportSuccess` + stale cookie re-leased clean (`scrapers/indeed.js:633-641,696`); Glassdoor search path has no block check (`scrapers/glassdoor.js:520-573`); `loginSuccess=true` set before navigation kills cooldown taxonomy (`scrapers/indeed.js:601-608`) | I1, I3, I13 |
| Pipeline | `completeSession` called unconditionally; submits `success`/`[]` (`src/queue/orchestrator.js:233-303`) | C1, C3, O9 |
| Observability | No zero-jobs metric; `recordJobsScraped` early-returns on 0 (`src/metrics/registry.js:223-226`); `classify.js` only on throw; `scraper_up` constant `1`; residential hosts default to `interactive` (no alert) | O1, O2, O3, O5, O10 |

### 1.2 Severity summary

| Severity | Count | IDs |
|---|---|---|
| 🔴 Critical | 11 | C1 · F1, F3, F4 · L1, L2 · T1 · I1, I3 · O1, O2 |
| 🟠 High | 24 | C2, C3, C4 · F2, F5, F6, F7, F8 · L3, L4 · T2, T3, T4, T9 · I2, I4, I6, I7, I8, I13 · O3, O4, O5, O7 |
| 🟡 Medium | 31 | C5, C6, C7, C8 · F9, F10, F11, F12 · L5, L6, L7 · T5, T6, T7, T8, T10, T11, T12, T13, T14, T15 · I5, I9, I10, I11, I12, I14 · O6, O8, O9, O10 |
| ⚪ Low | 13 | C9, C10, C11 · F13 · L8, L9, L10 · T16, T17 · I15, I16 · O11, O12 |

O10 (`scraper_up` deceptive) is rated Medium for its deception value though the code change is trivial; it also participates in the headline blindness described in §1.1.

### 1.3 What is genuinely done well (baseline to preserve)

- **Lease-keyed `reportSuccess/Failure`** (`src/api/credentials.js:151-160`) correctly fixes the concurrent cross-release race; **pre-flight credential availability check** (`src/queue/orchestrator.js:118-150`) addresses a real prior incident and fails open if the endpoint is down.
- **HTTP client** (`src/http/client.js:78-155`): full-jitter exponential backoff, per-host circuit breaker, AbortController timeout cleared in `finally`, conservative retry set (408/429/5xx only).
- **Per-platform isolation** via `Promise.allSettled` + per-task try/catch (`src/queue/orchestrator.js:210-288`) — one platform throwing cannot poison siblings.
- **Telemetry transports are defensively coded**: bounded Loki buffer (`BUFFER_HARD_LIMIT=5000`) with drop accounting and newest-kept requeue (`src/logger/loki-transport.js:105-191`), pushes never throw into the scrape loop (`src/metrics/push.js:128`), recursive-log guard, secret masking in the logger (`src/logger/index.js:21-55`).
- **TechFetch shutdown-race guard** (`scrapers/techfetch.js:853-866`) — does not fail a credential when SIGTERM closed the browser; real production hardening.
- **Cookie-shape hardening** (`scrapers/indeed.js:84-96`, `scrapers/linkedin.js:47-57`) handles numeric/string/ISO expiry, avoiding the NaN-expiry crash class.
- **Layered shutdown budget** (`server.js:114-166`) so a hung dependency cannot block process exit.
- **Example secrets are placeholders** (`config/credentials.example.json` uses `REPLACE_ME_*`); `.gitignore` correctly excludes `config/credentials.json`, `config/*.local.json`, `.env`, `.env.*` (with `!.env.example`).
- **Institutional knowledge encoded in comments**: Indeed parenthesis-stripping query sanitization, `waitUntil:'load'` to let Cloudflare's JS challenge resolve, Monster `humanize:true` requirement, legacy-probe selector logging.

---

## 2. Remediation plan — "Loud-first, then harden"

Five phases. **Phase 1 is the keystone and is deliberately detection-only** — it changes *whether failures are visible*, not *how scraping behaves*, so it carries near-zero production risk while neutralizing the dominant Critical and stopping active credential-poisoning damage.

**Sequencing & dependencies:**

- **Phase 1** is independent and must be first. You cannot safely change scraping behavior (Phase 2) on a live system while blind to whether those changes cause blocks.
- **Phase 2a** (revive/centralize the shared stealth layer) gates 2b–2e.
- **Phases 3, 4, 5** are independent of each other and may be reordered freely once Phase 1 lands.
- Effort key: **S** ≈ <½ day · **M** ≈ ½–2 days · **L** ≈ multi-day / cross-cutting.

| Phase | Theme | Risk | Findings | Exit criterion |
|---|---|---|---|---|
| 1 | Make every silent failure loud & observable | Minimal (no scraping-behavior change) | C1, C3, F3, F4, F8, F11, F12, L1, L2, T1, T4, T9, T15, I1, I2, I3, I13, I14, O1, O2, O3, O4, O5, O9, O10 | A forced block on any platform → typed throw → credential cooldown → `failed`/`blocked` metric → fired alert |
| 2 | Structural anti-bot hardening | Medium (fleet-wide launch/fingerprint/cookies) | F1, F2, F5, F6, F7, F9, F10, I6, I7, I8, I12, I15, L6, L7, T6, T11, T17 | One real shared stealth path; per-credential fingerprint; proxy plumbing; cookie lifecycle validated |
| 3 | Credential & pipeline reliability | Low–Medium | C2, C4, C5, C6, C7, C8, C11 | No lease leaks across crash/SIGTERM; idempotent submits; real readiness probe |
| 4 | DOM resilience & data quality | Low–Medium | F13, L3, L4, L8, L9, T2, T3, T5, T7, T10, T12, T14, I5, I9, I10, I11, I16 | Stable-attribute-first selectors; detail-failure thresholds; correct pagination |
| 5 | Supply chain, docs, hygiene | Medium (supply chain) / Low | C9, C10, L5, L10, I4, T8, T13, T16, O6, O7, O8, O11, O12 | One pinned package manager + committed lockfile + CI drift gate; docs match code |

---

## 3. Findings catalogue (by phase)

> Each finding: **Severity · Category · Effort** / **Location** / **Evidence** / **Impact** / **Fix**. IDs preserve the auditing agent's prefix (C=core, F=stealth foundation, L=LinkedIn, T=TechFetch/Dice/Monster, I=Indeed/Glassdoor, O=observability/security/supply-chain/docs). Cross-references note where two agents reported the same root from different layers.

### Phase 1 — Make every silent failure LOUD & observable

#### [C1] Blocked scraper parsing 0 jobs from a challenge page is reported as a healthy `success`
- **Critical · anti-bot-durability · M**
- **Location:** `src/queue/orchestrator.js:233-254`; `scrapers/indeed.js:633-641,696-698`; `scrapers/techfetch.js:632-666,734-744,811-846`
- **Evidence:** On a Cloudflare/DataDome challenge, `extractJobs*` returns `[]`; the page loop `break`s; `loginSuccess` is already `true`; `await lease.reportSuccess(...)` runs; orchestrator calls `submitJobs(sessionId, platform, [], 'success')` and `recordJobsSubmitted(platform,'success',0)`. Per-page `catch` in TechFetch just `break`s; Indeed's catch only treats it as failure if the message matches `cookie|login|auth` — a silent challenge matches none.
- **Impact:** A fully blocked platform is indistinguishable from "no jobs found". Credential never cooled down (keeps being handed out to burn against the challenge), session completes "successfully", `success` metric emitted. Sustained block ⇒ zero alerts, steadily zero jobs, green dashboards.
- **Fix:** After navigation, detect challenge/interstitial markers and `throw` a typed error (see F8/§Phase-1 taxonomy) so `classifyError` tags `blocked`/`captcha`/`auth_required` and `reportFailure` applies a cooldown. Treat `jobs.length===0` on the first page as an anomaly: never `reportSuccess`; surface a distinct `submitJobs(...,'empty')`/`'failed'` status. Add `scraper_zero_jobs_total{platform}` + alert.

#### [C3] `completeSession` is called even when every platform in the session failed or was blocked
- **High · correctness · M**
- **Location:** `src/queue/orchestrator.js:277-303`
- **Evidence:** `results.summary.failed/successful` are tallied (`:278-288`) but never consulted; `completeSession(sessionId)` is unconditional (`:291`). No `if (results.summary.successful === 0)` branch.
- **Impact:** A session where every platform threw or was silently blocked is still "completed", which (per the orchestrator's own doc comment) makes the backend finalize role status and fire matching with zero jobs. Block invisible at the role level; blast radius scales with platforms-per-assignment.
- **Fix:** When `successful === 0`, call a distinct fail/abort session endpoint (or pass per-platform outcomes into completion). Do not report individual platforms as `'success'` with empty arrays (ties to C1). Emit `session_all_failed_total` + alert.

#### [F3] No centralized block / challenge / CAPTCHA detection in BaseScraper
- **Critical · anti-bot-durability · M**
- **Location:** `src/core/base-scraper.js:38-67`
- **Evidence:** `execute()` calls the scraper fn, then unconditionally `recordSession(platform,'success')` and returns `jobs ?? []`. No inspection of page state, HTTP status, final URL, or body for interstitials. Zero-length result logged `"Scrape complete" {jobCount:0}` and counted success.
- **Impact:** The framework structurally cannot distinguish "blocked/challenged" from "no results". Any scraper that reaches a wall and extracts 0 cards is recorded as a healthy empty scrape. Alerting, retry, and credential rotation are all blind.
- **Fix:** Introduce a shared `assertNotBlocked(page|html|Response, platform)` called by BaseScraper or a mandatory helper: final-URL host/path block-hints; title (`Just a moment`, `Additional Verification Required`, `Access Denied`); challenge DOM (`#challenge-running`, `iframe[src*=challenges.cloudflare.com]`, `captcha-delivery.com`); status 403/429 → throw `BlockedError`. Treat "0 results AND no recognizable results container" as suspected-block, not success.

#### [F4] Indeed search path has zero block detection — Cloudflare interstitial reported as successful 0-job scrape
- **Critical · anti-bot-durability · M** — *same root as I1 (reported independently by two agents); fix once.*
- **Location:** `scrapers/indeed.js:604-643`; `src/core/base-scraper.js:42-49`
- **Evidence:** After `page.goto(searchUrl,{waitUntil:'load'})` + `humanDelay(8000,12000)`, code does `page.content()` → `extractJobsFromSearchPage` with no check of `page.url()`, status, or title. The comment at `indeed.js:620-622` acknowledges the "Additional Verification Required" page can render but only adjusts `waitUntil`. The block regex at `:711` only runs if an exception is thrown; the 0-results path throws nothing.
- **Impact:** Cloudflare challenge → 0 cards → `break` on page 0 → `scrapeIndeed` returns `[]` → `BaseScraper` records `success`/`jobCount:0`. Identical to "no jobs this week"; credentials/IP never flagged.
- **Fix:** Same as F3/C1 at the Indeed boundary; distinguish empty-results-container from zero-jobs.

#### [F8] `errors.js` taxonomy cannot express "blocked / challenged"
- **High · anti-bot-durability · M**
- **Location:** `src/core/errors.js:4-56`; `src/metrics/classify.js:14-55`
- **Evidence:** Classes are `ScraperError, AuthError, NetworkError, TimeoutError, ParseError, BrowserError, ValidationError`. No `BlockedError`/`ChallengeError`/`CaptchaError`. The only "blocked" path is `classify.js` regex on a thrown message containing `captcha|cloudflare|datadome` — never reached on silent 0-result paths.
- **Impact:** The single most important anti-bot distinction (blocked vs auth-expired vs DOM-changed vs genuinely-empty vs transient) is not representable. 403 → `auth_required` triggers credential rotation when the real fix is IP/fingerprint/backoff.
- **Fix:** Add `BlockedError extends ScraperError ({code:'BLOCKED'})` and `DomChangedError` (or a distinct `dom_changed` reason). Map to dedicated metric reasons `blocked`/`challenged`/`dom_changed`; split 403-from-anti-bot vs 401-real-auth in `classify.js`.

#### [F11] Block-hint matching is substring-on-bodyText / title — high false-negative & false-positive risk
- **Medium · reliability · M**
- **Location:** `scripts/cloak-probe.mjs:77-83`; `scrapers/glassdoor.js:382`
- **Evidence:** Probe decides `blocked` via `finalUrl/title/bodyText.includes(hint)` over the first 600 chars; Glassdoor's only block check is `title.includes('Security') || title.includes('Just a moment')`, returning `null` on challenge (indistinguishable from a parse miss).
- **Impact:** A results page containing "Sign in" in a header is flagged blocked; a challenge page worded differently or beyond 600 chars is flagged not-blocked (false success).
- **Fix:** Detect via stable structural signals (status, final-URL host, challenge iframes/DOM IDs, absence of results container), centralized in the shared `assertNotBlocked` (F3) so all callers share one hardened implementation.

#### [F12] BaseScraper success metric records before result sanity — masks degraded scrapes
- **Medium · observability · S**
- **Location:** `src/core/base-scraper.js:43-49`
- **Evidence:** `recordSession(platform,'success')` + `recordJobsScraped(platform,jobCount)` fire for any non-throwing return incl. `jobCount===0`. No minimum-yield/anomaly check.
- **Impact:** Even with F3 fixed at the scraper level, a partial block (far fewer jobs) is still "success". No signal for "healthy but yield collapsed" — a common early soft-block / DOM-drift indicator.
- **Fix:** Emit a distinct outcome / alert when `jobCount===0` or below a per-platform expected floor; track rolling yield and alert on anomalous drops.

#### [L1] LinkedIn: zero jobs reported as SUCCESS when blocked or when both DOM extractors fail
- **Critical · anti-bot-durability · M**
- **Location:** `scrapers/linkedin.js:1207-1340` (esp. 1232-1340), `1028-1047`, `462-467`
- **Evidence:** `extractPosts()` returns `[]` on every failure mode (auth-wall, captcha, checkpoint, "no results", both NEW+LEGACY selectors empty). Caller does not inspect emptiness: `loginSuccess=true; await lease.reportSuccess(\`Scraped ${n} posts successfully\`)` runs unconditionally. `dumpDebugSnapshot()` writes a local file but its return is never checked; `authPromptsDetected` (`:505-507`) is written to a file but never read by control flow.
- **Impact:** Block or both-extractor DOM change → success with 0 jobs, credential marked healthy, pipeline silently yields nothing across many runs.
- **Fix:** Treat `posts.length===0` as a failure signal. After the query loop, evaluate page state (reuse `authPromptsDetected`/container-count) and `reportFailure` with cooldown (60 min auth/challenge, 30 min otherwise) + throw. Distinguish "containers found but 0 extracted" (DOM change → loud) from "0 containers" (block/empty). Never `reportSuccess(0)` unless an empty result set is positively confirmed.

#### [L2] LinkedIn: no detection of auth-wall / checkpoint / captcha / rate-limit after initial login
- **Critical · anti-bot-durability · M**
- **Location:** `scrapers/linkedin.js:334-467`, `545-1048`, `150-166`
- **Evidence:** Block detection is only URL-substring checks in `isLoginPage()` (`:150-156`), consulted right after search navigation and in `performLogin()`. The scroll/extract loop (`:603-1026`) never re-checks `page.url()`, `/checkpoint`/`/challenge`, captcha iframes, "Join LinkedIn to see", HTTP 429/999. LinkedIn's same-URL interstitials and in-page walls are never matched.
- **Impact:** LinkedIn soft-blocks at the same URL/in-page → falls through to `extractPosts` returning `[]` → L1 silent success. The 60-min rate-limit cooldown branch (`:1355`) is unreachable because nothing throws a matching error from the scrape phase.
- **Fix:** `detectBlock(page)` after every navigation and periodically in the scroll loop (URL `/checkpoint|/challenge|authwall`, captcha iframes, known block phrases locale-aware, HTTP 999/429 via response listener) → throw `LinkedInBlockedError` so the existing cooldown branch engages.

#### [T1] TechFetch: blocked/empty job-list page reported as a successful 0-job scrape
- **Critical · anti-bot-durability · M**
- **Location:** `scrapers/techfetch.js:242-255`, `554-623`, `632-745`, `811-846`
- **Evidence:** `fetchPageWithBrowser` page 1 wraps `waitForSelector('[id*="_divJob"]',{timeout:15000})` in a `try` whose `catch` is empty ("let extractJobs report 0 below"); `extractJobs` returns `[]`; `scrapeJobs` `break`s; `scrapeTechFetch` sets `loginSuccess=true`, calls `lease.reportSuccess("Scraped 0 jobs successfully")`. No distinction between zero matches and interstitial/session-expiry/DOM-id change.
- **Impact:** Any bot challenge, mid-search session expiry, or `_divJob`/`_lblTitle` id rename ⇒ every scrape returns 0, recorded successful, healthy credential. Fleet silently produces empty results indefinitely.
- **Fix:** Positively detect a valid results page (result-count element / search form / explicit "no matching jobs" element) vs challenge/login (redirect to `js_login.aspx`, missing `JSLogin`, DataDome markers). Non-results page → throw non-`isExplicitAuthError` → 30-min cooldown + failed metric. Only treat 0 as success with an explicit "no results" element.

#### [T4] TechFetch: search-form failure caught and logged but execution proceeds → silent 0-job "success"
- **High · reliability · S**
- **Location:** `scrapers/techfetch.js:196-226`, `640`
- **Evidence:** `search()` wraps keyword-fill+submit in `try { } catch (e) { logProgress(...) }`, swallows, returns normally; `scrapeJobs` calls `await this.search(...)` with no return check and proceeds to `fetchPageWithBrowser(1)`.
- **Impact:** Selector drift on the search form or a logged-out search page ⇒ no search submitted ⇒ 0 `_divJob` ⇒ silent 0-job success (compounds T1).
- **Fix:** Make `search()` return a boolean / throw on failure; abort `scrapeJobs` with a thrown error if the form could not be filled+submitted; verify post-submit URL/DOM transitioned to results.

#### [T9] Dice: block page / Cloudflare interstitial / no-results all funnel into silent empty — no challenge detection
- **High · anti-bot-durability · M**
- **Location:** `scrapers/dice.js:96-107`, `149-181`, `343-349`
- **Evidence:** Search: `goto` → `waitForSelector('body')` → `$$eval('a[href*="/job-detail/"]')`. A challenge page still has `body`; the anchor query returns `[]`; loop continues; `jobUrls` empty; crawler runs zero requests; returns `[]`. Per-job: no `script#jobDetailStructuredData` → silent `return`. No Cloudflare/interstitial detection anywhere; the header's "Dice has no behavioral detection" is an unverified assumption. `scrapeDice` never throws on empty → BaseScraper records success.
- **Impact:** Dice challenge for the datacenter IP (or burst from T8 double-fetch) ⇒ 0 jobs reported successful.
- **Fix:** After search navigation assert a real Dice results page (Cloudflare `cf-chl`/`challenge-platform`, `Just a moment...`, missing results container) and throw on challenge; throw if `jobUrls.length===0` after all pages; fail the run if a high fraction of job pages lack structured data.

#### [T15] Monster: 200-status DataDome challenge/JS-interstitial yields a silent 0-job success
- **Medium · anti-bot-durability · M** *(latent — Monster is currently de-registered; reactivates on re-enable)*
- **Location:** `scrapers/monster.js:113-151`, `25-33`, `142-150`
- **Evidence:** Search loop throws only if `resp.status() >= 400`. DataDome frequently serves its challenge with HTTP 200 + interstitial body ⇒ `extractJobsFromCurrentPage` `[]` ⇒ after 2 consecutive empties `break` ⇒ returns `allJobs.slice(0,maxJobs)` (`[]`) as normal completion. `warmup` ignores non-200/blocked homepage.
- **Impact:** If Monster is re-enabled (post residential proxies) without fixing this, a 200 DataDome challenge ⇒ 0 jobs reported success, no alert.
- **Fix:** Detect DataDome markers (datadome cookie/iframe, `captcha-delivery.com`, interstitial title/script) and a blocked homepage in `warmup`; throw on challenge; 0 jobs with no "no results" element → failure.

#### [I1] Indeed: Cloudflare challenge parses 0 cards, `break`s, reports SUCCESS — silent failure + poisoned cookie
- **Critical · anti-bot-durability · M** — *same root as F4; fix once at the Indeed boundary.*
- **Location:** `scrapers/indeed.js:633-641`, `:696`, `:608`, `:708-718`
- **Evidence:** No inspection for interstitial/Ray-ID/403/login-wall before parse (despite header `:18-28` naming exactly these). 0 cards → `if (pageJobs.length===0){ logProgress(...,'No more jobs found, stopping pagination'); break; }` → `await lease.reportSuccess('Scraped 0 jobs successfully')`. `loginSuccess` hard-set `true` at `:608` before any navigation, so even a thrown error takes the post-login branch and never applies the auth=0/rate-limit=60 cooldown.
- **Impact:** The documented normal failure mode for this setup → `[]` returned, run and credential reported healthy, **the same blocked cookie immediately re-leased** to the next scrape (self-perpetuating). Defeats the entire credentials/cooldown system; undetectable from logs ("Completed!").
- **Fix:** Detect block state before parsing (`page.url()` `/account/login|challenge|/captcha`; title/body `Just a moment`/`Additional Verification Required`/Ray-ID/DataDome; navigation `resp.status()===403/429`) → throw. Set `loginSuccess=false` until a page is confirmed card-bearing (see I13). Treat `allJobs.length===0` after the loop as `reportFailure(...,30)`, not success.

#### [I2] Indeed: page-1 challenge aborts ALL pagination — silent under-collection even when not fully blocked
- **High · correctness / anti-bot-durability · M**
- **Location:** `scrapers/indeed.js:614-641`
- **Evidence:** Loop treats *any* zero-card page as end-of-results. No distinction between page-1 zero (blocked/login-wall/DOM change) and page-4 zero (genuinely exhausted). No per-page retry; no minimum-yield assertion.
- **Impact:** A single transient interstitial on page 1 terminates the whole 5-page collection; partial/total silent under-collection indistinguishable from a low-volume role.
- **Fix:** Distinguish page-1 zero (block/error → throw) from later-page zero (legitimate end); one retry per page on zero-yield; sanity floor on `pageNum===0`.

#### [I3] Glassdoor: search-results page has NO block detection; challenge → 0 jobCards → returns `[]` as success
- **Critical · anti-bot-durability · M**
- **Location:** `scrapers/glassdoor.js:520-573`, `182-337`, `340-375`, `382`
- **Evidence:** The only block check is `extractJobDetailsFromHTML` (`:382`, title includes "Security"/"Just a moment") and it runs **only for detail pages**, never homepage/search. Search path (`goto(homepage)`→`goto(searchUrl)`→`loadAllJobs`→`extractJobsFromHTML`) inspects nothing. On a challenge, `loadAllJobs` burns its full `maxAttempts=50` budget (~3-6 min) on the captcha, then returns 0; `scrapeGlassdoor` returns `[]` with no error.
- **Impact:** Glassdoor (heavy Cloudflare Turnstile; anonymous, no credentials — see I7) challenge ⇒ silent zero, wasting minutes, no signal, no cooldown lever.
- **Fix:** After both `goto`s and before `loadAllJobs`, check URL/title/body for `Just a moment`/`Security | Glassdoor`/Turnstile/DataDome and the navigation `resp.status()`; throw on detection. If `extractJobsFromHTML` returns `[]`, throw rather than return.

#### [I13] Indeed: `loginSuccess` set to `true` before any navigation — disables the entire cooldown taxonomy
- **High · reliability · S**
- **Location:** `scrapers/indeed.js:601,608,700-718`
- **Evidence:** `let loginSuccess=false` then `loginSuccess=true` *before* the first `page.goto`. The catch (`:708-718`) branches on `if (!loginSuccess)` for auth=0/rate-limit=60/other=30; with `loginSuccess` always true, only the generic 30-min `else` is reachable.
- **Impact:** Cookie-auth failures and Cloudflare/rate-limit blocks both get the generic cooldown; expired cookie not fast-rechecked; rate-limited IP/cookie not backed off 60 min. Mechanism that makes I1/I8 unrecoverable.
- **Fix:** Initialize `loginSuccess=false`; set `true` only after a navigation confirmed past Cloudflare AND logged-in AND card-bearing (after I1 block check + I8 login check).

#### [I14] Glassdoor: `loadAllJobs` zero-progress / challenge state burns ~3-6 min before giving up; no early abort
- **Medium · reliability · S**
- **Location:** `scrapers/glassdoor.js:183-337`
- **Evidence:** Loop guard `clickAttempts < 50 && sameCountStreak < 3`; on a challenge/empty page `currentJobCount` stays 0 and each iteration sleeps multiple `humanDelay`s (~5-8s). No "0 jobs after first attempt ⇒ block, abort now" short-circuit.
- **Impact:** Minutes wasted per role on block/zero-result before silent "success" (I3); at scale a large throughput sink that disguises blocks as slow runs.
- **Fix:** Early-exit: if `currentJobCount===0` after the first `closePopups`+scroll attempt → throw (ties to I3). Cap total wall-clock for `loadAllJobs`.

#### [O1] A 100%-blocked scraper is indistinguishable from "no jobs found" — no zero-jobs or block-rate signal exists
- **Critical · anti-bot-durability / observability · M**
- **Location:** `src/metrics/registry.js:116-121,223-226`; `src/core/base-scraper.js:43-49`; `src/queue/orchestrator.js:233-254`; `scrapers/monster.js:142-155`
- **Evidence:** Only job metric is `scraper_jobs_scraped_total` (monotonic Counter). `recordJobsScraped()` is `if (!count || count<0) return;` — a 0-job scrape writes nothing. Any `[]` return → `recordSession(platform,'success')`. No `scraper_jobs_last_scraped` gauge, no `scraper_zero_result_sessions_total`, no `result="empty"` label.
- **Impact:** A 100%-blocked night is byte-identical to "no jobs matched": `scraper_up=1`, heartbeat advancing, `sessions_total{result="success"}` climbing, `failures_total` flat, Loki benign `"Scrape complete {jobCount:0}"`. Discovery only days later, out-of-band.
- **Fix:** Add per-platform Gauge `scraper_jobs_last_scraped{platform}` set every session incl. 0; `scraper_zero_result_sessions_total{platform}`; `result="empty"` on `recordSession`; Grafana alert `rate(zero_result[1h]) / rate(sessions[1h]) > 0.8` per platform; drop the `if(!count) return` guard.

#### [O2] `classify.js` only runs on thrown errors — silent blocks never classified as captcha/auth/rate-limit
- **Critical · anti-bot-durability / observability · M**
- **Location:** `src/metrics/classify.js:35-54`; `src/core/base-scraper.js:50-60`; `scrapers/{monster,glassdoor,dice}.js`
- **Evidence:** `classifyError()` invoked only in the `catch` of `base-scraper.js:52`. Monster/Dice/Glassdoor never throw a typed error on a block (grep for `throw new (Auth|Scraper|Parse|Network)Error` in those three returns nothing) — they return arrays. The `captcha`/`datadome`/`cloudflare` regex (`classify.js:26`) is never reached.
- **Impact:** `scraper_failures_total{reason="captcha"|"auth_required"}` reads zero *during* an active blocking event. Any anti-bot alert built on it is permanently silent for Monster/Dice/Glassdoor. classify.js is dead code on the most important failure mode.
- **Fix:** Detect blocks at the scraper boundary and throw a typed block error (HTTP 403/429, OR 0 results AND challenge markers). Then the captcha/rate-limit alert becomes meaningful.

#### [O3] Heartbeat proves process liveness only — false confidence; `daemon`-mode alert keys off it
- **High · observability / anti-bot-durability · S (metric) / M (alert + docs)**
- **Location:** `src/metrics/heartbeat.js:22-31`; `src/metrics/registry.js:72-83,271-276`; `README.md:385,412-414`
- **Evidence:** `Heartbeat.start()` calls `markHeartbeat()` on a 10s timer independent of any scrape; `scraper_up` hard-set `1` at construction and re-set `1` every tick, never `0`. README states the only shipped alert (`daemon` offline >5min) keys on liveness.
- **Impact:** The one advertised alert fires only on process death / total network loss. A fully-functional process with every scrape blocked stays green forever.
- **Fix:** Add `scraper_last_nonzero_scrape_timestamp_seconds{platform}`; alert when stale > N hours despite `scraper_up=1`. Document that heartbeat ≠ scrape health.

#### [O4] No alert rules, dashboards, or recording rules anywhere in the repository
- **High · observability · M**
- **Location:** entire repo (negative finding); `README.md:362-414`
- **Evidence:** Repo-wide search for `expr:`/`alerting`/`alertmanager`/`*.rules.yml`/dashboard JSON returns only README prose. Alerting is entirely off-repo and undocumented in concrete form. `classify.js:7-8` itself warns reasons must match Grafana rules — which are not in-repo to verify.
- **Impact:** Metric↔alert contract is unreviewable and drifts uncontrolled; a renamed label silently breaks alerting with no CI catch; no version-controlled definition of "what does blocked look like and what fires."
- **Fix:** Commit Prometheus alerting rules + Grafana dashboard JSON to the repo (e.g. `observability/alerts.yml`, `observability/dashboard.json`) so the O1/O2 zero-jobs/block alerts are codified and tested.

#### [O5] `daemon` vs `interactive` mode means residential hosts get NO offline alert by default
- **High · observability / anti-bot-durability · S**
- **Location:** `.env.example:29-31`; `src/metrics/registry.js:30-32,55`; `README.md:412-414`; `docs/MAC_SETUP.md:208-296`; `docs/WINDOWS_SETUP.md:197-232`
- **Evidence:** `defaultMode()` returns `'interactive'` unless `SCRAPER_MODE=daemon`. The Mac/Windows runbooks configure the LinkedIn/Glassdoor/Indeed residential hosts as always-on launchd/NSSM services but neither sets `SCRAPER_MODE=daemon` in the plist/NSSM env block.
- **Impact:** The hosts running the most block-prone platforms default to `interactive` → even the offline alert is suppressed exactly where it's needed most; setup docs don't fix it.
- **Fix:** Set `SCRAPER_MODE=daemon` in launchd `EnvironmentVariables` (`MAC_SETUP.md:233`) and NSSM `AppEnvironmentExtra` (`WINDOWS_SETUP.md:211`); default service-wrapped runs to daemon or warn at startup if unattended without it.

#### [O9] `recordJobsSubmitted(platform,'success',0)` records a "success" submission for a fully-blocked platform
- **Medium · observability · M**
- **Location:** `src/queue/orchestrator.js:236-254`; `src/metrics/registry.js:228-231`
- **Evidence:** Block-as-empty → `submitJobs(sessionId, platform, [], 'success')` and `recordJobsSubmitted(platform,'success',0)`; `recordJobsSubmitted` early-returns on `!count`, but the session/submission are still tagged success and the backend receives `status:'success', jobs:[]`.
- **Impact:** The backend's own session summary shows 0 for a blocked platform under "successful_platforms" — blindness is consistent across client metrics, client logs, and the backend record.
- **Fix:** On 0 jobs, submit a distinguishable status (`'empty'` / `zero_results:true`) and `recordJobsSubmitted(platform,'empty',1)` so a series exists.

#### [O10] `scraper_up` is a constant `1` — a deceptive gauge that looks like a real health signal
- **Medium · observability · S**
- **Location:** `src/metrics/registry.js:72-77,274`
- **Evidence:** Set `1` at construction and re-set `1` every 10s in `markHeartbeat()`; help string admits "Always 1 while pushing." Never `0`.
- **Impact:** An "is the scraper up?" alert built on the conventionally-named `scraper_up` can never fire; anyone trusting `scraper_up==1` believes health when 100% blocked.
- **Fix:** Remove `scraper_up` (rely on Pushgateway staleness / `scraper_last_heartbeat_timestamp_seconds`) or redefine to reflect actual scrape health; fix the help text.

### Phase 2 — Structural anti-bot hardening

#### [F1] Entire shared stealth foundation is dead code; scrapers diverge with copy-pasted logic
- **Critical · anti-bot-durability · L**
- **Location:** `src/core/browser.js:1-79`, `src/core/cookies.js:61-78`, `src/core/fingerprints.js:4-26`; contradicted by `README.md:260-261`
- **Evidence:** Repo-wide grep for `core/browser`/`core/cookies`/`core/fingerprints` returns zero importers outside `src/core/`. Every scraper does `import { launch } from 'cloakbrowser'` and defines its own `loadCookies`/`humanDelay`. README advertises these files as the live shared layer. Logic has already drifted (Dice sets a UA override; others don't; delay ranges differ per file).
- **Impact:** No single place to harden stealth — every fix must be made 5+ times and will drift. The audit's premise ("weaknesses here are systemic") is inverted: the shared layer protects nothing. Whoever "correctly" wires up `browser.js` injects the F2 bot-fingerprint args fleet-wide at once.
- **Fix:** Make `src/core` the single real path: one hardened `launchStealth()`/`newStealthContext()`/`loadCookies()` used by every scraper; lint-rule banning direct `cloakbrowser` import in `scrapers/`. (Alternative: delete the dead files and fix the README — but centralizing is the strategic choice and is prerequisite for F2/F5/F6/F7.)

#### [F2] `DEFAULT_LAUNCH_ARGS` are a headless-bot fingerprint and fight the stealth plugin
- **High · anti-bot-durability · M**
- **Location:** `src/core/browser.js:24-41`
- **Evidence:** `DEFAULT_LAUNCH_ARGS` includes `--disable-gpu`, `--disable-accelerated-2d-canvas`, `--no-zygote`, `--no-first-run`, `--disable-blink-features=AutomationControlled`, always merged into playwright-extra+stealth.
- **Impact:** `--disable-gpu`/`--disable-accelerated-2d-canvas` force SwiftShader → `WEBGL_debug_renderer_info` becomes "Google SwiftShader"/"llvmpipe" (strong headless signal the stealth plugin may not fully mask); `--disable-blink-features=AutomationControlled` is redundant with stealth and itself detectable. Dead today (F1) but a primed footgun on adoption.
- **Fix:** Remove `--disable-gpu`/`--disable-accelerated-2d-canvas`/`--no-zygote`; let GPU run (or `--use-angle=swiftshader` only if headless-GPU unavailable, with a consistent WebGL vendor spoof); drop `--disable-blink-features=AutomationControlled`; keep only `--no-sandbox`/`--disable-dev-shm-usage` for containers.

#### [F5] No real fingerprint rotation — one identical hardcoded fingerprint across all platforms and sessions
- **High · anti-bot-durability · L**
- **Location:** `src/core/fingerprints.js:24-26` (unused `randomFingerprint`); live contexts `scrapers/monster.js:88-91`, `scrapers/indeed.js:579-582`, `scrapers/glassdoor.js:501-504`, `scrapers/linkedin.js:90-93`, `scrapers/dice.js:86-88`
- **Evidence:** `randomFingerprint()` has zero callers. Every live `newContext` hardcodes viewport `1366x900` (Dice `1920x1080`), `locale:'en-US'`, `timezoneId:'America/New_York'`; no UA override on Monster/Indeed/Glassdoor/LinkedIn. FINGERPRINTS UAs are pinned to Chrome 119/120 (stale vs runtime Chromium → UA-vs-`Sec-CH-UA` mismatch).
- **Impact:** Every scrape from a box presents a byte-identical fingerprint; DataDome/Cloudflare cluster on (UA, viewport, tz, locale, JA3, IP) — trivially correlatable, burns the residential IP faster.
- **Fix:** Per-session/per-credential fingerprint factory (UA matched to actual installed Chromium major + consistent `Sec-CH-UA`/platform/locale/timezone/screen/viewport from a coherent profile pool), called from the shared context helper, persisted alongside cookies.

#### [F6] No proxy / residential-IP support hook anywhere despite it being the documented linchpin
- **High · anti-bot-durability · M**
- **Location:** entire scope — no `proxy`/`--proxy-server` in `scrapers/`, `src/core/`, `scripts/cloak*`; `README.md:14,458-461`
- **Evidence:** No `proxy:` on any `launch(...)`/`newContext(...)`; `launchBrowser`/`newDefaultContext` accept no proxy param. README states cleared sessions are "bound to the IP that solved the captcha".
- **Impact:** Cookie/session validity is IP-bound; no proxy plumbing means sessions cannot be rotated, a burned residential IP has no in-code mitigation, and the scraping IP cannot be aligned with the cookie's origin IP — a direct block cause.
- **Fix:** Optional per-credential `proxy` (server/username/password) threaded through the shared launcher; assert IP/geo consistency with the cookie origin before use. Re-enable Monster behind this.

#### [F7] No cookie validation, expiry detection, or session-refresh; per-platform isolation is incidental
- **High · anti-bot-durability · M**
- **Location:** `src/core/cookies.js:61-78` (dead) and live `loadCookies` in `scrapers/{glassdoor,indeed,linkedin}.js`
- **Evidence:** Cookie loaders map shapes and floor expiry but never check past-expiry, presence of required auth cookies (LinkedIn `li_at`, Glassdoor session), or post-load validity; nothing reads cookies back to confirm session; no refresh/re-auth trigger. Isolation exists only incidentally (ephemeral per-run contexts).
- **Impact:** Expired/stale cookies used as valid → auth wall → 0 jobs → silent success (F3/L1/I1). Auth-expiry invisible; credential silently rots for days.
- **Fix:** In the shared loader, drop already-expired cookies; hard-fail `AuthError` if a required auth cookie is missing/expired; after first navigation verify a logged-in DOM/endpoint and throw `AuthError` (→ rotation) on failure.

#### [F9] Navigation uses `domcontentloaded` on DataDome-fronted pages, racing the challenge
- **Medium · anti-bot-durability · M**
- **Location:** `scrapers/monster.js:27-31,115-118`; `scripts/cloak-probe.mjs:66`; `scripts/cloak-monster-warmup.mjs:23,26`
- **Evidence:** Monster navigates `waitUntil:'domcontentloaded'` + fixed `sleep(4000+rand2000)`. Indeed's comment (`indeed.js:620-622`) explains `domcontentloaded` fires while still on the challenge page and therefore uses `waitUntil:'load'` — not propagated to Monster/probe scripts (direct symptom of F1).
- **Impact:** On DataDome's JS interstitial, `domcontentloaded` resolves on the challenge document; a fixed ~5s sleep may not outlast it → intermittent parsing of the DataDome page (0 cards → silent success).
- **Fix:** Shared `gotoStealth(page,url)` using `waitUntil:'load'` (or `networkidle` where safe) + explicit post-nav `assertNotBlocked` poll-with-timeout; apply to Monster and probe scripts.

#### [F10] Delay primitives split brain: shared `delays.js` is dead, scrapers reimplement; some action delays tiny/fixed
- **Medium · anti-bot-durability · M**
- **Location:** `src/core/delays.js:1-25` (dead); reimplemented `humanDelay` in `scrapers/{glassdoor,indeed,linkedin}.js`; e.g. `indeed.js:149` `humanDelay(500,1000)`, `linkedin.js:233` `randomDelay(200,400)`, `monster.js` fixed `sleep(4000+rand2000)`
- **Evidence:** `delays.js` (`humanDelay`/`randomDelay`/`backoffDelay`/`sleepBackoff`) has zero importers; each scraper redefines its own with different defaults; several waits are 200-1000ms uniform-random. The well-designed full-jitter `backoffDelay` is unused on the live path.
- **Impact:** Inconsistent, partly sub-human pacing raises behavioral-scoring risk; jittered backoff not applied to retries; fleet untunable from one place.
- **Fix:** All scrapers import from `delays.js`; use `sleepBackoff` for retries; widen tiny action delays; consider a non-uniform (log-normal) inter-action distribution.

#### [I6] Indeed: hardcoded context locale/timezone (`en-US`/New_York) contradicts the fingerprint config and the IP region
- **High · anti-bot-durability · S**
- **Location:** `scrapers/indeed.js:579-583`, `:44-58`, `:66-68`
- **Evidence:** `CONFIG.fingerprints` defines an India profile (`en-IN`/`Asia/Kolkata`) and `getRandomFingerprint()` exists but is never called; `newContext` hardcodes `locale:'en-US', timezoneId:'America/New_York'`. Header `:22-25` notes the residential box's IP causes Indian-IP regional behavior and `getIndeedDomain` can route to `in.indeed.com`.
- **Impact:** A run can be IP=India, domain `in.indeed.com`, browser advertising `en-US`/`America/New_York` + Windows/Chrome UA — a coherent-fingerprint mismatch (tz vs IP geo vs domain) DataDome/Cloudflare specifically score → raises challenge frequency → triggers I1 silent failure.
- **Fix:** Derive `locale`/`timezoneId` from the resolved Indeed domain (or actually use `getRandomFingerprint()` consistently with the chosen domain).

#### [I7] Glassdoor: fully anonymous, no cookies, no credential lease — single hard dependency on CloakBrowser defeating Turnstile, no fallback or detection
- **High · anti-bot-durability · M (detection) / L (credential fallback)**
- **Location:** `scrapers/glassdoor.js:484-506`, `:575-583`
- **Evidence:** `void sessionId` (`:490`); header states sole reliance on the stealth binary to pass Cloudflare Turnstile/FingerprintJS, no cookies, no rotation, no detection (I3). `humanize:false` (`:495`).
- **Impact:** The entire Glassdoor pipeline is one CloakBrowser/Cloudflare-ruleset update from 100% block — and per I3 that block is silent. No cookie/credential lever, no cooldown, no rotation, no alarm.
- **Fix:** (1) Implement I3 block detection (loud failure). (2) Re-introduce an optional `cf_clearance`/session-cookie credential path (fix I4 and wire it) as a fallback. (3) Reconsider `humanize:true` for scroll/modal interactions.

#### [I8] Both: zero cookie-staleness / logged-out detection; Indeed re-leases dead cookies as healthy
- **High · anti-bot-durability / reliability · M**
- **Location:** `scrapers/indeed.js:567-598`, `:696`; `scrapers/glassdoor.js` (no cookies)
- **Evidence:** Indeed injects cookies, logs `cookiesAdded/total`, but never verifies logged-in state — no sign-in-page check, no "logged in as" probe, no `expires < Date.now()` pre-check. With `loginSuccess` forced true (I13), `reportFailure(...,0)` is never reached, so an expired/invalidated Indeed cookie is reported as a good credential and re-handed out indefinitely.
- **Impact:** Stale/logged-out credentials never detected, cooled down, or refreshed; the credential-health system is inert for the most common real degradation (cookie expiry).
- **Fix:** After first search navigation detect logged-out state (sign-in CTA / absent account chrome / redirect to `/account/login`) → throw auth error (engages `reportFailure(...,0)`). Optionally pre-filter `expires < now`. Only set `loginSuccess=true` after a confirmed logged-in, card-bearing page.

#### [I12] Both: request-volume / pacing pattern likely trips DataDome; parallel 5-tab detail bursts from one IP
- **Medium · anti-bot-durability · M**
- **Location:** `scrapers/indeed.js:503-533,671-674`; `scrapers/glassdoor.js:455-481,554-555`
- **Evidence:** `CONCURRENT_TABS=5` — 5 simultaneous detail navigations from the same context/IP, each looping with only `humanDelay(1000-2000)` (Indeed) / `1500-2500` (Glassdoor). For 50 Indeed jobs that's 50 detail navigations in 5 parallel streams within seconds + 5 search loads, one IP. No global rate limiter / jitter envelope / backoff-on-soft-block.
- **Impact:** Sustained runs raise block probability mid-session; once blocked, I1/I3 make it silent.
- **Fix:** Reduce detail concurrency (2-3), larger randomized gaps + occasional longer "reading" pauses, soft-block detection inside detail workers that aborts the batch + triggers cooldown, shared token-bucket limiter.

#### [L6] LinkedIn: no cookie-expiry pre-check and no logged-out-mid-scrape detection
- **Medium · anti-bot-durability / reliability · M**
- **Location:** `scrapers/linkedin.js:59-112`, `168-188`, `603-1026`
- **Evidence:** Cookies injected as-is; no `li_at` expiry/near-expiry check before launch; `ensureLoggedIn()` checks login once via a single `/feed/` URL substring test; the multi-query scroll loop never re-verifies auth. The email/password fallback in `performLogin()` is unreachable from inside `extractPosts`.
- **Impact:** Stale-cookie or mid-scrape logout → 0 posts reported success; the password fallback (the point of carrying it) never exercised once extraction begins; multi-query runs especially exposed (logout after query 1 silently zeros 2-3).
- **Fix:** Parse `li_at` expiry before launch (warn/skip-credential if expired); re-assert auth at the start of each query iteration and periodically in the scroll loop; on detected logout attempt the password fallback or fail-with-cooldown.

#### [L7] LinkedIn: request-volume and pacing patterns are detectable (150 scrolls/query × 3 queries, teleport scroll, static fingerprint)
- **Medium · anti-bot-durability · M**
- **Location:** `scrapers/linkedin.js:601,1016-1025,1186-1222,88-94,143`
- **Evidence:** Up to 150 scrolls/query with a 2-3s delay; scrolling is an instant jump to `scrollHeight` (not incremental); with 3 AI queries worst case ≈ 450 deep-paginated content searches per role, mitigated only by an 8-12s inter-query delay and early-stop after 5 empty scrolls. Fingerprint fully static (headless, fixed viewport/locale/tz) across all runs/credentials.
- **Impact:** Deep/fast/teleport pagination repeated for 3 queries is a strong automation signal and realistic rate-limit/soft-block trigger; static shared fingerprint enables cross-account correlation. Resulting block invisible (L1/L2).
- **Fix:** Lower `maxScrolls` (≈20-30 for past-week content search), incremental human-like scroll with variable dwell + jitter, randomize/derive viewport+timezone per credential, hard cap total scrolls across queries per session.

#### [T6] TechFetch: Puppeteer stealth plugin applied to a Playwright browser — weakened/partial fingerprint masking
- **Medium · anti-bot-durability · M**
- **Location:** `scrapers/techfetch.js:2-3,13,68-82`
- **Evidence:** `puppeteer-extra-plugin-stealth` (a Puppeteer plugin) registered on `playwright-extra`'s chromium — several CDP-specific evasions silently no-op under Playwright. Compounded by a hardcoded stale `Chrome/120.0.0.0` UA on `headless:true` with no UA-CH consistency. TechFetch is the lone Playwright+puppeteer-stealth outlier vs the CloakBrowser fleet.
- **Impact:** Materially less resistant than the CloakBrowser used elsewhere if TechFetch deploys DataDome/Cloudflare-grade detection; stale UA increases block probability. Detection surfaces as T1/T3 silent empties.
- **Fix:** Migrate TechFetch to `cloakbrowser` for fleet consistency, or at minimum stop hardcoding a stale Chrome major (track current, or omit so UA/UA-CH stays self-consistent) and verify which evasions actually apply under playwright-extra.

#### [T11] Dice: zero human-like pacing + `maxConcurrency:10` across 5 contexts against a datacenter IP
- **Medium · anti-bot-durability · S**
- **Location:** `scrapers/dice.js:74,120-135,138-141,150-151`
- **Evidence:** `launch({headless:true})` with humanization off, 10 concurrent job-page renders round-robined over 5 contexts, flat 2s post-nav wait, no inter-request jitter/backoff. Up to ~100 detail + 5 search + N recruiter pages in a tight burst from one datacenter IP.
- **Impact:** Elevated block/rate-limit risk under any future Dice tightening; the "no detection" assumption is load-bearing and unverified; failure is silent (T9).
- **Fix:** Modest randomized inter-request delays/jitter, lower default concurrency (configurable); at minimum add T9 challenge detection so the burst assumption fails loudly if wrong.

#### [I15] Both Indeed/Glassdoor: `getRandomFingerprint` / `fingerprints` defined but never used — misleading dead anti-bot code
- **Low · code-quality · S**
- **Location:** `scrapers/indeed.js:44-58,66-68`; `scrapers/glassdoor.js:21-34,43-141`
- **Evidence:** Both define a `fingerprints` array and `getRandomFingerprint()`; neither is ever called. Glassdoor additionally carries dead `parseExpiry`/`loadCookies`.
- **Impact:** Strongly implies fingerprint rotation is in effect when it is not — misleads anti-bot reasoning and hides I6.
- **Fix:** Wire `getRandomFingerprint()` into `newContext` (aligned with domain per I6) as part of F5, or delete the unused config/functions so the code honestly reflects a single static fingerprint.

#### [T17] TechFetch/Dice: hardcoded identical Chrome/120 UA strings duplicated across files — stale and fingerprint-correlated
- **Low · anti-bot-durability · S**
- **Location:** `scrapers/techfetch.js:80`; `scrapers/dice.js:28,87,122` (Monster relies on CloakBrowser default — good)
- **Evidence:** The exact same `...Chrome/120.0.0.0 Safari/537.36` literal hardcoded in 4 places; stale by 2026-05; inconsistent with the headless engine's UA-CH (`navigator.userAgentData`).
- **Impact:** Minor standalone; compounds T6/T9/T11 — raises block likelihood on UA/UA-CH consistency checks; duplicated literal is a maintenance hazard.
- **Fix:** Centralize a single UA (or don't override; let the engine present a self-consistent current UA + UA-CH) as part of F5.

### Phase 3 — Credential & pipeline reliability

#### [C2] Credential lease leaks on the scraper success path and on crash / SIGTERM / transport failure
- **High · reliability · M**
- **Location:** `src/api/credentials.js:182-186,233-238`; `src/queue/orchestrator.js:72-80,233-237,290-303`; `server.js:114-166`
- **Evidence:** `reportSuccess` swallows transport errors: `catch{ log.error } finally { #forgetLease }` — the local entry is dropped even if the API POST failed, so `releaseAll()` can no longer see it. `#runAssignment` runs fire-and-forget and untracked; a hard crash/OOM/`process.exit(0)` on SIGTERM abandons in-flight leases. `releaseAll()` loops `await this.release(key)` serially (each a full retrying call up to 4×/30s) under a 2s shutdown step timeout.
- **Impact:** Remote credentials remain leased after crashes/SIGTERM/transient release failures → backend leasable count drops → pre-flight reports 0 → orchestrator stops claiming that platform: self-inflicted starvation that contradicts the very purpose of the pre-flight. Recovery depends on an unverified backend lease-TTL.
- **Fix:** Only `#forgetLease` on confirmed success; keep the lease on transport failure so `releaseAll()` can retry. Make `releaseAll()` parallel with a short per-call timeout. Track in-flight assignments and have `shutdown()` drain them (bounded) before `releaseAll()`. Confirm + document a backend lease TTL backstop.

#### [C4] HTTP client retries 429 blindly with up to ~31s sleeps; block signals amplified, not surfaced
- **High · anti-bot-durability · M**
- **Location:** `src/http/client.js:97-99,120-155`; `src/api/credentials.js:78-92`; `src/api/blacklight.js:106-112`
- **Evidence:** `shouldRetryStatus` returns true for 429; with `DEFAULT_RETRIES=4` and `sleepBackoff(...,{maxMs:30000})`, a rate-limited internal endpoint is retried 4× with sleeps up to 30s each. No `Retry-After` honoring. `checkCredentialAvailability` uses `requestWithRetry` directly → a 429 there is retried 4× before the pre-flight fails open, delaying every claim cycle by up to ~2 min.
- **Impact:** Credentials/Blacklight rate-limiting stalls the whole claim loop for tens of seconds to ~2 min before failing; missing `Retry-After` means backoff can be shorter than demanded, prolonging the limited state.
- **Fix:** Honor `Retry-After` (seconds or HTTP-date) and cap total retry wall-time; pass `{retries:1}` for `checkCredentialAvailability` so a rate-limited backend fails open fast; surface 429/503 distinctly (`RateLimitError`).

#### [C5] `unhandledRejection` is logged but the process is not terminated; no `uncaughtException` handler
- **Medium · reliability · S**
- **Location:** `server.js:170-172`
- **Evidence:** `process.on('unhandledRejection', (r)=>{ log.error })` only logs; no `uncaughtException` handler at all.
- **Impact:** Silent degradation — service stays "up" (static health, C7) while a subsystem is broken; no supervisor restart; leased creds may leak (C2).
- **Fix:** Add `uncaughtException` → log + exit non-zero (supervisor restarts). In `daemon` mode escalate `unhandledRejection` to exit after logging (or at least an alertable metric).

#### [C6] `submitJobs` has no idempotency key; a retried/duplicated POST can double-submit jobs
- **Medium · correctness · M**
- **Location:** `src/api/blacklight.js:115-126`; `src/http/client.js:120-155`
- **Evidence:** `submitJobs` POSTs `{session_id, platform, jobs}` via `requestWithRetry` which retries 5xx/408/429. A POST the backend processed but whose response was lost is retried, re-submitting the same jobs. Same for `completeSession` and credential `success`/`failure`/`release`.
- **Impact:** Duplicate job rows / inflated counts on flaky networks; possible double cooldowns. Medium only if the backend de-dupes by session+platform (unverifiable here) — otherwise High.
- **Fix:** Send `Idempotency-Key: <sessionId>:<platform>:<nonce>` (or content hash) and have the backend treat retries as no-ops; or do not retry non-idempotent POSTs on 5xx unless an idempotency key is set.

#### [C7] Health endpoint is static — never reflects orchestrator/credential/loop health
- **Medium · observability · M**
- **Location:** `src/routes/health.js:5-53`; `server.js:96`
- **Evidence:** `GET /` always returns 200 with a hardcoded status + usage docs; no check of auto-checker liveness, last claim-cycle result, circuit-breaker state, or credentials reachability; no `/healthz`/`/readyz`.
- **Impact:** LB/supervisor/uptime monitor sees green even when the queue loop stalled, every platform is blocked (C1), or credentials are unreachable. With C5, a deeply degraded process looks perfectly healthy.
- **Fix:** Add a real liveness/readiness route: time since last successful claim cycle, last `completeSession` status, open circuit breakers, credentials-client mode/last-error; non-2xx when the last N cycles failed or the loop hasn't ticked within ~2×`checkIntervalMs`.

#### [C8] Mutex protects only the claim; auto-checker has no awaited drain on shutdown; assignments untracked
- **Medium · reliability · M**
- **Location:** `src/queue/mutex.js:12-30`; `src/queue/orchestrator.js:51-82,84-100`; `server.js:146-166`
- **Evidence:** The `Mutex` is a plain boolean — correct and balanced for its single-acquirer use (claim wrapped in try/finally) — but by design it covers only `#claim`; `#runAssignment` runs unguarded and untracked. `stopAutoChecker()` only `clearInterval`s; `shutdown()` calls it then `releaseAll()` but never awaits in-flight `#runAssignment`. A SIGTERM mid-scrape abandons the session: the browser is killed, the scraper throws "Target closed", but because the assignment promise is fire-and-forget the `#safeSubmit('failed')`/`completeSession` may not run before `process.exit(0)`.
- **Impact:** Every deploy/restart during active scraping abandons one or more sessions and leaks their leases (C2), depending on a backend session-timeout to recover. No clean drain means no graceful deploys.
- **Fix:** Track in-flight `#runAssignment` promises in a Set; on shutdown stop the checker, then `Promise.race([Promise.allSettled(inFlight), drainTimeout])` before `releaseAll()` and `server.close()`. Add a "scraping in progress" gate so a SIGTERM can short-circuit new `triggerNextPoll` calls immediately.

#### [C11] `requestJson` is dead/inconsistent; `releaseAll()` releases serially under a tight shutdown budget
- **Low · code-quality · S**
- **Location:** `src/http/client.js:160-170`; `src/api/credentials.js:233-238`
- **Evidence:** `requestJson` is exported but unused; Blacklight and credentials clients both call `requestWithRetry` and parse manually with subtly different status rules (202/204 handling diverges). `releaseAll()` loops `await this.release(key)` serially; under `server.js`'s 2s step timeout, >1 slow release exceeds the budget (ties to C2).
- **Impact:** Two divergent JSON-handling paths invite future bugs; `releaseAll` cannot realistically release more than one stuck lease within the shutdown window.
- **Fix:** Delete `requestJson` or refactor both clients onto it with explicit status policy; make `releaseAll()` parallel with a short per-release timeout.

### Phase 4 — DOM resilience & data quality

#### [L3] LinkedIn: NEW/LEGACY DOM fallback is shallow; extracted-but-empty not detected; brittle `innerText` string-splitting
- **High · anti-bot-durability · L**
- **Location:** `scrapers/linkedin.js:659-948` (esp. 667-683, 833-905)
- **Evidence:** Fallback only covers the *container* selector (NEW `…FLAGSHIP_SEARCH` → `…expanded` → LEGACY). `useLegacyDOM` decided purely by `postElements.length===0`. No fallback if containers ARE found but field extraction yields nothing. `postId`/`authorName`/`postContent`/`timestamp` derived from `componentkey` regexes and English `" • Follow "` / `"•"` splitting; post pushed only if `authorName && postContent && postContent.length>20`.
- **Impact:** Survives only the one class-hashing change already observed. Renaming `componentkey`, changing the `FLAGSHIP_SEARCH` suffix, localizing "Follow", or altering the bullet → total extraction failure reported as success (L1).
- **Fix:** Detect "containers found, 0 extracted" as a hard DOM-regression signal → loud failure + snapshot, never success. Prefer structural selectors (the diag script `linkedin-selector-diag.mjs:164-196` already enumerates `a[href*="/in/"]`, `<time>`, `img[alt]`, aria-labels) as a prioritized per-field cascade; locale-tolerant author/time parsing.

#### [L4] LinkedIn: hardcoded English/locale text assumptions throughout extraction and block detection
- **High · correctness / anti-bot-durability · M**
- **Location:** `scrapers/linkedin.js:877,860,863,893-894,303-306,454,505,610-617,1056-1063`
- **Evidence:** Body extraction hinges on literal "Follow" and `Like|Comment|Repost|Send`; author fallback parses English aria-label `"Open control menu for post by"`; login-failure detection matches English strings; "see more" targets `aria-label*="see more"`. Locale pinned `en-US` mitigates the logged-in UI but account/security/checkpoint pages render in the account's configured language.
- **Impact:** Any credential whose LinkedIn account language is not English produces 0 extracted posts → silent success; non-English checkpoints missed.
- **Fix:** Centralize locale-sensitive strings into a configurable dictionary keyed by language; derive expected language from the account or force via LinkedIn's `lang` preference; prefer structural attributes over visible text.

#### [L8] LinkedIn: `analyzePosts` keeps non-job content; "job-related" filter advisory only and over-broad
- **Low · correctness · S**
- **Location:** `scrapers/linkedin.js:1050-1076,1232,1266-1334`
- **Evidence:** `analyzePosts()` returns `{all, jobRelated}` but the caller normalizes `analyzed.all`, not `analyzed.jobRelated`; `jobRelated` only logged. `isJobRelated` field is never set on the post object (always `undefined`).
- **Impact:** Recruiter spam / unrelated posts emitted as jobs; downstream `isJobRelated` filtering is a no-op.
- **Fix:** Emit `analyzed.jobRelated` or attach a real `isJobRelated` boolean before normalization; tighten the keyword heuristic to require hiring intent.

#### [L9] LinkedIn: `postUrl` essentially always empty in NEW DOM; dedup keyed on a fragile hash with random fallback
- **Low · correctness / reliability · S**
- **Location:** `scrapers/linkedin.js:907-915,834-837,722,1306-1309,970-983`
- **Evidence:** Permalinks absent in NEW search results (code's own comment); `postUrl` usually `''`; `jobId` falls back to `hashString(title+company+location)`; LEGACY unresolved id becomes `'post_'+Math.random()`; cross-query dedup keys solely on `p.id`.
- **Impact:** Random-id posts duplicate across queries; content-hash collisions; mostly-empty URLs reduce record usefulness and downstream idempotency.
- **Fix:** Derive a deterministic id from `authorProfileUrl + normalized(content)` when `componentkey` id is unavailable; metric for "% posts with no stable id/URL".

#### [T2] TechFetch: session logout/expiry mid-pagination swallowed as "end of results"
- **High · reliability · M**
- **Location:** `scrapers/techfetch.js:269-284,662-666,734-737`
- **Evidence:** Pages ≥2 call `window.LoadJobs(...)` then `waitForFunction` for the first-job href to change, wrapped in a `try` whose `catch` only logs "content didn't swap within 12s — likely end of results" and returns unchanged content; `seenLinks` then drops all as duplicates → `break`. A `typeof window.LoadJobs==='function'` guard means a renamed global silently no-ops → same "end of results".
- **Impact:** Mid-run logout or a renamed `LoadJobs` truncates results (often at page 1) and reports partial/zero data as a complete successful scrape.
- **Fix:** After a failed `waitForFunction`, check `window.LoadJobs` existence + `JSLogin` cookie + URL still `js_job_list.aspx`; throw (transient cooldown) if logout/missing; only treat unchanged content as "end" when a valid logged-in results container is still present.

#### [T3] TechFetch: detail-page fetch failures (incl. block/challenge) silently degrade jobs to all-"N/A"
- **High · anti-bot-durability · M**
- **Location:** `scrapers/techfetch.js:287-552` (catch 504-551), `304-321`
- **Evidence:** `extractJobDetails` does `goto` then `response.text()` with no `response.status()` / challenge / redirect check; the network-error retry branch excludes HTTP-status and selector failures; returns an all-`N/A` object; `scrapeJobs` `mergeDetails` falls back to list-page values (description `''`); the job still counts and `reportSuccess` fires.
- **Impact:** TechFetch challenging detail pages or changing detail DOM → scrapes "succeed" with the configured count but every record is hollow; silent data-quality collapse with green metrics.
- **Fix:** Inspect `response.status()` and detect challenge/redirect-to-login before parsing; throw on block. Sanity assertion: if `>X%` of detail fetches yield empty description AND `company==='N/A'`, fail the run.

#### [T5] TechFetch: `maxJobs=50` cap interacts incorrectly with full-page detail fetching (wasted work, mid-page truncation)
- **Medium · correctness · S**
- **Location:** `scrapers/techfetch.js:643,668-717,723-727`
- **Evidence:** The cap is enforced *after* the full per-page detail-fetch pool runs on every job from that page, then `allJobs.splice(maxJobs)` trims. No per-page slice to remaining budget; ≈30+ wasted authenticated detail navigations possible.
- **Impact:** Unnecessary authenticated detail navigations per run — extra load on the very platform we're trying not to trip, slower runs, no correctness benefit; the cap is cosmetic for throttling.
- **Fix:** Compute `remaining = maxJobs - allJobs.length` before the detail loop; slice `jobs` to `remaining` before dispatching; stop fetching details beyond the budget.

#### [T7] TechFetch: heavy reliance on fragile `[id*="..."]` substring selectors with no failure signal on drift
- **Medium · anti-bot-durability · M**
- **Location:** `scrapers/techfetch.js:559,582,594-606,319-480` (detail selectors)
- **Evidence:** Discovery and every field depend on ASP.NET id substrings (`_divJob`, `_lblTitle`, `JobDescCKEditor`). The "alternative selectors" block (`:563-578`) only logs counts and never parses — dead diagnostic code.
- **Impact:** A routine TechFetch markup/control-id change breaks extraction with zero error signal (flows to T1/T3 silent success).
- **Fix:** Treat 0 `_divJob` on a validated results page as an error (ties to T1); make the alternative-selector fallback actually parse, or assert a minimum expected job count and fail otherwise; self-test flagging universally-`N/A` fields.

#### [T10] Dice: per-job exceptions (incl. recruiter fetch, page nav) swallowed with `return;`, no partial-failure accounting
- **Medium · reliability · S**
- **Location:** `scrapers/dice.js:154-158,165-181,56-62`
- **Evidence:** Every error inside `requestHandler` is a bare `return`; no counter of skipped/failed vs attempted; `fetchRecruiterProfile` swallows all errors into `name:'N/A'`. With Crawlee `maxRequestRetries:2`, a systemic issue silently drops most jobs while the run "succeeds".
- **Impact:** Partial silent data loss; a 90%-failed run is indistinguishable from a 90%-fewer-results day.
- **Fix:** Track `attempted` vs `succeeded`; throw if the success ratio falls below a threshold (or 0 with non-empty `jobsToProcess`).

#### [T12] Dice: salary/skills/workplace extraction depends on undocumented Dice-internal CSS hooks that drift independently of structured data
- **Medium · anti-bot-durability · M**
- **Location:** `scrapers/dice.js:211-221,248-254,257-261,281,268-272`
- **Evidence:** Core fields use durable Schema.org JSON, but salary period, skills, workplace type, recruiterId, easyApply rely on internal class names (`.SeuiInfoBadge`), exact heading text (`==='Skills'`), `data-testid`, and regexes over the Next.js RSC `__next_f` payload — all changing with routine Dice deploys; failures silent (fields `null`/`false`/`[]`).
- **Impact:** Foreseeable Dice UI/Next.js changes silently null these fields — data-quality erosion masked as success.
- **Fix:** Prefer structured-data sources where available; for RSC-derived fields log when an expected field is universally absent and treat universal absence as a soft-failure signal.

#### [T14] Monster: `extractJobsFromCurrentPage` uses positional `innerText` line-splitting — fragile, silently mis-fields data
- **Medium · correctness · M** *(latent — Monster disabled)*
- **Location:** `scrapers/monster.js:35-74` (esp. 50-61)
- **Evidence:** Each job parsed by splitting card `innerText` on `\n`, assuming line0=title, line1=company, line2=location; `datePosted` = first line matching `/\b(day|hour|week|min)/i` ("Minimum 5 years"/"Weekly pay" misfire); `description` = first 1000 chars of the blob. No JSON-LD used.
- **Impact:** Even past DataDome, frequent title/company/location swaps and bogus dates; brittle to any UI change (currently mitigated only by Monster being disabled).
- **Fix:** Parse Monster's JSON-LD / embedded JSON job objects; if cards must be used, key off stable `data-test*` attributes, not line index.

#### [I5] Glassdoor: hardcoded `https://www.glassdoor.co.in` job-link prefix even for US/`glassdoor.com` searches
- **Medium · correctness · S**
- **Location:** `scrapers/glassdoor.js:365,436` (domain computed correctly at `:512-514` but not threaded)
- **Evidence:** `extractJobsFromHTML:365` and `extractSingleJobDetails:436` hardcode `https://www.glassdoor.co.in${jobLink}`; the computed `domain` is never passed in.
- **Impact:** Every emitted `url` and detail fetch for US searches points at `.co.in` → more redirects/region-gating/bot-wall (cross-region navigation is itself a flagged signal); output URLs wrong for downstream apply flows.
- **Fix:** Thread `domain` into `extractJobsFromHTML(html, domain)` and `extractSingleJobDetails(page, job, domain)` and build URLs from it.

#### [I9] Indeed: detail-fetch failures silently null all enriched fields; description falls back to empty snippet with no signal
- **Medium · reliability / correctness · M**
- **Location:** `scrapers/indeed.js:484-494,362-372,325-326`
- **Evidence:** `extractJobDetails` catch returns `description: job.snippet` (often `''`), `employmentType:'N/A'`, `companyRating:null`, `isRemote:false`, `skills:[]`; a detail page that is itself a challenge is not detected (unlike Glassdoor's title check); failures logged at info; run still reports success.
- **Impact:** Mass-blocked detail pages → a full result set with empty descriptions/defaults, indistinguishable from sparse postings; data-quality erosion invisible.
- **Fix:** Add a challenge/title check for Indeed detail pages; track a detail-failure ratio and `reportFailure`/warn loudly above a threshold; don't substitute an empty string for a description silently.

#### [I10] Both Indeed/Glassdoor: heavy hardcoded selector reliance with site-specific obfuscated class hashes — high DOM-change fragility
- **Medium · anti-bot-durability (DOM resilience) · M**
- **Location:** `scrapers/indeed.js:130-139,225-232,268,313-333,376-442`; `scrapers/glassdoor.js:147-160,212-222,344-356,406-411`
- **Evidence:** Indeed ~50+ hardcoded selectors incl. build-hash classes (`button.css-yi9ndv`, `span.css-1h7lukg`); Glassdoor pins versioned CSS-module hashes (`modal_CloseIcon__0u8CC`, `EmployerProfile_compactEmployerName__9MGcV`, `JobCard_easyApplyTag__5vlo5`) regenerated on essentially every frontend deploy; `loadAllJobs` job-count gate and `jobId` extraction hinge on these.
- **Impact:** A single hashed-class rename → 0 cards → silent "success" (I1/I3). DOM drift effectively guaranteed within months, failure invisible.
- **Fix:** Prefer stable attributes (`data-test`/`data-testid`/`data-jk`/JSON-LD) as primary, hashed classes only as last resort; never gate control flow on hashed classes. (Phase 1's loud zero-yield is the real mitigation that converts this from silent to loud.)

#### [I11] Indeed: pagination assumes 10 jobs/page (`start=N*10`) but ~15 actual — premature stop or duplicate-heavy pages
- **Medium · correctness · M**
- **Location:** `scrapers/indeed.js:43,614-616,650-660`
- **Evidence:** `const start = pageNum*10; // Indeed uses 10 jobs per page` — Indeed's logged-in SERP returns ~15/page and `&start=` is a result offset, not a page index. Stepping by 10 over ~15 overlaps ~5 results/page; `seenJobIds` dedupes the overlap so each "page" adds only ~5-7 new jobs; collecting 50 unique can need all 5 pages and still fall short.
- **Impact:** Under-collection vs the documented 50-job target; wasted re-fetched overlapping offsets (extra request volume → higher DataDome exposure, I12).
- **Fix:** Step `start` by the observed card count of the previous page (or Indeed's actual page size), or paginate by clicking the on-page "Next" control (the pattern recently adopted for TechFetch). Validate against the 50-job target.

#### [I16] Indeed: detail-page `goto` failure mid-batch can leave `lease.reportSuccess` firing despite mass enrichment failure
- **Low · reliability · S**
- **Location:** `scrapers/indeed.js:503-533,676-698`
- **Evidence:** `extractJobDetailsInParallel` swallows every per-job error (defaults at 484-494); normalization + `reportSuccess` (`:696`) run regardless of how many detail fetches failed; no aggregate accounting.
- **Impact:** A run where all 50 detail pages were Cloudflare-walled still reports success with 50 description-less jobs; credential looks healthy after near-total enrichment failure.
- **Fix:** Workers return per-job ok/fail; if the failure ratio exceeds a threshold, `reportFailure` with cooldown instead of `reportSuccess`.

#### [F13] `html.js` entity decoder corrupts non-BMP characters via `String.fromCharCode`
- **Low · correctness · S**
- **Location:** `src/core/html.js:35-36`
- **Evidence:** `NUMERIC_DEC`/`NUMERIC_HEX` use `String.fromCharCode(Number(dec))` / `parseInt(hex,16)`; for code points > 0xFFFF (e.g. emoji `&#128512;`) `fromCharCode` truncates to the low 16 bits.
- **Impact:** Job descriptions/titles with astral-plane characters get mangled before normalization → corrupted data submitted to Blacklight.
- **Fix:** Use `String.fromCodePoint` for numeric entity decoding.

### Phase 5 — Supply chain, docs, hygiene

#### [O7] Supply-chain: `cloakbrowser ^0.3.28` (pre-1.0 caret) + npm/pnpm lockfile mismatch + drifted stealth deps
- **High · supply-chain · M**
- **Location:** `package.json:25-36`; `pnpm-lock.yaml:1-34`; `README.md:70`; `docs/MAC_SETUP.md:63`; `docs/WINDOWS_SETUP.md:51`; `.gitignore:17`
- **Evidence:** `cloakbrowser: ^0.3.28` — a 0.x caret roams the entire `0.3.x` range; `playwright-extra ^4.3.6`, `puppeteer-extra-plugin-stealth ^2.11.2`, `playwright ^1.40.0`, `crawlee ^3.7.0` likewise unpinned. Repo ships only `pnpm-lock.yaml` (lockfileVersion 9.0 resolving playwright@1.59.1, crawlee@3.16.0) but every doc says `npm install`; `.gitignore:17` ignores `package-lock.json` → npm installs ignore the only lockfile and float every caret to latest.
- **Impact:** The documented install path is non-reproducible and ignores the only lockfile present; two hosts installed on different days run different `cloakbrowser`/stealth versions — directly affecting anti-bot success and making "why is this host blocked" undebuggable; a behavior-changed `0.3.x` `cloakbrowser` is auto-ingested with no pin.
- **Fix:** Choose one package manager. pnpm: change docs to `pnpm install --frozen-lockfile`, CI `--frozen-lockfile`. npm: commit `package-lock.json`, remove it from `.gitignore`, delete `pnpm-lock.yaml`, use `npm ci`. Pin `cloakbrowser` exact (`0.3.28`) and pin `playwright`/`playwright-extra`/`puppeteer-extra-plugin-stealth` exact. Add lockfile-drift CI.

#### [O8] README documents Monster as "HTTP API" but code uses stealth Chromium; plus other doc/code contradictions
- **Medium · docs · S** — *Monster portion duplicates T13.*
- **Location:** `README.md:13,32,449,186,300,313-314`; `scrapers/monster.js:5-7,22,81-83,113`; `Complete API.md:7,440,809-810`; `src/metrics/registry.js:54`; `package.json:3`
- **Evidence:** (1) README:13/32/449 call Monster an HTTP API with a hardcoded clientid; `monster.js` is full stealth Chromium (`humanize:true`), no HTTP API, no clientid; README:13 even claims Monster tolerates a datacenter IP while README:14 + setup docs say it's behind DataDome that 403s the VM. (2) Health response README:186 shows `version:1.0.0`; `registry.js:54`/`package.json:3` are `2.0.0`. (3) `Complete API.md:7` base URL is a `run.app` host while curl examples use `api.qpeakhire.com`. (4) `Complete API.md:809-810` lists monster/indeed as "None" and the Python sample `:440` omits Indeed from `PLATFORMS_REQUIRING_CREDENTIALS` while README/setup docs treat Indeed as cookie-auth.
- **Impact:** An operator debugging a blocked Monster scraper looks for an HTTP/API issue and never inspects the actual stealth/DataDome path — directly lengthens time-to-detect a block; version/base-URL drift erodes doc trust and can point new hosts at the wrong backend.
- **Fix:** Correct README:13/32/449 to "Monster — stealth Playwright Chromium behind DataDome (no login)"; reconcile the Monster-IP-tolerance contradiction; fix health version to 2.0.0; one canonical base URL in `Complete API.md`; reconcile Indeed credential status across all docs.

#### [T13] Monster: README ↔ code contradiction — README says "HTTP API behind DataDome (hardcoded clientid)"; code is CloakBrowser DOM scraping
- **Medium · code-quality · S** — *same issue as O8 item (1); track together.*
- **Location:** `scrapers/monster.js:1-14,15-159`; `README.md:30,280,449,13-14`; `src/metrics/registry.js:21`
- **Evidence:** No `appsapi.monster.io`/HTTP-API call and no clientid; launches CloakBrowser, warms up, DOM-scrapes `monster.com/jobs/search`. The file header documents the deliberate switch away from raw HTTP because DataDome flags non-browser requests. Authoritative answer: code does browser-DOM scraping; README is stale.
- **Impact:** Operators mis-diagnose Monster failures ("rotate the clientid/cookies" — neither exists); documented platform-placement rationale no longer matches reality.
- **Fix:** Update README sections 30/280/449/13-14 and the `registry.js:21` "Monster HTTP" comment; remove all clientid/HTTP-API language. (Single fix shared with O8.)

#### [C10] Audited path `scrapers/registry.js` does not exist; the active registry silently disables a platform
- **Low · code-quality · S**
- **Location:** absent `scrapers/registry.js`; `src/scrapers/registry.js:14-25`
- **Evidence:** No `scrapers/registry.js` on disk; the only registry is `src/scrapers/registry.js`, which hardcodes `dice,techfetch,linkedin,glassdoor,indeed` and omits `monster` with a DataDome-rate-limit comment. `PLATFORM_NAMES` (and the zod `platformField` enum) silently excludes monster.
- **Impact:** A `/scrape` request with `platform:"monster"` is rejected as an invalid enum value with no hint that it's intentionally disabled (only the source comment explains). Doc/scope drift; no functional break.
- **Fix:** Surface disabled-platform state in the health route; return a clearer 400 ("monster is temporarily disabled") rather than a generic enum failure; document a `DISABLED_PLATFORMS` list.

#### [T16] Monster: disabled state is correct but completely silent to API callers (no informative rejection)
- **Low · reliability · S** — *closely related to C10; resolve together.*
- **Location:** `src/scrapers/registry.js:14-31`; `src/validation/schemas.js:8-24`; `src/routes/health.js:17,36,40`; `README.md:14,161,187`
- **Evidence:** Monster cleanly removed from `SCRAPERS` (verified: no import/entry/half-wiring; `getScraper('monster')`→null), but `PLATFORM_NAMES`-derived zod enum makes `"platform":"monster"` a generic enum error with no "temporarily disabled" message — while `health.js:36` and README still advertise `monster` curl examples.
- **Impact:** Callers following docs/health get a confusing generic validation error for `monster`. Operationally annoying; not a data-integrity risk. (Removal itself is clean — not a silent inclusion.)
- **Fix:** Accept `monster` at the schema and return a clear `503 platform temporarily disabled` from the dispatcher, or update `health.js`/README examples to stop suggesting `monster`; centralize via a `DISABLED_PLATFORMS` list (shared with C10).

#### [L5] LinkedIn: CDP-migration contradictions — stale "(CDP Method)" banner, misleading comments, CDP-shaped error classification that burns credentials
- **Medium · code-quality / reliability · M**
- **Location:** `scrapers/linkedin.js:1091,1178,1351`; `scripts/chrome-debug.js` (whole file); `scripts/linkedin-selector-diag.mjs:1-13,24`; `scripts/linkedin-extract-test.mjs:1-12,18`
- **Evidence:** Logs `"LinkedIn Post Scraper (CDP Method)"` despite no CDP; comments say "same Chrome session" (it's a CloakBrowser context); `scripts/chrome-debug.js` is entirely the old `chrome:login` CDP flow, now dead but still referenced; the error classifier at `:1351` keys on `'waitForSelector'` as a permanent bad-credential signal (cooldown 0) — but `waitForSelector` failures now also occur for CloakBrowser DOM-shape changes, so a DOM tweak permanently fails good credentials. Diag scripts use `chromium.launchPersistentContext` (different auth than production).
- **Impact:** Misleading logs slow incident triage; `chrome-debug.js` invites a now-irrelevant flow; the `waitForSelector`→permanent-failure misclassification burns valid credentials on a single login-form DOM change; diag scripts give false confidence (different fingerprint/auth than production).
- **Fix:** Rename the banner; correct the "Chrome session" comments; delete or clearly deprecate `scripts/chrome-debug.js` + the `chrome:login` npm script; remove `waitForSelector` from the permanent-bad-credential branch (treat as transient/DOM-regression with cooldown + alert); update diag scripts to drive CloakBrowser + cookie injection.

#### [L10] LinkedIn: credential email/password in module-global `CONFIG`; credentials and full stack traces logged
- **Low · security · M**
- **Location:** `scrapers/linkedin.js:31-42,1163-1165,217,1159-1160,1344`
- **Evidence:** `CONFIG` is module-level mutable; `CONFIG.email/password/credentialId` overwritten per attempt — concurrent `scrapeLinkedIn` in one process would race on it (the file's own design assumes concurrent scrapes). Plaintext email logged (`:217,1159`); password length logged; full `error.stack` logged on every failure.
- **Impact:** In-process concurrency cross-contaminates which credential/query a browser uses (could scrape/log under the wrong account); account email in logs is a credential/PII concern; stack traces may leak internal paths.
- **Fix:** Move per-invocation auth/query state into function-local scope (or a per-call object); mask the email in logs (`a***@domain`); gate stack-trace logging behind a debug flag.

#### [I4] Glassdoor: dead `fs.readFileSync` with no `fs` import — guaranteed `ReferenceError` on the path-based / legacy credential branch
- **High · code-quality / reliability · S**
- **Location:** `scrapers/glassdoor.js:121-122` (imports at `:10-13`)
- **Evidence:** `loadCookies:121` calls `fs.readFileSync(cookiesPath,'utf8')` but `fs` is never imported (imports are only `cheerio`, `launch`, `createLogger`, `normalizeJobData`). Any call hitting that `else` branch throws `ReferenceError`. `loadCookies` is currently dead (Glassdoor is anonymous) but a live landmine if anyone re-wires cookie auth (likely per I7).
- **Impact:** Latent hard crash; misleads maintainers who believe this fallback works; if Glassdoor anonymous access degrades and someone re-enables the legacy path, it instantly `ReferenceError`s instead of degrading.
- **Fix:** Delete `loadCookies`/`parseExpiry`/`getRandomFingerprint`/`fingerprints` (all unused in the anonymous flow) — preferred, removes a misleading "supported" signal — or add `import fs from 'node:fs'` + try/catch.

#### [T8] Dice: Crawlee/Cheerio → CloakBrowser migration half-done — `CheerioCrawler` is a vestigial concurrency pool, its `$` ignored, every URL double-fetched
- **Medium · code-quality · M**
- **Location:** `scrapers/dice.js:1-15,138-343`
- **Evidence:** The module header documents a deliberate move to CloakBrowser, yet the worker is still a `CheerioCrawler`; inside `requestHandler({ $, request })` the Crawlee-provided `$` is never referenced — the handler opens a CloakBrowser page, navigates again, gets `page.content()`, and `cheerio.load`s a second instance. Every job URL is fetched twice (Crawlee's HTTP fetch discarded, then CloakBrowser). Crawlee is used purely for its retry/concurrency loop.
- **Impact:** Doubles request volume to Dice; the discarded Crawlee fetch is a non-stealth, datacenter-IP request that can itself trip detection or pollute rate limits (raises anti-bot exposure, ties to T9/T11); adds confusing dead infrastructure and contradicts the migration's own "simpler ops" rationale.
- **Fix:** Replace `CheerioCrawler` with a plain bounded-concurrency pool over CloakBrowser pages (the pattern already implemented manually in TechFetch); remove the unused Crawlee dependency from this path; keep `cheerio` only for parsing `pageHtml`.

#### [C9] `scrape-queue` route maps every orchestrator error to 500 and `result.error` to 409 — but the orchestrator never returns `result.error`
- **Low · code-quality · S**
- **Location:** `src/routes/scrape-queue.js:27-37`; `src/queue/orchestrator.js:51-82`
- **Evidence:** The route handles `result.error`→409, but `runOnce()` only returns `{skipped}`/`{message}`/`{batched,roles}` — never `.error`; the 409 branch is dead. Because assignments run in the background, a `200 'workflow completed'` is returned before any scraping finishes.
- **Impact:** Misleading API contract + dead code; a caller polling `/scrape-queue` cannot learn whether scraping succeeded; the "workflow completed" message contradicts reality.
- **Fix:** Remove the dead `result.error` branch or have `runOnce` surface claim errors structurally; change the success message to reflect work was *dispatched*, not completed.

#### [O6] Loki transport sends no authoritative identity labels — a mislabeled/duplicate host is unattributable
- **Medium · observability / reliability · S**
- **Location:** `src/logger/loki-transport.js:43-47,144-159`; `src/metrics/push.js:103-112`
- **Evidence:** Loki streams carry only `{host, os, mode, level, scope}`; identity labels (`app`, `scraper_name`, `scraper_key_id`, `instance`) are backend-injected from the API key; `host` is `os.hostname()`. Backend misconfig, a shared API key, or hostname collision makes a blocked host's logs indistinguishable from a healthy one's.
- **Impact:** During an incident an operator cannot reliably pivot Loki by per-host identity without backend cooperation; a blocked host's logs may merge with a healthy stream, masking the block — increases MTTD for O1/O2.
- **Fix:** Include the client-side `instance` label as a stream label so logs are attributable even if backend injection fails; keep backend labels as the spoof-resistant authority but don't make attribution solely dependent on them.

#### [O11] Loki flush groups by `(level, scope)` only — `scraper_alert` block context is in the line string, not a queryable label
- **Low · observability · S**
- **Location:** `src/logger/loki-transport.js:144-159`; `src/core/base-scraper.js:53-58`; `src/logger/index.js:57-64`
- **Evidence:** `base-scraper.js:57` emits `scraper_alert:'auth_required'` in the log meta specifically so dashboards can spot auth failures, but `logger/index.js:61` serializes meta into the message string and `loki-transport.js:150-156` keys streams only on `level|scope` — `scraper_alert` is buried in line text.
- **Impact:** A LogQL alert on `{scraper_alert="auth_required"}` won't work as a label matcher; operators must regex-scan line bodies (slower, fragile); the deliberate `scraper_alert` affordance is half-implemented.
- **Fix:** Promote a small allowlist of meta keys (`scraper_alert`, `platform`) to Loki stream labels in `flush()`, or document the required LogQL line-filter pattern.

#### [O12] Sustained-overflow signal is itself only a log line (can be lost with the channel it reports on)
- **Low · reliability / observability · S**
- **Location:** `src/logger/loki-transport.js:188-191`
- **Evidence:** On buffer overflow `flush()` emits `log.warn('log buffer overflow — lines dropped',{dropped})` — itself a log line. If Loki is down (the cause of overflow), the warning is also enqueued and may be dropped; no metric counterpart. (The buffer is correctly bounded — no memory/backpressure risk; this is a minor gap.)
- **Impact:** During a prolonged Loki outage the operator gets neither the dropped logs nor a reliable signal that logs were dropped; telemetry loss during an incident is invisible.
- **Fix:** Add a `scraper_log_lines_dropped_total` counter incremented on the overflow/`requeueOrDrop` path (metrics push is a separate channel that survives a Loki-only outage); alert on it.

---

## 4. Appendices

### 4.1 Cross-references & duplicates (same root, reported by independent agents)

- **The systemic silent-failure root** is reported at the framework level (F3, F12), per scraper (L1, L2, T1, T4, T9, T15, I1, I3), at the pipeline (C1, C3, O9), and at the observability layer (O1, O2). Fixing F3 + the new error taxonomy (F8) + the zero-jobs/block metrics (O1) + per-scraper wiring resolves the class; the per-scraper IDs remain as the wiring checklist.
- **F4 ≡ I1** — the Indeed search-path silent block; one fix.
- **T13 ≡ O8(item 1)** — Monster HTTP-API doc contradiction; one fix.
- **C10 & T16** — the same disabled-Monster surfacing gap; resolve together via a `DISABLED_PLATFORMS` concept.
- **I15 feeds F5**, **I6 feeds F5**, **T17 feeds F5/T6** — the fingerprint findings consolidate into the Phase 2 fingerprint factory.

### 4.2 Finding → phase index

- **Phase 1:** C1, C3, F3, F4, F8, F11, F12, L1, L2, T1, T4, T9, T15, I1, I2, I3, I13, I14, O1, O2, O3, O4, O5, O9, O10
- **Phase 2:** F1, F2, F5, F6, F7, F9, F10, I6, I7, I8, I12, I15, L6, L7, T6, T11, T17
- **Phase 3:** C2, C4, C5, C6, C7, C8, C11
- **Phase 4:** F13, L3, L4, L8, L9, T2, T3, T5, T7, T10, T12, T14, I5, I9, I10, I11, I16
- **Phase 5:** C9, C10, L5, L10, I4, T8, T13, O6, O7, O8, O11, O12, T16

### 4.3 Method & limitations

- Static code reading + reasoning only. No scraper, backend, or browser was executed; findings about runtime block behavior are inferred from code paths and the platforms' well-known anti-bot posture, not observed.
- Backend behavior (lease TTL, session-timeout, job de-dup by `session_id+platform`) is **not** in this repo. Several severities (notably C2, C6) hinge on backend backstops that should be confirmed; they are rated on the assumption that the client must be correct independently.
- The audit weighted anti-bot durability heaviest per the engagement scope; severities for other categories are objective but two-issue ties were broken toward anti-bot impact.
- This document is the deliverable. No code changes were made. Implementation of any phase or finding requires explicit per-item greenlight; at that point each greenlit slice should go through the writing-plans workflow to produce an implementation plan with tests.
