# Scraper Runbook (per-platform: how it works + how to deploy)

How each of the 5 job platforms is scraped, the env flags, and what each needs to
run. Last updated 2026-06-17.

## TL;DR status
| Platform | Method | Needs |
|---|---|---|
| **Dice** | Browser, **direct** (works on any IP) | nothing |
| **LinkedIn** | Browser on a **logged-in persistent profile** | valid cookies in `config/credentials.json` |
| **Indeed** | **Mobile GraphQL API** (`apis.indeed.com`) — no Cloudflare wall | proxy (recommended) |
| **Glassdoor** | **`/graph` API** via TLS-impersonation (`node-tls-client`) | proxy (recommended) |
| **Monster** | Browser (DOM warmup → DataDome mints cookie) → **parse appsapi JSON** → retry across IPs | **clean/fresh residential IPs** |

Indeed & Glassdoor were Cloudflare hard-blocks in the browser; both are solved by
hitting the site's API instead. Monster is DataDome — the one that needs IP
hygiene (see its section).

---

## Hidden runtime dependencies (provision these on deploy — NOT from `npm ci`)
- **CloakBrowser** (used by Dice, LinkedIn, Indeed-fallback, Glassdoor-fallback, Monster): self-downloads ~350 MB of stealth Chromium to `~/.cloakbrowser` on **first launch**. First run is slow / needs network + disk. Pre-warm in your Docker image or first-boot script.
- **node-tls-client** (used by Glassdoor API): downloads a small **Go shared lib** on first `initTLS()`. Same pattern — pre-warm.

## Proxies (`config/proxies.txt` — git-ignored, holds real creds)
- One IP per line: `host:port:user:pass`. Comments with `#`. Round-robins one IP per scrape; cools an IP on block (`PROXY_BLOCK_COOLDOWN_MS`, default 60s).
- Alternatives: `PROXY_LIST` (newline/comma separated) or `PROXY_LIST_FILE`.
- **No proxy config → everything runs direct** (fine for Dice; risky for the rest).
- Dice is wired to run direct regardless (works on any IP).

---

## Per-platform

### Dice — direct, zero config
Runs headless Chromium with no proxy. `MAX_JOBS=40`. Nothing to configure.

### LinkedIn — logged-in profile
Drives a **persistent** CloakBrowser profile that's already logged in.
- `config/credentials.json` holds the real LinkedIn cookies — **git-ignored, never commit**. Cookies expire; re-auth when LinkedIn scrapes start failing.
- `LINKEDIN_PROFILE_DIR` — persistent profile path. `LINKEDIN_HEADLESS` — headless toggle.
- Backend concurrency cap = 2 (set server-side).

### Indeed — mobile API (primary), browser (opt-in fallback)
`apis.indeed.com/graphql` has no Cloudflare wall — authenticated POST returns clean job JSON in <1s.
- `INDEED_USE_API` — default **on**; set `=false` to disable the API path.
- `INDEED_BROWSER_FALLBACK=1` — fall back to the (hard-blocked) browser path on API failure. Default off → API failure throws.
- `INDEED_API_KEY` — override the public iOS-app key (a working default is bundled).
- Browser-fallback knobs: `INDEED_HEADLESS`, `INDEED_PROFILE_DIR`, `INDEED_ALLOW_ANONYMOUS`, `INDEED_CF_GRACE_MS`.

### Glassdoor — `/graph` API (primary), browser (opt-in fallback)
`POST www.glassdoor.com/graph` via `node-tls-client` (randomized-JA3) passes Cloudflare where plain Node gets TLS-reset.
- `GLASSDOOR_USE_API` — default **on**; `=false` to disable.
- `GLASSDOOR_BROWSER_FALLBACK=1` — browser fallback on API failure (default off).
- `GLASSDOOR_CSRF_TOKEN` — override the bundled public job-search-next token (rotate if Glassdoor returns 403s).
- `GLASSDOOR_LOCATION_ID` — default `11047` (US, STATE). Change to target a region.
- `GLASSDOOR_CF_GRACE_MS` — browser-fallback Cloudflare grace.

### Monster — browser + appsapi-JSON parse + retry  ⚠️ needs clean IPs
Monster is DataDome-gated. The scraper warms up monster.com (so DataDome's JS mints a `datadome` cookie), then **parses jobs straight from the appsapi JSON** the page fetches (robust — not DOM-card-dependent). The appsapi returns 200 + jobs **on a clean IP**; DataDome 403s **flagged/hammered IPs**, and the block is **per-IP**.
- `MONSTER_MAX_ATTEMPTS` — default `4`. On each DataDome block (403 / "0 cards"), it cools that IP and retries on the next one. With a healthy pool of clean IPs, a few attempts → high success.
- **Requirement: fresh/clean residential (ideally mobile) IPs.** An IP that's been hammered gets DataDome-flagged and returns 403 until it cools (~hour of no traffic). If all pooled IPs are flagged, Monster returns 0 until they recover or you add fresh ones. This is IP hygiene, not a code setting.
- No paid unlocker, no Python. `camoufox-js` (pure-Node, higher DataDome pass-rate, runs headless) is an available engine upgrade if Monster reliability ever needs a boost.

---

## Global knobs
- `SCRAPER_HEADLESS` — default headless; `false`/`0`/`no`/`off` → **headful** (a stronger stealth posture for DataDome/Cloudflare; on Linux use `xvfb-run -a`).
- `SCRAPER_BLOCK_RESOURCES` — block images/media/fonts to cut proxy bandwidth (`SCRAPER_BLOCK_RESOURCE_TYPES` to customize). Measured ~20% bandwidth savings.
- `SCRAPER_STRICT_EMPTY` — treat unconfirmed-empty results as a failure (block signal) rather than a genuine 0.
- `PROXY_BLOCK_COOLDOWN_MS` — per-IP cooldown after a block (default 60000).

## Deploy checklist
1. `git pull` (Windows: restart after pull).
2. Put `config/proxies.txt` (fresh, clean residential IPs) and `config/credentials.json` (LinkedIn cookies) on the box — both git-ignored.
3. Pre-warm hidden deps: launch once so CloakBrowser (~350 MB) and the node-tls-client Go lib download.
4. Indeed/Glassdoor/Dice/LinkedIn work immediately. Monster works as long as the pool has clean IPs.
5. Verify: hit `/healthz` and run one scrape per platform.

See also: `docs/antibot-bypass-plan.md` (the research + why each method was chosen).
