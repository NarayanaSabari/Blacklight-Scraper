# Blacklight Scraper — Production Deployment Runbook

Pre-flight guide for pulling `main` into production and running it. All 6
platforms are hardened (398 unit tests). Read §2 (browsers) and §6
(persistent state) carefully — the CloakBrowser binary download is the
most-missed prerequisite.

---

## 1. Platform status

| Platform | Auth model | Anti-bot | Browser engine | Live-verified | Verdict |
|---|---|---|---|---|---|
| **Dice** | Anonymous | None | CloakBrowser | ✅ 20 runs, 997 jobs, 0 bad | Ready |
| **Monster** | Anonymous | DataDome + 60-min cooldown | CloakBrowser | ✅ cooldown fired live | Ready (§8) |
| **Glassdoor** | Anonymous | Geo-pin + classifier | CloakBrowser | ✅ 14 runs, 98.8% US | Ready (§8) |
| **Indeed** | Profile (optional, `indeed:login`) | Cloudflare + 60-min cooldown | CloakBrowser | ✅ anon page-1 + persistent-path wiring; ⚠️ full pagination needs a real login | Ready anon; full needs `indeed:login` + smoke |
| **TechFetch** | Anonymous-first | None | CloakBrowser | ✅ 40 jobs/run; ⚠️ login fallback unverified | Ready anon; fallback needs smoke |
| **LinkedIn** | Cookie (required) | Cloudflare/auth-wall | CloakBrowser | ⚠️ not run (no cookies present) | Code-ready; needs cookies + smoke |

LinkedIn is the only platform without `strictEmpty` — intentional (tuned in the server-robustness slice).

---

## 2. Browser engine — CloakBrowser (ALL 6 scrapers)

All six scrapers run on **CloakBrowser** (stealth Chromium) — one engine, fleet-wide. TechFetch was migrated off playwright-extra so there's no longer a second stack. Playwright's own chromium is not used by any active scraper (the only remaining importer, `src/core/browser.js`, is dead code).

| Engine | Scrapers | How the binary is provisioned |
|---|---|---|
| **CloakBrowser** (stealth Chromium) | LinkedIn, Monster, Dice, Indeed, Glassdoor, TechFetch | **Auto-downloaded (~350 MB) from GitHub on first `launch()`** → cached at `~/.cloakbrowser/`. NOT installed by `npm ci`, NOT by `playwright install`. |

> **CRITICAL:** On a fresh/firewalled host, `npm ci` succeeding is NOT enough. The
> first scrape of ANY platform triggers a ~350 MB download from
> `github.com/CloakHQ/cloakbrowser/releases/download` (plus an
> `api.github.com` release check + a GeoLite2 mmdb). If egress is blocked or
> `~/.cloakbrowser/` isn't persisted, all 6 scrapers fail or hang.

**Pre-warm the CloakBrowser binary (recommended, avoids a slow/failed first scrape):**
```bash
node -e "import('cloakbrowser').then(async m => { const b = await m.launch({headless:true}); await b.close(); })"
```

**Locked-down / air-gapped prod — relevant env vars:**
| Var | Use |
|---|---|
| `CLOAKBROWSER_CACHE_DIR` | move the ~350 MB cache off `$HOME` (e.g. a mounted volume) |
| `CLOAKBROWSER_BINARY_PATH` | point at a pre-staged binary — skips the download |
| `CLOAKBROWSER_DOWNLOAD_URL` | mirror the binary internally instead of GitHub |
| `CLOAKBROWSER_AUTO_UPDATE` | control auto-update version checks |

---

## 3. Host prerequisites

```bash
node --version                  # must be v24.x
npm ci                          # from lockfile — stale node_modules breaks startup
# All 6 scrapers use CloakBrowser, which self-provisions on first launch —
# pre-warm it per §2 (no `playwright install` needed for any scraper).
# (Linux also needs headless-Chromium libs: libnss3, libatk, libgbm, etc.)
# CloakBrowser self-provisions on first launch — pre-warm per §2.
```

---

## 4. Configuration — `config/credentials.json`

Git-ignored. Copy `config/credentials.example.json` and fill in:

```jsonc
{
  "blacklight":         { "apiUrl": "...", "apiKey": "..." },  // REQUIRED: job queue + telemetry
  "scraperCredentials": { "apiUrl": "...", "apiKey": "..." },  // optional: remote credential API
  "linkedin":           { /* session cookies */ },             // for LinkedIn
  "indeed":             { "credentials": [] },                  // for Indeed full pagination
  "techfetch":          { "email": "...", "password": "..." }   // only if TechFetch paywalls
}
```

**Two modes (auto):** `NODE_ENV=production` + `scraperCredentials` set → remote credential API; otherwise → local credentials from this file. Without `blacklight`, the queue + auto-checker are disabled (manual `/scrape` only).

---

## 5. Credentials to provision

| Platform | Needs | Without it |
|---|---|---|
| Dice / Monster / Glassdoor / TechFetch | nothing | Full function (TechFetch credential only used if search bounces to login) |
| Indeed | `npm run indeed:login` once (persistent profile, headed) | Page-1 only (~16 jobs) until you log in; then full ~200. No login + no `INDEED_ALLOW_ANONYMOUS=1` → `AuthError`. |
| LinkedIn | `npm run linkedin:login` once (persistent profile, headed) | Cannot scrape — throws `AuthError`. Session persists in-profile + rotates; re-login when it expires. |

---

## 6. Persistent filesystem state — MUST survive restarts

```
~/.cloakbrowser/                    ~350 MB stealth Chromium (ALL 6 scrapers)  ← most-missed
~/.blacklight-monster-cooldown      Monster DataDome cooldown marker
~/.blacklight-indeed-cooldown       Indeed Cloudflare cooldown marker
~/.blacklight-glassdoor-cooldown    Glassdoor Cloudflare cooldown marker
~/.blacklight-techfetch-cooldown    TechFetch stub-page/block cooldown marker
~/.blacklight-linkedin-profile/     persistent LinkedIn browser profile (npm run linkedin:login)
~/.blacklight-indeed-profile/       persistent Indeed browser profile   (npm run indeed:login)
~/.blacklight-scraper-backups/      LinkedIn cookie backups (0600)
```

Ephemeral container → volume-mount these. Otherwise: re-download the 350 MB browser, re-trigger anti-bot blocks, and re-auth LinkedIn on every cold start.

---

## 7. Environment variables (optional; safe defaults)

`PORT` (3001) · `NODE_ENV` (production) · `SCRAPER_MODE` (`daemon` = offline alerts) · `LOG_LEVEL` · `INSTANCE_ID` · `QUEUE_CHECK_INTERVAL_MS` (30000) · `MONSTER_BLOCK_COOLDOWN_MIN` / `INDEED_BLOCK_COOLDOWN_MIN` / `GLASSDOOR_BLOCK_COOLDOWN_MIN` / `TECHFETCH_BLOCK_COOLDOWN_MIN` (60) · `INDEED_ALLOW_ANONYMOUS` (`1` = Indeed page-1 without a credential) · `LINKEDIN_MAX_CONCURRENCY` (2 — concurrent LinkedIn tabs on the one account; 1 = serialize, 3 = push harder/ban-risk; read at process start) · `SCRAPER_DEFAULT_LOCATION` · CloakBrowser vars (§2).

---

## 8. Pre-flight checklist (ordered)

```
[ ] 1. git pull   →  RESTART the node process after pulling
[ ] 2. npm ci
[ ] 3. pre-warm CloakBrowser (§2 one-liner)     (all 6 scrapers — one engine)
[ ] 4. config/credentials.json → blacklight API filled in
[ ] 5. persist the 5 paths in §6 (or volume-mount)
[ ] 6. node server.js  →  curl localhost:3001/healthz  →  200 + gitSha matches deployed commit
[ ] 7. smoke the 4 anonymous platforms (no creds):
         npm run dice:test-scrape -- "software engineer"
         npm run monster:test-scrape -- "software engineer"
         npm run glassdoor:test-scrape -- "software engineer"
         npm run techfetch:test-scrape -- "java developer"
       → each: exit 0, jobs > 0, 0 bad rows
[ ] 8. log in to the two profile platforms (headed, once each — needs a display;
       on a headless host run on a workstation + copy the profile dir, or use VNC):
         npm run linkedin:login    then  npm run linkedin:test-scrape
         npm run indeed:login      then  npm run indeed:test-scrape -- "software engineer"
       (Indeed also runs anonymously at page-1 with INDEED_ALLOW_ANONYMOUS=1 if you skip login)
```

Harness exit codes: `0` ok · `2` threw · `3` bad-row rate too high · `4` blocked/cooldown/auth-needed.

---

## 9. Known limitations & operational notes

- **Monster (DataDome):** single IP blocks after ~10 cumulative requests → quiet for 60 min. Cooldown prevents the wasted-cascade, not the block. Fine for modest bursts; heavy volume wants residential proxy rotation (deferred). Self-clears.
- **Glassdoor (anonymous depth):** title/company/location/URL 100%; salary + rating sparse, descriptions partial on sponsored listings — Glassdoor gates rich data behind login by design. Breadth, not depth. (Confirmed not a bug.)
- **IP geography:** validated from a non-US IP. Glassdoor handles it (geo-pin); Indeed/Monster returned US jobs. Different prod region → re-run §8 smokes.
- **LinkedIn cookies expire** — recurring task; `/health/linkedin?probe=1` does a real in-session check.
- **Two unverified code paths** (no creds to test here): Indeed full pagination, TechFetch login fallback. Reviewed + reasoned; step 9 is their first real exercise.

---

## 10. Monitoring

| Endpoint | Use |
|---|---|
| `GET /healthz` | liveness + `gitSha` (confirm prod is on the deployed commit) |
| `GET /health/linkedin?probe=1` | real LinkedIn session probe |
| `GET /metrics` | Prometheus — `scraper_url_quality_total`, block/cooldown counters, per-platform success |

Watch `scraper_url_quality_total{quality="empty"|"profile_in"}` and the `BlockedError` counters — a rise means a DOM drifted or an IP got flagged.
