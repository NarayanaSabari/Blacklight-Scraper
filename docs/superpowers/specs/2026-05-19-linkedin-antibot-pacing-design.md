# Design — LinkedIn anti-bot pacing (#4 from the 2026-05-19 diagnosis)

> Status: approved 2026-05-19. Source of truth for the implementation plan.
> Scope: **scraper-only**, all in `scrapers/linkedin.js`. No orchestrator / backend / proxy changes. Decomposed from the 5-action diagnosis; #1/#2 = ops, #3 = already shipped (PR #7), #5 = backend handoff. This spec is **#4 only**.

## 1. Problem & goal

Root cause (diagnosis §2/§3): LinkedIn invalidates the automated session server-side after ~1 query. The scraper runs **all** backend-supplied AI boolean variants (~3) in one browser session, re-navigating to `/feed/` for an auth check before each, scrolling up to 100 posts over up to **150** attempts at ~2–3 s each, with only 8–12 s between queries. The session is killed after query 1 and, with a single LinkedIn credential, the platform starves.

Goal: reduce per-session anti-bot surface so the session survives a full scrape, **without** touching the orchestrator/backend. Approved strategy: **one randomly-chosen variant per session + human-like, jittered, env-tunable pacing.**

## 2. Architecture

Repo-proven pattern: small **pure, exported, unit-tested** helpers (like `canPasswordLogin`, `linkedinPageState`) + thin wiring in the scrape/scroll loops + env knobs read once into the `CONFIG` block (like `STRICT`, `LINKEDIN_HEADLESS`). Three components.

### Component A — one random variant per session

**A1. Pure helper** (new top-level export in `scrapers/linkedin.js`):
```
pickSessionQuery(queries, rng = Math.random) → string | null
```
- Non-empty array → the element at `Math.floor(rng() * queries.length)` (uniform).
- `null` / non-array / empty → `null`.

**A2. Wiring.** `scrapers/linkedin.js:1176-1180` currently:
```js
const aiQueries = Array.isArray(options.searchQueries) && options.searchQueries.length > 0 ? options.searchQueries : null;
const queriesToRun = aiQueries || [buildBooleanSearchQuery(jobTitle)];
CONFIG.searchQuery = queriesToRun[0];
```
Becomes: pick exactly one — `const chosen = pickSessionQuery(aiQueries) ?? buildBooleanSearchQuery(jobTitle);` then `const queriesToRun = [chosen];` and keep `CONFIG.searchQuery = queriesToRun[0];`. Replace the multi-variant logging (1183-1189) with a single line recording the **chosen original index/total** for coverage observability, e.g. `🎲 Variant [k/N] selected for this session: <query>` (the boolean query text is already logged today — no new sensitive output) and keep the legacy-template log path for the no-`aiQueries` case.

**Consequences (free, no extra code):** the existing `for (let qi = 0; qi < queriesToRun.length; qi++)` loop (`:1263`) now iterates exactly once, so the per-query `/feed/` re-auth bounce and the `if (qi > 0) … await randomDelay(8000,12000)` inter-query delay (`:1270-1277`) **never execute** — eliminated structurally, no risk. `perQueryYield`/dedup/`seenIdsAcrossQueries` still work (one entry). Over repeated orchestrator cycles + backend requeue, random selection covers all variants probabilistically (the chosen strategy's coverage mechanism) and adds query diversity.

### Component B — human-like, jittered scroll pacing + tighter early-stop

**B1. Pure helper:**
```
nextScrollDelay(scrollIndex, rng, cfg) → ms
```
where `cfg = { min, max, pauseEvery, pauseMin, pauseMax }`. If `scrollIndex > 0 && scrollIndex % pauseEvery === 0` → a "reading pause" `Math.round(pauseMin + rng()*(pauseMax - pauseMin))`; else a base delay `Math.round(min + rng()*(max - min))`. Pure/deterministic given injected `rng` → unit-testable; the `await wait(ms)` stays in the loop.

**B2. Wiring in `extractPosts`:**
- `scrapers/linkedin.js:677` `const maxScrolls = 150;` → `const maxScrolls = CONFIG.maxScrolls;` (default **60**).
- `scrapers/linkedin.js:1080` `if (noNewPostsCount >= 5)` → `if (noNewPostsCount >= CONFIG.noProgressStop)` (default **4**).
- `scrapers/linkedin.js:1102` `await randomDelay(CONFIG.scrollDelay, CONFIG.scrollDelay + 1000);` → `await wait(nextScrollDelay(scrollAttempts, Math.random, CONFIG.scrollPacing));`.
- `maxPosts` stays 100 (rarely binding — this incident's query yielded 12). The legacy `CONFIG.scrollDelay` (2000) field is left in place untouched but is **no longer read** on the scroll path (superseded by `CONFIG.scrollPacing`); `scrollPacing.min` comes solely from `LINKEDIN_SCROLL_MIN_MS` (default 2500, see C), independent of the legacy field.

### Component C — env-tunable knobs (codebase convention)

**C1. Pure helper:**
```
readPacingConfig(env = process.env) → { maxScrolls, noProgressStop, scrollPacing:{min,max,pauseEvery,pauseMin,pauseMax} }
```
Integer-parse with defaults (mirrors `env.js::toInt` discipline — non-numeric/absent → default; never throws):

| env var | default |
|---|---|
| `LINKEDIN_MAX_SCROLLS` | 60 |
| `LINKEDIN_NOPROGRESS_STOP` | 4 |
| `LINKEDIN_SCROLL_MIN_MS` | 2500 |
| `LINKEDIN_SCROLL_MAX_MS` | 5000 |
| `LINKEDIN_SCROLL_PAUSE_EVERY` | 6 |
| `LINKEDIN_SCROLL_PAUSE_MIN_MS` | 8000 |
| `LINKEDIN_SCROLL_PAUSE_MAX_MS` | 15000 |

**C2. Wiring.** At module load (next to `const STRICT = …`, `scrapers/linkedin.js:34`), and fold the result into the `CONFIG` object (`:44-54`) as `CONFIG.maxScrolls`, `CONFIG.noProgressStop`, `CONFIG.scrollPacing`. Defaults are gentler than today (slower, paused, fewer scrolls) but still functional; ops tunes per host without code changes.

## 3. Data flow

lease → `pickSessionQuery(aiQueries)` → **one** variant → single `navigateToSearch` (one `ensureLoggedIn`) → `extractPosts`: scroll loop bounded by `CONFIG.maxScrolls`, delay `nextScrollDelay(...)` (jitter + periodic reading pause), early-stop after `CONFIG.noProgressStop` no-progress scrolls → verdict (unchanged) → on success, the already-merged cookie write-back.

## 4. Error handling

Unchanged. AuthError / BlockedError / DomChangedError taxonomy, the §5 cookie-only-logout fix, STRICT/`no_results` handling, and the `{jobs,emptyConfirmed}` contract are all untouched — pacing changes never alter verdict logic. Fewer scrolls / fewer queries only reduce activity volume, not classification.

## 5. Testing

**Unit (pure, `test/scrapers/`):**
- `pickSessionQuery`: `null`/`[]`/non-array → `null`; single-element → that element; uniform selection via an injected deterministic `rng` (e.g. `rng=()=>0` → index 0; `rng=()=>0.99` → last index); does not mutate input.
- `nextScrollDelay`: base value within `[min,max]`; at `scrollIndex % pauseEvery === 0` (index>0) within `[pauseMin,pauseMax]`; index 0 is a base delay (not a pause); deterministic for a fixed `rng`.
- `readPacingConfig`: all-absent → exact documented defaults; valid overrides parsed to ints; non-numeric/garbage → default (never throws); returns the nested `scrollPacing` shape `nextScrollDelay` expects.

**Empirical:** the established local headed run confirms the wired path (one variant chosen + logged, scroll loop paces/early-stops, scrape completes, verdict unchanged).

**Honest caveat (stated, not worked around):** anti-bot *effectiveness* — "LinkedIn no longer kills the session after ~1 query" — is **inherently not unit-testable** and cannot be confirmed in this environment (no valid prod credential; effectiveness is a property of LinkedIn's live anti-bot, observable only as production session-survival over time). The spec/plan claim it as *expected*, to be confirmed by ops watching prod `last_success_at` / starvation rate after rollout — it is not asserted as proven.

## 6. Non-goals (YAGNI)

No orchestrator/backend variant-dispatch changes; no proxy/residential-IP or persistent-browser-profile work (infra/ops; persistent-profile overlaps #3 cookie continuity — separate); no elaborate mouse/keyboard choreography (cloakbrowser `humanize:true` already provides base stealth); auth-detection mechanism (`ensureLoggedIn` → `/feed/`) unchanged; `maxPosts` cap unchanged; no change to dedup, query-building, or the BaseScraper return contract.

## 7. Acceptance criteria

1. Per lease, exactly **one** variant runs (randomly chosen when ≥1 `searchQueries`; falls back to `buildBooleanSearchQuery` when none); the chosen variant + its original `[k/N]` is logged; the inter-query delay and per-query re-auth no longer execute.
2. Scroll loop honors `CONFIG.maxScrolls` (def 60), early-stops after `CONFIG.noProgressStop` (def 4) no-progress scrolls, and waits `nextScrollDelay(...)` (jittered base + periodic longer pause) between scrolls.
3. All seven env knobs override their defaults; absent/garbage → defaults; nothing throws on bad env.
4. Pure helpers unit-tested in `test/scrapers/`; `npm test` green; no change to verdict/`{jobs,emptyConfirmed}`/error taxonomy.
5. Effectiveness explicitly documented as "expected, confirm in prod" — not claimed proven.
