# Blacklight Scraper — Production Deployment Runbook

Pre-flight guide for pulling `main` into production and running it. All 6
platforms are hardened (648 tests: 648 passing). Read §2 (browsers) and §6
(persistent state) carefully — the CloakBrowser binary download is the
most-missed prerequisite.

---

## 1. Platform status

| Platform | Auth model | Anti-bot | Browser engine | Live-verified | Verdict |
|---|---|---|---|---|---|
| **Dice** | Anonymous | None | CloakBrowser | ✅ 20 runs, 997 jobs, 0 bad | Ready |
| **Monster** | Anonymous | DataDome + rotating ISP/residential IPs | CloakBrowser 0.5.2 | ✅ clean-IP path + retry wiring | Ready with a clean proxy pool |
| **Glassdoor** | Anonymous `/graph` API | Cloudflare warm-up + per-IP detail-page rate limit | node-tls-client + CloakBrowser 0.5.2 | ✅ warmed API + description enrichment | Ready with direct discovery and pooled detail IPs |
| **Indeed** | Profile (optional, `INDEED_PROFILE_DIR`) | Cloudflare + 60-min cooldown | CloakBrowser | ✅ anon page-1 + persistent-path wiring; ⚠️ full pagination needs a pre-existing profile | Ready anon; full needs a supplied profile + smoke |
| **TechFetch** | Anonymous-first | None | CloakBrowser | ✅ 40 jobs/run; ⚠️ login fallback unverified | Ready anon; fallback needs smoke |
| **LinkedIn** | Persistent-profile cookie (required) | Cloudflare/auth-wall | CloakBrowser for login/template capture | ✅ 337 production roles, 5,560 posts, 0 failures | Ready after profile + template setup |

LinkedIn now arms the registry's `strictEmpty`: permalinks arrive in the search
payload, so a genuine empty result is distinguishable from a silent block.
`SCRAPER_STRICT_EMPTY` remains the fallback environment flag for callers
without a registry override.

---

## 2. Browser engine — CloakBrowser

All browser-backed paths run on **CloakBrowser 0.5.2** (stealth Chromium) - one engine, fleet-wide. LinkedIn uses it for operator login, RSC template capture, and cached profile-cookie reads; its scrape requests are browserless. Glassdoor's API discovery additionally uses `node-tls-client`; its description enrichment uses CloakBrowser. TechFetch was migrated off playwright-extra so there's no longer a second active browser stack. Playwright's own Chromium is not used by any active scraper.

| Engine | Scrapers | How the binary is provisioned |
|---|---|---|
| **CloakBrowser 0.5.2** (stealth Chromium) | LinkedIn login/template capture/profile-cookie reads, Monster, Dice, Indeed, Glassdoor detail enrichment, TechFetch | **Auto-downloaded (~350 MB) from GitHub on first `launch()`** → cached at `~/.cloakbrowser/`. NOT installed by `npm ci`, NOT by `playwright install`. |

> **CRITICAL:** On a fresh/firewalled host, `npm ci` succeeding is NOT enough for
> browser-backed paths. The first browser launch triggers a ~350 MB download from
> `github.com/CloakHQ/cloakbrowser/releases/download` (plus an
> `api.github.com` release check + a GeoLite2 mmdb). If egress is blocked or
> `~/.cloakbrowser/` isn't persisted, browser-backed operations fail or hang.

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
node --version                  # must be v22.19.0 or newer
npm ci                          # from lockfile — stale node_modules breaks startup
# Browser-backed paths use CloakBrowser, which self-provisions on first launch —
# pre-warm it per §2 (no `playwright install` needed).
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
  "linkedin":           { /* local lease marker; auth lives in the profile */ }, // for LinkedIn
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
| Indeed | Pre-existing profile at `INDEED_PROFILE_DIR` (login helper removed) | Page-1 only (~16 jobs) without a profile; full ~200 with one. No profile + no `INDEED_ALLOW_ANONYMOUS=1` → `AuthError`. |
| LinkedIn | `npm run linkedin:login` once, then `npm run linkedin:rsc-template` (persistent profile, headed setup) | Cannot scrape - throws `AuthError`. Session persists in-profile; re-login when it expires. |

---

## 6. Persistent filesystem state — MUST survive restarts

```
~/.cloakbrowser/                    ~350 MB stealth Chromium for browser-backed paths  ← most-missed
~/.blacklight-monster-cooldown      Monster DataDome cooldown marker
~/.blacklight-indeed-cooldown       Indeed Cloudflare cooldown marker
~/.blacklight-glassdoor-cooldown    Glassdoor Cloudflare cooldown marker
~/.blacklight-techfetch-cooldown    TechFetch stub-page/block cooldown marker
~/.blacklight-linkedin-profile/     persistent LinkedIn browser profile (npm run linkedin:login)
~/.blacklight-indeed-profile/       persistent Indeed browser profile   (bring-your-own; login helper removed)
```

Ephemeral container → volume-mount these. Otherwise: re-download the 350 MB browser, re-trigger anti-bot blocks, and re-auth LinkedIn on every cold start.

---

## 7. Environment variables (optional; safe defaults)

The complete variable reference, including LinkedIn profile and headless
controls and proxy settings, is [`.env.example`](../.env.example).
Host-oriented configuration is covered in [SETUP.md](SETUP.md), while
CloakBrowser launch seats and licence-key configuration are maintained in the
[session-seat section of the scraper runbook](scraper-runbook.md#cloakbrowser-session-seats).

---

## 8. Pre-flight checklist (ordered)

```
[ ] 1. git pull   →  RESTART the node process after pulling
[ ] 2. npm ci
[ ] 3. pre-warm CloakBrowser (§2 one-liner)     (browser-backed paths)
[ ] 4. config/credentials.json → blacklight API filled in
[ ] 5. persist the paths in §6 (or volume-mount)
[ ] 6. node server.js  →  curl localhost:3001/healthz  →  200 + gitSha matches deployed commit
[ ] 7. log in to LinkedIn (headed — needs a display; on a headless host run on a
       workstation + copy the profile dir, or use VNC):
         npm run linkedin:login
       (Indeed has no login helper — it runs anonymously at page-1 with
        INDEED_ALLOW_ANONYMOUS=1, or supply a pre-existing profile at INDEED_PROFILE_DIR)
[ ] 8. capture the LinkedIn RSC request template on that host:
         npm run linkedin:rsc-template
[ ] 9. verify end-to-end via the live queue (the per-platform smoke harness has
       been removed — verification is now the real queue flow):
         node server.js  → watch the log for a claim, then confirm in
         central.qpeakhire.com → Scraper → Active Sessions: a `running` row for
         this host with jobs submitted (count > 0, 0 bad rows)
```

---

## 9. Known limitations & operational notes

- **Monster (DataDome):** the appsapi can be suppressed after a page loads. The scraper records this as `datadome-suppressed`, cools the current IP, and retries on another pool IP. Keep the 3–5 second warm-up and inter-page pacing.
- **Glassdoor:** `/graph` discovery requires a warmed direct session. Job descriptions come from concurrent server-rendered detail pages through the separate `glassdoor-jd` lease; a per-IP denial stops enrichment early and leaves some descriptions as `N/A`.
- **IP geography:** validated from a non-US IP. Glassdoor handles it (geo-pin); Indeed/Monster returned US jobs. Different prod region → re-run §8 smokes.
- **LinkedIn cookies expire** — recurring task; `/healthz` reports whether a fresh profile session jar is cached. The RSC scraper reads that jar and does not inject cookies into a page.
- **Two unverified code paths** (no creds to test here): Indeed full pagination, TechFetch login fallback. Reviewed + reasoned; step 9 is their first real exercise.

---

## 10. Monitoring

| Endpoint | Use |
|---|---|
| `GET /healthz` | liveness, identity, `gitSha`, and cached LinkedIn session state |
| `GET /metrics` | Prometheus — `scraper_url_quality_total`, block/cooldown counters, per-platform success |

Watch `scraper_url_quality_total{quality="empty"|"profile_in"}` and the `BlockedError` counters - a rise means a parser drifted or an IP got flagged.

For diagnosing a live host rather than deploying one, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
