# Anti-bot bypass plan (Indeed / Glassdoor / Monster)

> Source: multi-agent research sweep (Reddit + web, 2026-06-17) + code audit.
> Baselines (measured WITH residential proxy, **headless**): Glassdoor ~27%,
> Indeed ~6% (hard block), Monster 0% (DataDome). Dice 100% (direct), LinkedIn ok.

## Honest verdict
Literal 100% is not achievable on any of the three. "As reliable as possible" =
**~94–98% via a gated paid Web Unlocker** on the hard targets, with the **free
DIY stack** getting Glassdoor genuinely good and Indeed *possibly* solved free via
its mobile/JSON path. Don't add more IPs (fingerprint+behavior is the gate, not IP
count). Skip ZenRows/ScrapingBee (measured 4–66% on these sites), Camoufox
(Python-only), and TLS-spoof libs (irrelevant to a real-browser path).

## Per-site plan + realistic ceilings
| Site | Free-stack ceiling | With unlocker | Type |
|---|---|---|---|
| **Glassdoor** | ~60–85% | ~95%+ | Cloudflare **resolvable** challenge |
| **Indeed** | single digits browser-only; **~90% IF mobile/JSON path holds** | ~94–98% | Cloudflare **hard block** |
| **Monster** | ~50–67% (decays in ~24h as DataDome learns) | ~89–98% | DataDome |

## Phase 1 — FREE wins (do first; they gate everything)
1. **Headful, not headless** — `headless:true` is a strong CF/DataDome tell; CloakBrowser's own docs recommend headed + (Linux) Xvfb. We added `SCRAPER_HEADLESS` toggle; **test headful** (all my baselines were headless). On prod Linux: `xvfb-run -a node server.js`. macOS/Windows: headed works directly.
2. **WebRTC real-IP leak** — disable: launch args `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; STUN can leak the host IP around the proxy (instant bot signal). Verify via browserleaks/webrtc through the proxy.
3. **geoip + humanize + Accept-Language** — enable CloakBrowser geoip (persona tracks proxy exit); add `humanize:true` to **Glassdoor** (missing); set `extraHTTPHeaders {'Accept-Language':'en-US,en;q=0.9'}` on newContext.
4. **Classify hard-block vs resolvable** — Glassdoor: poll for `cf_clearance` cookie / challenge cleared (done: poll-until-cleared). Indeed: detect 403/1020/"you have been blocked" and STOP wasting waits → route to fallback.
5. **Probe the CDP `Runtime.enable` leak** — the #1 automation tell. Run rebrowser bot-detector / creepjs through CloakBrowser+proxy. If CloakBrowser leaks it → consider **Patchright** (Node, drop-in) for the leaky path. If it passes → skip Patchright.

## Phase 2 — site-specific FREE wins
### Glassdoor — token-harvest + in-page API replay (high yield/success, free)
After a page survives Cloudflare (~27%), harvest `gd-csrf-token` (meta / cookies / `__NEXT_DATA__`) and call the BFF from **inside the page** (rides the trusted context, no re-challenge):
```
POST /job-search-next/bff/jobSearchResultsQuery
  headers: { 'content-type':'application/json', 'gd-csrf-token': <tok> }
  body: { keyword, locationId, locationType:'CITY', numJobsToShow:30,
          pageNumber:0, pageCursor:'', pageType:'SERP', seoUrl:true,
          filterParams:[{filterKey:'sortBy', values:'date_desc'}] }
```
Paginate via `response.paginationCursors`. Reviews/salary via `POST /graph` (same token + `apollographql-client-name`). Turns each survived page into many clean-JSON pages.

### Monster — diagnose first (could be a FREE fix), then in-context replay
1. **Health-gate on appsapi JSON**: `waitForResponse` the appsapi POST, read `body.<jobsArray>.length`. Empty-200 on a known-populated canary ("software engineer"/"New York" ≥10) → real DataDome soft-block (throw BlockedError), not dom_changed.
2. **Relaxed-query A/B**: current (`where='United States'` + recency + `so=m.s.sh`) **may be over-filtering**. A/B vs `?q=software+engineer&where=&page=1`. If relaxed returns jobs and current is 0 → **free fix**, relax defaults.
3. **In-context appsapi replay**: capture page-1 appsapi (URL incl. apikey, headers, body) and replay pages 2..N via `page.request.post(...)` (same TLS+cookies). Exporting the datadome cookie to Node `fetch` fails (403, TLS mismatch) — must stay in-browser.
4. **Persistent context + deeper warmup + ghost-cursor** so the datadome cookie persists across all pages.

### Indeed — JSON extraction + (uncertain) mobile path; else unlocker
1. **Extraction**: parse `window.mosaic.providerData["mosaic-provider-jobcards"]` JSON from `page.content()` → `.metaData.mosaicProviderJobCardsModel.results` (replaces brittle DOM; removes a failure class). **Still needs ONE successful load — does not bypass the hard block.**
2. **Mobile/JSON spike (free, uncertain)**: reverse-engineer JobSpy's Indeed module (`apis.indeed.com` GraphQL / mobile backend reportedly has no Cloudflare wall) and reimplement in Node through the proxy. Validate the endpoint+key still work BEFORE investing.
3. Official Publisher API = **dead** (deprecated). Don't pursue.

## Phase 3 — paid fallback (the honest path to "reliable") — gated to failures only
Add a `transport` abstraction: try CloakBrowser first; on hard-block/repeated timeout, call an unlocker over Node HTTP and feed the HTML/JSON into the **existing** extractors. Gate behind an env flag + daily budget cap.
| Provider | Indeed | Glassdoor | Monster/DataDome | ~Cost |
|---|---|---|---|---|
| **Decodo** (we already have the account) | good | 96% | — | ~$0.25/1k |
| Scrape.do | 98% | 98% | 97% | ~$0.077–? /1k |
| Bright Data Web Unlocker | 94–98% | 94% | yes | ~$1.50/1k |
| Scrapfly (best DataDome) | — | — | 98% | ~$3.88/1k |

## RESULTS (2026-06-17, implemented + live-tested)
- **Indeed: SOLVED ✅ (0% → ~100%, free).** Mobile GraphQL API `apis.indeed.com/graphql` has no Cloudflare wall — 40 jobs/role in <1s through the proxy. Shipped `scrapers/indeed-api.js` (commit bf69e17). This is the hardest site, done for free.
- **Browser stealth stack = dead end on the hard sites.** Headless+geoip AND headful+geoip both ~0% on Indeed/Glassdoor/Monster. (Indeed/Monster hard-block; Glassdoor's earlier 27% is confounded — the 3 test IPs are burned from heavy stress-testing.)
- **Glassdoor API ≠ as clean as Indeed.** Its `/graph` is on the Cloudflare-protected `www.glassdoor.com`: plain `undici` POST → connection reset (CF TLS/JA3 block). `cycletls` (JA3 impersonation) spike was flaky + the managed-challenge is the next wall. Glassdoor free paths: (a) browser SERP on **fresh/cooled IPs** (~27% historically) + in-page API replay for yield, or (b) unlocker.
- **Monster:** DataDome guards both website and appsapi → no free path. Needs unlocker.

**FINAL platform status: Dice ✅(direct) · LinkedIn ✅ · Indeed ✅(mobile API) · Glassdoor ✅(/graph API + node-tls-client TLS-impersonation, commit cdb1586) · Monster ❌(DataDome).**

**4 of 5 working FREE — including both Cloudflare hard sites (Indeed + Glassdoor).**
- **Glassdoor SOLVED:** `node-tls-client` (randomized-JA3 Go TLS) passes Cloudflare where plain Node can't; `POST /graph` + public CSRF token + ignore the `seoData` sub-error → 30 jobs/role. JobSpy's own Glassdoor is broken upstream (location-lookup 404s); we bypass with a fixed `GLASSDOOR_LOCATION_ID`.
- **Monster SOLVED FREE (commit 943181d) — the wall was the burned IPs, not the engine.** Proven: CloakBrowser (existing Node engine) **direct on a CLEAN IP → appsapi 200, 36 jobs**; same engine on the 3 burned Decodo IPs → 403/empty. Research (2026 benchmarks) confirms DataDome blocks per-IP; engine can't rescue a flagged IP. Method (already what we do): navigate the monster.com DOM so DataDome JS mints the cookie → appsapi succeeds in-context (don't hit appsapi directly → 403 captcha). DataDome is ~50/50/attempt, so `scrapeMonster` now **retries across rotating IPs** (`MONSTER_MAX_ATTEMPTS`=4). **The only requirement: FRESH/clean residential IPs** (the 3 test IPs are burned from a day of testing; they recover after cooldown, or add more). No paid unlocker, no Python. `camoufox-js` (pure-Node, ~67%) is an available engine upgrade if needed.

**ALL 5 platforms now work FREE given clean IPs: Dice · LinkedIn · Indeed · Glassdoor · Monster.**

## Recommended sequence
- **Day 1 (free):** headful A/B test (all 3) + WebRTC fix + geoip/Accept-Language + Glassdoor `humanize` + CDP-leak probe → re-measure.
- **Day 2–3 (free):** Glassdoor token-harvest+API-replay; Monster appsapi gate + canary/relaxed-query A/B + persistent-context warmup.
- **Week 1:** Indeed mobile-API spike **in parallel with** a 2–3 provider unlocker bake-off (Decodo, Scrape.do, Scrapfly) on fixed 50-URL sets; wire the winner as a failure-only fallback behind an env flag + budget cap.
