# Scraper Data-Quality Report

## Monster breakthrough — 2026-06-18 (`where` bug)

**`where=United States` was itself causing the DataDome 403**, not just the IP.
Monster's appsapi can't geocode a country-level `where`. Verified live on a warmed
profile: `where=United States` → appsapi 403 / "no jobs"; **`where=` empty → appsapi
200 + 36 jobs**. Fixed in `searchUrl` (country-level → nationwide). Working recipe:
`npm run monster:warm` (headed, operator loads page once to mint the datadome cookie)
→ scrape with `MONSTER_PROFILE_DIR` + `MONSTER_HEADLESS=false` + the where-fix.
Monster's data (when it returns) is the **richest**: full descriptions + structured
salary min/max + city/state. Caveat: still IP-sensitive — the appsapi re-burns within
a few hits; needs a rested/fresh sticky IP (`MONSTER_STICKY_INDEX`) + a fresh warm.

## Full re-run — 2026-06-18 (all 5 scrapers)

**Status**
| Platform | Result | Notes |
|---|---|---|
| **Dice** | ✅ 40 jobs (34s) | direct; richest data |
| **Glassdoor** | ✅ 30 jobs (2s) | `/graph` API; header-only depth |
| **Indeed** | ✅ 40 jobs (2s) | **FIXED this run** — proxy path was broken (`fetch failed: invalid onRequestStart method`, an undici/global-fetch version mismatch); now uses undici's own `fetch`. Silently broke Indeed in prod (always proxied). |
| **LinkedIn** | ❌ no credential | `config/credentials.json` absent on this machine — not a code fault; works once cookies are present. |
| **Monster** | ❌ DataDome block | The 3 Decodo IPs are **still flagged after ~19.5h** of cooldown — a deep, long-lived per-IP flag. Confirms Monster needs **fresh** IPs, not just waiting. |

**Field fill rates (working platforms; sample query "software engineer"/US)**
| Field | Dice (40) | Glassdoor (30) | Indeed (40) |
|---|---|---|---|
| job.id / title / url / postedDate | 100% | 0%(id)/100% | 100% |
| job.description | 100% | **0%** | 100% |
| company.name | 100% | 100% | ~98% |
| company.logoUrl | 100% | 0% | 0% |
| location.formatted | 93% | 100% | 100% |
| location.city / state / country | 93% | 57% / 57% / 20% | 100% / ~93% / 100% |
| compensation.salary + Min/Max | 18% | 0% | ~40–70%† |
| compensation.period | 0%‡ | 0% | ~78% |
| employment.type | 100% | 0% | 0% |
| experience.requiredSkills | 80% | 0% | 0% |
| experience.level (inferred) | 13% | 37% | 18% |

† Indeed salary fill varies by which roles are posted (38% this run, 70% earlier). ‡ Dice carries
period inside `unitText`; only set when JSON-LD includes it.

**Key takeaways**
1. **3 of 5 scrapers fully working** (Dice, Glassdoor, Indeed) — Indeed restored this run.
2. **LinkedIn** is code-fine; just needs its cookie file deployed.
3. **Monster** remains IP-blocked — ~19.5h didn't clear the flag; **fresh residential/mobile IPs are required** (cooldown alone is not reliably enough).
4. **Enrichment is holding** across runs: structured location ~93–100% (Dice/Indeed), salary min/max now populated, experience level inferred everywhere.
5. **No duplicate IDs** in any result set.

---
*(Original baseline + enrichment detail below.)*

> **UPDATE (commit 70b5885): enrichment shipped.** Structured salary + location were
> being extracted then discarded (Indeed) or never derived; now lifted on live samples:
> Indeed salaryMin/Max **0→70%**, period **→78%**, city/state/country **0→100/93/100%**,
> experience.level **0→50%**; Glassdoor city/state **0→53%**; Dice country **→95%**;
> experience.level inferred for all (20–50%). Details at the bottom. The tables below
> are the *original* baseline.


> Generated 2026-06-17 from **live samples**: Indeed 40 jobs, Glassdoor 30, Dice 40
> (query: "software engineer" / "United States"). LinkedIn not audited (needs auth
> cookies); Monster not audited live (proxy IPs burned) — its profile is inferred
> from the verified appsapi parser. All fields measured against the normalized
> master schema (`src/core/normalize.js`).

## Field fill rates (% of jobs with a real, non-`N/A` value)

| Field | Indeed (40) | Glassdoor (30) | Dice (40) |
|---|---|---|---|
| job.id | 100% | **0%** | 100% |
| job.title | 100% | 100% | 100% |
| job.description | 100% (~4.5k chars) | **0%** | 100% (~4.3k chars) |
| job.url | 100% | 100% | 100% |
| job.postedDate | 100% | 100% | 100% |
| company.name | 98% | 100% | 100% |
| company.rating | **0%** | **0%** | **0%** |
| company.logoUrl | 0% | 0% | 100% |
| location.formatted | 100% | 100% | 95% |
| location.city/state (structured) | **0%** | **0%** | 95% |
| compensation.salary (text) | 68% | **0%** | 12% |
| compensation.salaryMin/Max (structured) | **0%** | **0%** | **0%** |
| employment.type | **0%** | **0%** | 100% |
| experience.requiredSkills | **0%** | **0%** | 85% |
| experience.level | **0%** | **0%** | **0%** |

*(`location.remote` and `employment.easyApply` show 100% but are booleans that
default to `false`/derived — not a genuine signal, excluded above.)*

No duplicate job IDs or URLs were found within any platform's result set — **dedup is clean**.

## Per-platform quality profile

- **Dice — RICHEST.** Full core + ~4.3k-char descriptions, company logo, structured
  city/state, employment type (`full_time`), and skills on 85% of jobs
  (e.g. "Testing, Management, Project Lifecycle Management…"). Weak spots: salary
  only 12% (text like `$90,000 - $125,000`), no company rating, no experience level.

- **Indeed — STRONG CORE.** id, title, full ~4.5k-char description, url, date all 100%;
  salary on 68% and nicely structured as text (`USD 85000–100000 / year`). Missing:
  skills, employment type, company rating/logo, structured city/state.

- **Glassdoor — SHALLOW (biggest gap).** Only the search-listing **header**:
  title, company, location, url, posted-date (all 100%). **No description (0%, 0 chars),
  no job id, no salary, no skills, no employment type.** The `/graph` API path returns
  list-level data only; it never fetches the job detail.

- **Monster — (inferred, not live).** The verified appsapi parser
  (`mapAppsapiJobResult`) yields the **most complete** record: title, company, location,
  full description, posted-date, **and structured salary min/max** (from `baseSalary`).
  Currently uncollectable — proxy IPs DataDome-burned (needs a clean IP).

- **LinkedIn — not audited** (requires logged-in cookies in `config/credentials.json`).

## Key findings / issues

1. **Glassdoor returns header-only data** — no description/salary/skills/id. This is the
   single largest quality gap; downstream consumers get a thin record.
2. **`compensation.salaryMin/Max` is never populated (0% everywhere).** Indeed and Dice
   carry pay in the `salary` *text* field, but `normalize.js` doesn't parse it into the
   structured min/max/period fields. (Monster's parser is the only one that fills them.)
3. **`company.rating` = 0%** and **`experience.level` = 0%** across all platforms — never captured.
4. **Skills only from Dice** (85%); Indeed/Glassdoor 0%.
5. **Employment type only from Dice**; Indeed/Glassdoor `N/A`.
6. **Company metadata** (logo/profile/HQ/size/founded/techStacks) is sparse — only Dice fills logo.
7. **Indeed API failed through the proxy** ("fetch failed", instant) but works **direct** —
   a proxy-reliability concern for the Indeed path worth investigating.

## Recommendations (priority order)

1. **Glassdoor: fetch job detail** (detail page or the job-detail API) to fill
   description/salary/skills — currently the weakest source. Or document it as list-only. *(open)*
2. ~~**Parse salary text → `salaryMin`/`salaryMax`/`period`**~~ — ✅ **DONE** (70b5885): plus
   Indeed/Monster now pass their already-extracted structured salary instead of discarding it.
3. **Capture `company.rating`** (Glassdoor/Indeed expose it) *(open)*; **`experience.level`**
   ✅ now inferred from title in `normalize.js` (20–50%).
4. **Indeed:** investigate the proxy "fetch failed" (works direct) — possible proxy egress issue. *(open)*
5. **Monster:** once a clean IP is available, it provides the richest structured data
   (incl. salary min/max) — worth prioritizing the fresh-IP fix. *(open)*

## Enrichment applied (commit 70b5885) — after vs. baseline

| Field | Indeed | Glassdoor | Dice |
|---|---|---|---|
| compensation.salaryMin/Max | 0% → **70%** | 0% (no salary) | 0% → **13%** |
| compensation.period | — → **78%** | 0% | — |
| location.city | 0% → **100%** | 0% → **53%** | 95% |
| location.state | 0% → **93%** | 0% → **53%** | 95% |
| location.country | 0% → **100%** | → **17%** | → **95%** |
| experience.level | 0% → **50%** | 0% → **20%** | 0% → **20%** |

How: (a) Indeed-api & Monster now forward the structured `baseSalary` min/max + address
parts they already fetch (previously only stringified); (b) `normalize.js` adds three pure,
unit-tested helpers — `parseSalaryText`, `parseLocationText`, `inferExperienceLevel` — that
fill structured fields as a fallback for any scraper that only provides text. Scraper-supplied
structured data always takes precedence over parsing. Still open: Glassdoor depth (description/
salary/skills), `company.rating`, and structured salary for Dice's text-only listings.
