# Scraper Runbook (per-platform: how it works + how to deploy)

How each of the 6 job platforms is scraped, the env flags, and what each needs to
run. Last updated 2026-07-29.

## TL;DR status
| Platform | Method | Needs |
|---|---|---|
| **Dice** | Browser, **direct** (works on any IP) | nothing |
| **LinkedIn** | Browserless RSC API using cookies from a **logged-in persistent profile** | valid profile cookies plus a captured RSC request template |
| **Indeed** | **Mobile GraphQL API** (`apis.indeed.com`) — no Cloudflare wall | proxy (recommended) |
| **Glassdoor** | **`/graph` API** via TLS-impersonation plus CloakBrowser job-page enrichment | direct discovery; pooled detail IPs recommended |
| **Monster** | Browser (DOM warmup → DataDome mints cookie) → **parse appsapi JSON** → retry across IPs | **clean/fresh residential IPs** |

Indeed and Glassdoor use API discovery instead of their unreliable browser paths.
Glassdoor's API listings have no usable descriptions, so its API path intentionally
launches one CloakBrowser to fetch server-rendered job pages after discovery.
Monster is DataDome — the one that needs IP hygiene (see its section).

---

## Hidden runtime dependencies (provision these on deploy — NOT from `npm ci`)
- **CloakBrowser 0.5.2** (used by every active browser path, including Glassdoor detail enrichment): self-downloads ~350 MB of stealth Chromium to `~/.cloakbrowser` on **first launch**. First run is slow / needs network + disk. Pre-warm in your Docker image or first-boot script. The 0.5.x line is required for the recovered Monster path.
- **node-tls-client** (used by Glassdoor API): downloads a small **Go shared lib** on first `initTLS()`. Same pattern — pre-warm.

## Proxies (`config/proxies.txt` — git-ignored, holds real creds)
- One IP per line: `host:port:user:pass`. Comments with `#`. Round-robins one IP per scrape; cools an IP on block (`PROXY_BLOCK_COOLDOWN_MS`, default 10 min).
- Alternatives: `PROXY_LIST` (newline/comma separated) or `PROXY_LIST_FILE`.
- **No proxy config → everything runs direct** (fine for Dice and TechFetch; Monster and Glassdoor depend on the host IP).
- `PROXY_EXCLUDE_PLATFORMS=glassdoor` keeps Glassdoor `/graph` discovery direct while its `glassdoor-jd` enrichment leases from the pool.
- `PROXY_EXCLUDE_PLATFORMS=glassdoor,glassdoor-jd` keeps both Glassdoor paths direct.
- Dice is wired to run direct regardless (works on any IP).

---

## Per-platform

### Dice — direct, zero config
Runs headless Chromium with no proxy. `MAX_JOBS=40`. Its detail payload is
server-rendered `jobDetailStructuredData` JSON-LD and is available at
`domcontentloaded`.
`DICE_DETAIL_RENDER_WAIT_MS` defaults to `0` and remains tunable; a rise in
`Detail dropped (dom_changed)` signals that hydration is needed again.
`DICE_SEARCH_RENDER_WAIT_MS` defaults to `2000` and `DICE_DETAIL_CONCURRENCY`
defaults to `10`.

### TechFetch - browser-navigation-bound detail fetches
The detail path parses the raw HTTP response body, so its old 500 ms post-navigation
wait was removed.
The 500 ms wait now applies only as retry backoff (`TECHFETCH_RETRY_BACKOFF_MS`).
`TECHFETCH_DETAIL_CONCURRENCY` defaults to `8` and is tunable.

### LinkedIn — browserless RSC transport
Uses plain HTTP requests to LinkedIn's content-search RSC endpoint.
- `npm run linkedin:login` creates or refreshes the persistent CloakBrowser profile; the scraper reads its cookies without navigating to LinkedIn.
- `npm run linkedin:rsc-template` captures the request shape into the git-ignored `config/linkedin-rsc-template.json`.
- `LINKEDIN_PROFILE_DIR` - persistent profile path. `LINKEDIN_RSC_TEMPLATE` - captured template path override.
- `LINKEDIN_RSC_COUNT` defaults to 10 and is capped at 50 per request. `LINKEDIN_RSC_COOKIE_TTL_MIN` defaults to 30.
- Backend concurrency cap = 2 (set server-side).

### Indeed — mobile API (primary), browser (opt-in fallback)
`apis.indeed.com/graphql` has no Cloudflare wall — authenticated POST returns clean job JSON in <1s.
- `INDEED_USE_API` — default **on**; set `=false` to disable the API path.
- `INDEED_BROWSER_FALLBACK=1` — fall back to the (hard-blocked) browser path on API failure. Default off → API failure throws.
- `INDEED_API_KEY` — override the public iOS-app key (a working default is bundled).
- Browser-fallback knobs: `INDEED_HEADLESS`, `INDEED_PROFILE_DIR`, `INDEED_ALLOW_ANONYMOUS`, `INDEED_CF_GRACE_MS`.

### Glassdoor - `/graph` API plus detail enrichment, browser (opt-in fallback)
`POST www.glassdoor.com/graph` via `node-tls-client` (randomized-JA3) passes Cloudflare where plain Node gets TLS-reset.
Before the POST, the API path warms a real `/Job/*.htm` page and requires Glassdoor's
own `gdsid` or `gdId` cookie; a warm-up without those cookies is retried on a new IP
and then raises `BlockedError` without spending a guaranteed-403 POST.
- `GLASSDOOR_USE_API` — default **on**; `=false` to disable.
- `GLASSDOOR_BROWSER_FALLBACK=1` — browser fallback on API failure (default off).
- `GLASSDOOR_CSRF_TOKEN` — override the bundled public job-search-next token (rotate if Glassdoor returns 403s).
- `GLASSDOOR_LOCATION_ID` — default `11047` (US, STATE). Change to target a region.
- `GLASSDOOR_WARMUP_URL`, `GLASSDOOR_WARMUP_ATTEMPTS` (default `3`), and `GLASSDOOR_WARMUP_BACKOFF_MS` (default `1500`) tune the session warm-up.
- `GLASSDOOR_MAX_AGE_DAYS` — default `7`; stale listings are dropped before enrichment.
- `GLASSDOOR_FETCH_DESCRIPTIONS` — default **on**; set `false` to skip detail-page enrichment.
- `GLASSDOOR_DESC_CONCURRENCY` — default `6`; one shared CloakBrowser fetches job pages concurrently, with no per-job sleep.
- `GLASSDOOR_CF_GRACE_MS` — browser-fallback Cloudflare grace.

The search API's description field is empty, so enrichment parses server-rendered
JSON-LD from each job page.
Glassdoor rate-limits those page fetches per IP after roughly one batch.
The scraper stops the batch on the first denial, cools the `glassdoor-jd` lease,
and leaves the remaining descriptions as `N/A` rather than failing the scrape.

### Monster — browser + appsapi-JSON parse + retry  ⚠️ needs clean IPs
Monster is DataDome-gated. The scraper warms up monster.com (so DataDome's JS mints a `datadome` cookie), then **parses jobs straight from the appsapi JSON** the page fetches (robust — not DOM-card-dependent). The appsapi returns 200 + jobs **on a clean IP**; DataDome 403s **flagged/hammered IPs**, and the block is **per-IP**.
- `MONSTER_MAX_ATTEMPTS` — default `4`. On each DataDome block (403 / "0 cards"), it cools that IP and retries on the next one. With a healthy pool of clean IPs, a few attempts → high success.
- **Requirement: fresh/clean residential (ideally mobile) IPs.** An IP that's been hammered gets DataDome-flagged and returns 403 until it cools (~hour of no traffic). If all pooled IPs are flagged, Monster returns 0 until they recover or you add fresh ones. This is IP hygiene, not a code setting.
- The `network_error` verdict means the page loaded but DataDome suppressed the appsapi POST; it is recorded as a retryable `BlockedError` with kind `datadome-suppressed`, distinct from the ordinary `datadome` kind.
- The 3–5 second homepage warm-up and 3–5 second inter-page pacing are deliberate anti-bot behavior and are not performance waits to remove.
- No paid unlocker, no Python. `camoufox-js` (pure-Node, higher DataDome pass-rate, runs headless) is an available engine upgrade if Monster reliability ever needs a boost.

---

## CloakBrowser session seats (one licence key per concurrent browser)

CloakBrowser enforces its concurrent-session limit **per licence key, globally** —
not per process. Verified 2026-07-28: two browsers on one key leaves one alive and
kills the other with `Target page, context or browser has been closed`; three
leaves one; two separate OS processes collide identically, so process isolation is
no escape. cloakbrowser's own error 76 says it outright: "session limit reached
for your plan."

This bit us because the orchestrator scrapes **all of a role's platforms in
parallel**. The old prod VM key allowed `["dice","glassdoor","indeed","techfetch"]`
— four browsers on one licence, three of them killed on every assignment. It shows
up as `failed` session_platform_status rows and near-instant platform failures,
not as an obvious licensing error.

`src/core/browser-pool.js` wraps `launch` / `launchPersistentContext` so every
scraper leases a seat from `src/core/license-pool.js` for the browser's lifetime.
Configure keys with `CLOAKBROWSER_LICENSE_KEYS` (comma/newline separated) or one
per line in the git-ignored `config/cloakbrowser-keys.txt`. **Never commit keys.**

Seat ownership is coordinated across scraper processes with atomic lockfiles.
By default they live in `~/.blacklight-cloakbrowser-seats/`, with one filename
per hashed licence key and the owning PID stored in the file.
Set `CLOAKBROWSER_LICENSE_LOCK_DIR` only when an alternate lock directory is
required.
Dead-owner locks are reclaimed automatically, and a process waits with a bounded
poll interval when another live process owns a seat.
If the implicit no-key seat cannot create its lock directory, it falls back to
in-process-only serialisation and logs the condition once.

**Sizing rule: one key per browser platform you want running concurrently.**
Measured on this fleet with three browser platforms in parallel:

| Keys | Behaviour | Result |
|---|---|---|
| 1 (before the pool) | dice survives, techfetch killed after 2s | ~40 jobs, two scrapes lost |
| 2 | the third platform queues for a seat | 116 jobs (40+40+36) in 66s |

Fewer keys than platforms is safe — the extras wait rather than fail. With **no**
keys configured the pool still exposes a single seat, so launches serialise
instead of killing each other while cloakbrowser falls back to its own
`CLOAKBROWSER_LICENSE_KEY` / `~/.cloakbrowser/license.key` resolution.

Note the plan matters: a key on the free plan is `{valid: true, plan: 'free'}`
with a one-session limit, so extra concurrency means extra keys (or a paid plan).

## Global knobs
- `SCRAPER_HEADLESS` — default headless; `false`/`0`/`no`/`off` → **headful** (a stronger stealth posture for DataDome/Cloudflare; on Linux use `xvfb-run -a`).
- `SCRAPER_BLOCK_RESOURCES` — block images/media/fonts to cut proxy bandwidth (`SCRAPER_BLOCK_RESOURCE_TYPES` to customize). Measured ~20% bandwidth savings.
- `SCRAPER_STRICT_EMPTY` — the fallback for scrapers without a registry override;
  active registry entries already enable strict handling and return confirmed-empty
  signals where the platform can prove a genuine zero.
- `PROXY_BLOCK_COOLDOWN_MS` — per-IP cooldown after a block (default 600000).

## Deploy checklist
1. `git pull` (Windows: restart after pull).
2. Put `config/proxies.txt` (fresh, clean residential IPs) and the git-ignored `config/credentials.json` on the box.
3. Pre-warm hidden deps: launch once so CloakBrowser (~350 MB) and the node-tls-client Go lib download.
4. Set `PROXY_EXCLUDE_PLATFORMS=glassdoor` when a populated pool is available and Glassdoor discovery must stay direct.
5. Run `npm run linkedin:login` and `npm run linkedin:rsc-template` before using LinkedIn. Indeed/Glassdoor/Dice then work immediately. Monster works as long as the pool has clean IPs.
6. Verify: hit `/healthz` and run one scrape per platform.

The anti-bot research that motivated these knobs is in the repository's git history.

When a running host misbehaves, start from [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
It is organised by symptom and covers the failures that look like something they are not:
a parser gap reported as a block, a dead session reported as a confirmed-empty result, and
licence-seat exhaustion reported as a broken browser.
