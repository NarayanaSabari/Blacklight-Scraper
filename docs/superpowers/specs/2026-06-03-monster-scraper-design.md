# Monster.com scraper — rewrite design

**Date:** 2026-06-03
**Scope:** Replace `scrapers/monster.js` with a hardened DOM-extraction scraper, re-enable the platform in `src/scrapers/registry.js`, add typed-error + classifier infrastructure mirroring the LinkedIn pattern, and ship test + debug-harness coverage.

## Goal

A Monster scraper that doesn't go silent. When Monster works, return clean job rows with non-empty URLs. When Monster breaks (DOM redesign, DataDome challenge, rate limit, network failure), throw a typed error so the operator sees it instead of receiving an empty batch the orchestrator records as success.

## Non-goals

- **No direct API calls.** `appsapi.monster.io/jobs-svx-service/...` is DataDome-protected — direct `fetch()` returns 403 → captcha-delivery.com from every origin we tried, with or without browser headers. Calling it from inside the browser context is technically possible but doubles per-page request volume and inherits the same DOM-discovery cost; net negative.
- **No hybrid (API + DOM fallback).** Doubles the failure surface and hides bugs in either path (e.g. the current `lines[0]=title` bug would have stayed hidden behind a working API path).
- **No residential proxies.** Probe shows 200 OK responses on 4/4 page loads with 3-5s spacing. DataDome only triggers above ~5 rapid requests.
- **No persistent profile, no login.** Monster doesn't gate search results behind auth. Anonymous CloakBrowser session per process.
- **No backend changes.** Same envelope to the Blacklight API as every other scraper.

## Ground truth (from live probes — do NOT re-derive)

Probes saved to `/tmp/monster-deep-probe.json` + `/tmp/monster-card.html` + `/tmp/monster-search.html` (investigation artifacts in `scripts/monster-deep-probe.mjs` + `scripts/monster-probe.mjs` — not part of the shipped scraper; see § H for disposition).

Established facts:

| Property | Today's behavior |
|---|---|
| Card selector (canonical) | `article[data-testid="JobCard"]` — exact match, NOT substring (substring matches `JobCardButton` too → 36 vs 18 duplicates) |
| Card selector (backup rail) | `[data-test-id^="svx-job-card-component-"]` (note: hyphenated `data-test-id`, distinct attribute from `data-testid`) |
| Title + company | `button[aria-label="<Title> at <Company>"]` inside the card |
| Job UUID | `button[data-job-id]` (UUID format) |
| Job URL | Real `<a href="/job-openings/...">` exists inside the card — read it first; construct `https://www.monster.com/job-openings/<uuid>` only as fallback |
| Other fields | innerText split on `\n`, regex-parsed (location may be joined with date: `"Redmond, WA7 days ago"`) |
| `__NEXT_DATA__` | `pageProps.jobViewResultsData = {}` (empty SSR); `pageProps.jobViewResultsDataCompact` exists for the selected card only |
| Pagination | URL only: `?page=N` (1-5 reachable). No "Next" button, no infinite scroll, no `?start=` / `?offset=` distinction |
| DataDome | 200 OK with 3-5s spacing; 5/10 success rate at zero spacing; 403 → `geo.captcha-delivery.com/interstitial/` when triggered |
| Network signal | `appsapi.monster.io/jobs-svx-service/v2/monster/search-jobs/samsearch/en-US?apikey=...` fires on every search nav — usable as a "page is alive" gate via `page.waitForResponse` |

## Bug in current scraper (must fix)

`scrapers/monster.js:58` reads `title = lines[0]` from a card's `innerText`. But `lines[0]` is the company-badge letter (`"M"` for Microsoft, `"P"` for Praxent), not the title. Result: every "job" returned today has `title="M"` (or `"P"`, `"G"`, etc.) and `url=undefined`. The 18-job count masks 100% data corruption. The new design reads `title` from `button[aria-label]` and never trusts `lines[0]` again.

## Section A — Data source: DOM with positive-signal gating

**Per-page flow:**

1. `page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })` — `?q=...&where=...&page=N`.
2. **Response gate (strictly stronger than waitForSelector):**
   ```js
   await page.waitForResponse(
     (r) => r.url().includes('/jobs-svx-service/v2/monster/search-jobs/') && r.request().method() === 'POST',
     { timeout: 15000 },
   );
   ```
   This is the positive "real results page rendered" signal. The hammer probe proved `status === 200` alone is not healthy (5 of 10 200-responses returned 0 cards). The appsapi POST is the canonical "Monster decided to give us jobs" event.
3. **Optional card-count cross-check:** read the appsapi response JSON (we're observing it anyway, no extra request). Compare `responseJson.<jobs-array>.length` to DOM card count; if they diverge by more than 1, throw `DomChangedError` ("schema drift"). Counts both sides without re-issuing the request.
4. `page.waitForSelector('article[data-testid="JobCard"]', { timeout: 5000 })` — treat timeout as a SOFT signal (could be genuine empty), the response gate is canonical.
5. `extractCards(page)` (see § B for selector waterfall + regex).
6. Sleep 3000–5000 ms (jittered) before the next page.

**Empty-page classifier (mirrors LinkedIn `linkedinPageState`):**

`classifyMonsterPage(page) → {state, signal}` where `state ∈ {results, empty_confirmed, soft_blocked, dom_changed, network_error}`.

| State | Signals (any one matches) |
|---|---|
| `results` | appsapi POST seen AND card count > 0 |
| `empty_confirmed` | `/no jobs (found|match)/i` in body text, AND pagination control absent or showing only page 1 |
| `soft_blocked` | Body contains `/datadome|verify you are human|ray id|access denied/i`, OR `page.url()` matches `captcha-delivery.com`, OR status 4xx/5xx |
| `dom_changed` | appsapi POST seen, card count > 0, BUT primary + backup selectors both find 0 OR aria-label regex fails on > 50% of matched cards |
| `network_error` | `goto` throws, response gate times out without any signal |

Each state maps to an outcome (§ E).

## Section B — Per-card extraction

Inside `page.evaluate()`:

```js
function extractCards() {
    const cards = [
        ...document.querySelectorAll('article[data-testid="JobCard"]'),
    ];
    // Backup rail — only run if primary returned 0
    if (cards.length === 0) {
        cards.push(...document.querySelectorAll('[data-test-id^="svx-job-card-component-"]'));
    }
    return cards.map(extractCard).filter(Boolean);
}

function extractCard(card) {
    const btn = card.querySelector('button[aria-label][data-job-id]');
    if (!btn) return null; // dom_changed signal aggregated upstream
    const aria = btn.getAttribute('aria-label') || '';
    const m = aria.match(/^(.+?)\s+at\s+(.+)$/);
    if (!m) return { __domChanged: true, aria }; // signal upstream
    const [, title, company] = m;
    const jobId = btn.getAttribute('data-job-id');
    if (!title || !company || !jobId) return null;

    const realAnchor = card.querySelector('a[href*="/job-openings/"]');
    const url = realAnchor?.href || `https://www.monster.com/job-openings/${jobId}`;

    const text = (card.innerText || '').trim();
    // Location may be glued to date: "Redmond, WA7 days ago"
    const locMatch = text.match(/([A-Z][a-zA-Z .'-]+,\s*[A-Z]{2}|Remote|United States)/);
    const dateMatch = text.match(/\b(\d+)\s+(day|hour|week|month|min(?:ute)?)s?\s+ago\b/i);
    const payMatch = text.match(/\$[\d,]+(?:\s*[–\-]\s*\$[\d,]+)?(?:\s*\/\s*(?:Year|Hour|Month))?/i);
    const isPromoted = /\bpromoted\b/i.test(text);

    return {
        title,
        company,
        location: locMatch ? locMatch[1] : '',
        datePosted: dateMatch ? dateMatch[0] : '',
        salary: payMatch ? payMatch[0] : '',
        jobId,
        url,
        description: text.slice(0, 800),
        isPromoted,
    };
}
```

**Hard requirements:**

- aria-label regex MUST be `/^(.+?)\s+at\s+(.+)$/`. If > 50% of matched cards return `{__domChanged: true}`, throw `DomChangedError("aria-label format changed")`. NO blind `split(' at ')`.
- Title MUST come from aria-label, NEVER `innerText.split('\n')[0]` (current bug — that's the company-badge letter).
- URL preference order: real `<a href>` first; constructed fallback only when href missing. Track which path was used in a debug log for ongoing diagnosis.
- Promoted cards INCLUDED in the output with `isPromoted: true` flag (cross-check thresholds account for them).

## Section C — Pagination + page budget

Identical loop to current scraper, with corrected stop conditions:

```js
const MAX_PAGES = 5;
const MAX_JOBS = 100;
const seen = new Set();
const allJobs = [];
let consecutiveEmpty = 0;

for (let pageNum = 1; pageNum <= MAX_PAGES && allJobs.length < MAX_JOBS; pageNum++) {
    await gotoSearch(page, jobTitle, location, pageNum);
    const state = await classifyMonsterPage(page);
    if (state.state === 'soft_blocked') throw new BlockedError(state.signal, { platform: 'monster', kind: 'datadome' });
    if (state.state === 'dom_changed') throw new DomChangedError(state.signal, { platform: 'monster' });
    if (state.state === 'network_error') throw new Error(`Monster network error: ${state.signal}`);
    if (state.state === 'empty_confirmed') { consecutiveEmpty++; if (consecutiveEmpty >= 2) break; continue; }

    const cards = await extractCards(page);
    let newCount = 0;
    for (const c of cards) {
        if (!c.url || seen.has(c.url)) continue;
        seen.add(c.url);
        allJobs.push(toJob(c));
        newCount++;
        if (allJobs.length >= MAX_JOBS) break;
    }
    if (newCount === 0) consecutiveEmpty++; else consecutiveEmpty = 0;
    if (consecutiveEmpty >= 2) break;

    await sleep(3000 + Math.random() * 2000); // 3-5s jittered
}
```

**Partial-result policy (matters for strict-empty):** if `BlockedError` / `DomChangedError` / `network_error` fires AFTER `allJobs.length >= 1`, the catch block returns `{ jobs: allJobs, emptyConfirmed: false, partial: true }` instead of rethrowing. This prevents `strictEmpty` from discarding pages 1-2 because page 3 hit a challenge. If `allJobs.length === 0` at throw time, propagate the typed error normally.

## Section D — Output: `normalizeJobData(..., 'Monster')`

Same envelope as today, with corrected field provenance:

```js
function toJob(c) {
    return normalizeJobData({
        title: c.title,                       // from aria-label
        hiringOrganization: c.company,        // from aria-label
        jobLocation: c.location,              // regex over innerText
        url: c.url,                           // real href || constructed
        datePosted: c.datePosted,             // raw "7 days ago"
        salary: c.salary,                     // raw "$142,800–$274,800 / Year"
        description: c.description,
        isPromoted: c.isPromoted,
    }, 'Monster');
}
```

**Field-completeness validation:** after `normalizeJobData`, reject any row where `title === 'N/A'` OR `url === 'N/A'` OR `company === 'N/A'`. `normalizeJobData` has lenient `'N/A'` defaults that would otherwise leak garbage through. Rejection here surfaces as `DomChangedError` after the loop if rejection rate > 30% of extracted cards (signals a regex-level drift not caught by aria-label match).

Sets the URL-quality metric (from the server-robustness slice) to `permalink` for every Monster job, since the URL is always a `/job-openings/...` page.

## Section E — Error model + lifecycle

Reuse `src/core/errors.js` types — same as LinkedIn:

| Throw | When | Cooldown |
|---|---|---|
| `BlockedError({platform:'monster', kind:'datadome'})` | classifier returns `soft_blocked`, or per-card failure rate > 50% with a DataDome signal | 30 min (existing `COOKIES_EXPIRED_COOLDOWN_MIN` semantics; rename to `BLOCKED_COOLDOWN_MIN` if needed) |
| `DomChangedError({platform:'monster'})` | aria-label regex no-match > 50% of cards, OR primary+backup selectors return 0 on a page that's not `empty_confirmed`, OR cross-check between appsapi response count and DOM count diverges by > 1 | None — rethrow, fail loud |
| Generic `Error` | `page.goto` timeout, `waitForResponse` timeout with no other signal | None |
| `ScraperError` (auto-wrapped by `BaseScraper`) | any other throw | None |

**`strictEmpty` override:** set `strictEmpty: true` on the `BaseScraper` for Monster regardless of env var. Monster's silent-empty-with-200 failure mode is the documented threat. Per the workflow synthesis: "status 200 alone is NOT a healthy signal — hammer test showed cards:0 on ALL 10 iterations including 5 with status:200."

```js
// src/scrapers/registry.js
monster: new BaseScraper('monster', scrapeMonster, { strictEmpty: true }),
```

## Section F — Tests

**Layer 1 — unit/fixture (Node 24, `node --test 'test/**/*.test.js'`):**

- `test/scrapers/monster-extract-card.test.js` — feeds the extractor saved snippets from `/tmp/monster-card.html`:
  - 18-card happy path → 18 valid rows
  - aria-label regex match path → title + company populated correctly
  - aria-label regex no-match → returns `{__domChanged: true}` sentinel
  - innerText with joined location+date `"Redmond, WA7 days ago"` → both fields parsed
  - `card-not-selected` vs selected class — both yield a valid row (aria-label is the only required signal)
  - Promoted card → `isPromoted: true` and still included
  - **Regression guard:** never emit `title === 'M'` / `'P'` / single character (the current bug)
- `test/scrapers/monster-classify-page.test.js` — feeds the classifier saved HTML fragments:
  - DataDome interstitial → `soft_blocked`
  - "No jobs found matching" string → `empty_confirmed`
  - Real results page → `results`
  - 0 cards + no empty-results string + appsapi POST seen → `dom_changed`
- `test/scrapers/monster-url-construction.test.js` — given a card with real `<a href>` → returns the href; given a card with only `data-job-id` → constructs `https://www.monster.com/job-openings/<uuid>`; given a card with neither → returns `null`.

**Layer 2 — debug harness:**

- `scripts/test-monster-scrape.js` — mirror of `scripts/test-linkedin-scrape.js`. Runs `scrapeMonster` against one role end-to-end, prints per-job summary + URL-quality breakdown. Used to verify live behavior after a DOM change.

**Layer 3 — investigation artifacts (decision in § H):**

Existing `scripts/monster-probe.mjs` + `scripts/monster-deep-probe.mjs` are kept as ongoing debug tools — the same pattern we use for LinkedIn. Documented in `docs/superpowers/specs/2026-06-03-monster-scraper-design.md` (this file) as such; not part of the runtime scraper.

## Section G — Registry re-enable

`src/scrapers/registry.js`:

```js
import { scrapeMonster } from '../../scrapers/monster.js';

export const SCRAPERS = Object.freeze({
    dice: new BaseScraper('dice', scrapeDice),
    techfetch: new BaseScraper('techfetch', scrapeTechFetch),
    linkedin: new BaseScraper('linkedin', scrapeLinkedIn),
    glassdoor: new BaseScraper('glassdoor', scrapeGlassdoor),
    indeed: new BaseScraper('indeed', scrapeIndeed),
    monster: new BaseScraper('monster', scrapeMonster, { strictEmpty: true }),
});
```

Remove the "Monster is currently disabled" comment block.

## Section H — Disposition of investigation artifacts

Three files exist in the repo that aren't part of the runtime scraper:

| Path | Decision |
|---|---|
| `scripts/monster-probe.mjs` | **Keep.** Simple end-to-end probe; useful for "is Monster reachable today" checks. Document at top: "investigation harness, not run by tests." |
| `scripts/monster-deep-probe.mjs` | **Keep.** Detailed DOM/structured-data/pagination/reliability probe; the reference for re-investigating after a Monster change. Same docstring. |
| `/tmp/monster-*.html` + `/tmp/monster-*.json` | **Not in repo.** Probe outputs go to `/tmp` and are NOT committed. The scripts regenerate them on demand. |

Both `.mjs` files committed alongside the scraper rewrite so the future operator who hits a Monster change can re-run the probes immediately.

## File map

| File | Action | Roughly |
|---|---|---|
| `scrapers/monster.js` | **rewrite** | ~250 LOC (vs current 159) |
| `src/scrapers/registry.js` | **modify** | +2 LOC (re-add import + entry; remove disabled-comment block) |
| `scripts/test-monster-scrape.js` | **new** | ~60 LOC |
| `scripts/monster-probe.mjs` | **keep** (already present) | — |
| `scripts/monster-deep-probe.mjs` | **keep** (already present) | — |
| `test/scrapers/monster-extract-card.test.js` | **new** | ~80 LOC |
| `test/scrapers/monster-classify-page.test.js` | **new** | ~50 LOC |
| `test/scrapers/monster-url-construction.test.js` | **new** | ~30 LOC |
| `test/fixtures/monster-card.html` | **new** | (copied from `/tmp/monster-card.html`) |
| `test/fixtures/monster-empty.html` | **new** | (manually saved later, or stubbed) |

Total: ~480 LOC code + tests + fixtures across ~10 files.

## Open questions (deferred to implementation discovery)

1. `__NEXT_DATA__.pageProps.jobViewResultsDataCompact` may carry the search list when the page is opened in a different state (e.g. first card auto-selected). Worth a 1-minute probe before writing the extractor. If populated, becomes a free no-DOM cross-check signal.
2. Does CloakBrowser reuse DataDome cookies across page navs in the same context, or pay full challenge cost per goto? If full cost, sleep timer may need to grow. Observable during implementation.
3. Per-scraper `strictEmpty:true` override in `BaseScraper` constructor — confirm the constructor accepts it. (Read of `src/core/base-scraper.js:46-47` shows `options.strictEmpty` is supported; just need to pass it through the `BaseScraper` constructor in `registry.js`.)
4. Canary-query monitoring (e.g. "software engineer" + "New York" should always return >= 10 jobs) — out of scope for this slice; tracked as a follow-up after the scraper ships.

## Success criteria

- `scripts/test-monster-scrape.js -- "software engineer"` returns at least 18 jobs, with every row having: non-empty title (length > 1), non-empty company, URL starting with `https://www.monster.com/job-openings/`, no `'N/A'` placeholders. **Regression guard: title is NEVER `'M'`, `'P'`, or any single character.**
- Monster appears in `/healthz` payload's available platforms (via existing `PLATFORM_NAMES` derivation).
- A captured DataDome interstitial HTML, fed to the classifier, returns `soft_blocked` and throws `BlockedError` (not silent zero).
- A captured "no results" page returns `empty_confirmed` and emits `{ jobs: [], emptyConfirmed: true }` (no false alarm).
- `scraper_url_quality_total{platform="monster",quality="permalink"}` ticks for every job; `quality="empty"` is 0.
- `scrapers/linkedin.js` not modified (sanity guard — different platform).
