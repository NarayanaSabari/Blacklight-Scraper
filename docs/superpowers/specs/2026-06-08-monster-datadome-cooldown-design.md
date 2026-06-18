# Monster — DataDome cooldown + accurate block classification

**Date:** 2026-06-08
**Scope:** Two code-side mitigations for the DataDome failure cascade observed in the 30-min Monster stress test: (1) inspect the appsapi response body to reclassify "empty payload" as `soft_blocked`/`BlockedError` (was misclassified as `dom_changed`); (2) cross-run file-backed cooldown that short-circuits subsequent Monster runs after a block, before the browser launches.

## Goal

Prevent the "9 OK → 1 DomChangedError → 2 NetworkError" cascade from happening again on a single IP without introducing residential proxies or external infrastructure.

## Non-goals

- **No residential proxy integration.** Deferred to a separate slice; out of scope here.
- **No in-scrape retry-with-backoff.** Stress evidence shows DataDome blocks last > 5 min; a 60-second in-scrape retry can't recover.
- **No changes to LinkedIn or Dice scrapers.** Different anti-bot situations; this slice ring-fences Monster.
- **No changes to `BaseScraper` or `src/scrapers/registry.js`.** The mitigation lives entirely inside `scrapeMonster` + a new pure-helper module.
- **No backend/orchestrator changes.** Cooldown is local to the host's filesystem.

## Ground truth (from the stress test run on 2026-06-06)

Per-run sequence on the failing tail (Monster stress test run #2 / `b4fej985a`):

| Run | Outcome | Classifier signal |
|---|---|---|
| #9 | 90 jobs OK | results |
| #10 | ❌ DomChangedError | "appsapi responded but 0 cards rendered and no empty-results text" |
| #11 | ❌ NetworkError | "no appsapi response, no positive page signal" |
| #12 | ❌ NetworkError | "no appsapi response, no positive page signal" |

Two diagnostic facts:

1. **Run #10 was misclassified.** The appsapi POST did fire and the response WAS captured by `waitForResponse`. But the response body contained zero job results — DataDome was already shadow-suppressing — and the scraper has no current visibility into the body, only into whether the response event fired. So `sawApiResponse: true` + `cardCount: 0` → `dom_changed`. That's wrong: it's a block.
2. **Runs #11–12 cascaded because nothing throttled them.** Once DataDome flags the IP, every subsequent `scrapeMonster` call eats the full timeout budget (15s appsapi gate + 5s waitForSelector + 5s warmup) before throwing. No cooldown stops the next invocation from trying.

## Section A — Appsapi response body inspection (`inspectAppsapiBody`)

### New pure helper

`scrapers/monster.js` exports:

```js
export function inspectAppsapiBody(text) → 'has-jobs' | 'empty-payload' | 'unparseable' | 'unknown-shape';
```

Logic:
- Empty/nullish text → `'empty-payload'`.
- `JSON.parse` throws → `'unparseable'`.
- Check three common shapes for Monster's appsapi response, in order:
  - `body.jobResults` (Array, length > 0) → `'has-jobs'`
  - `body.jobs` (Array, length > 0) → `'has-jobs'`
  - `body.searchResults?.jobs` (Array, length > 0) → `'has-jobs'`
  - `body.results` (Array, length > 0) → `'has-jobs'`
- Any of those keys present but empty array → `'empty-payload'`.
- None of those keys present at all → `'unknown-shape'` (treat conservatively — don't override the existing classifier).

The exact shape used by Monster's appsapi today gets captured in a real probe (Task 1 of the plan) and committed as a fixture so tests are grounded in reality.

### Orchestrator wiring change

`scrapeMonster` currently does:

```js
const apiResponsePromise = page.waitForResponse(matcher, { timeout: ... })
    .then(() => true).catch(() => false);
// ... later ...
const sawApiResponse = await apiResponsePromise;
```

Replace with:

```js
const apiResponsePromise = page.waitForResponse(matcher, { timeout: ... })
    .then(async (resp) => {
        try { return { saw: true, body: await resp.text() }; }
        catch { return { saw: true, body: null }; }
    })
    .catch(() => ({ saw: false, body: null }));
// ... later ...
const { saw: sawApiResponse, body: apiBody } = await apiResponsePromise;
const apiResponseInspection = sawApiResponse && apiBody !== null
    ? inspectAppsapiBody(apiBody)
    : null;
```

Pass `apiResponseInspection` to the classifier (Section B).

### Classifier change (`classifyMonsterPage`)

New input field `apiResponseInspection: 'has-jobs' | 'empty-payload' | 'unparseable' | 'unknown-shape' | null` (null when no response was seen).

Resolution order changes:

```
soft_blocked      ← URL captcha-delivery / body matches DataDome regex
                  ← OR apiResponseInspection === 'empty-payload' AND cardCount === 0 AND no empty-results text   (NEW)
results           ← cardCount > 0
empty_confirmed   ← /no jobs (found|match)/i in bodyText
dom_changed       ← apiResponseInspection === 'has-jobs' AND cardCount === 0   (NEW — more accurate)
                  ← OR sawApiResponse AND no other signal (existing)
network_error     ← no appsapi response and no positive signal (existing)
```

The classifier's `signal` string is updated to include the inspection verdict (e.g. `"appsapi returned empty payload"`).

**Effect:** run #10's failure mode now throws `BlockedError` (and triggers the cooldown in Section B) instead of `DomChangedError`. `DomChangedError` is reserved for the case where the appsapi has data but cards don't render — a real DOM rename signal.

## Section B — Cross-run cooldown (`src/core/monster-cooldown.js`)

### New pure-helper module

```js
// src/core/monster-cooldown.js
export function readCooldownMarker({ readFile, now, path }) → { blockedUntil: Date | null };
export function writeCooldownMarker({ writeFile, now, cooldownMs, path }) → void;
export function isOnCooldown(marker, now) → boolean;
export function cooldownPath() → string;  // ~/.blacklight-monster-cooldown
export function cooldownMs() → number;    // 30min default; env-overridable
```

Specifically:

- **File location:** `path.join(os.homedir(), '.blacklight-monster-cooldown')`. Survives reboots (a stale cooldown is the safe direction — over-blocking is fine).
- **File format:** single ASCII line — ISO-8601 timestamp of when the cooldown expires. Example: `2026-06-08T14:30:00.000Z`. Anything else (corrupt / unparseable) → treated as no marker.
- **Default cooldown duration:** 30 minutes. Configurable via `MONSTER_BLOCK_COOLDOWN_MIN` env var (positive integer minutes).
- **`readCooldownMarker`:** returns `{blockedUntil: null}` on ENOENT, malformed timestamp, or stale (past) timestamp. Returns `{blockedUntil: Date}` if the marker is in the future.
- **`writeCooldownMarker`:** atomic write (write to `<path>.tmp` then `rename` — same pattern used by `setup/wizard.js`'s `writeSecret`). Always overwrites; the latest timestamp wins.
- **`isOnCooldown(marker, now)`:** boolean — `marker.blockedUntil && marker.blockedUntil > now`.

### `scrapeMonster` wiring

Two integration points:

1. **At entry**, before `await launch(...)`:
   ```js
   const marker = readCooldownMarker({ readFile: fs.readFileSync, now: new Date(), path: cooldownPath() });
   if (isOnCooldown(marker, new Date())) {
       throw new BlockedError(
           `Monster IP cooldown active until ${marker.blockedUntil.toISOString()} — skipping scrape`,
           { platform: 'monster', kind: 'datadome-cooldown' },
       );
   }
   ```
   **No browser launch.** No 30-second wasted timeout per call. The orchestrator sees the typed error immediately.

2. **At every `BlockedError` throw site** inside the existing `scrapeMonster` body (currently just one site, in the search-page classifier branch). Before re-throwing, write the marker:
   ```js
   writeCooldownMarker({
       writeFile: fs.writeFileSync,
       now: new Date(),
       cooldownMs: cooldownMs(),
       path: cooldownPath(),
   });
   throw new BlockedError(`Monster blocked: ${verdict.signal}`, { platform: 'monster', kind: 'datadome' });
   ```

   Same pattern applies to the new throw site introduced by Section A's classifier change (the `apiResponseInspection === 'empty-payload'` case routes through the existing soft_blocked branch).

### Partial-result interaction

The existing partial-result policy (return `{jobs, emptyConfirmed: false, partial: true}` when ≥ 1 job has been collected before the throw) is preserved. **The cooldown marker is still written even when the function returns partial results** — DataDome flagged us; subsequent runs should still be blocked. This is a small behavior change: today, partial-result returns don't signal anything to the next caller; now they record a cooldown if the underlying cause was a block.

To keep this surgical, the cooldown write happens in the same branch as the partial-result return, just before the `return` statement.

## Section C — Tests

### New unit tests

- `test/scrapers/monster-inspect-appsapi-body.test.js` — fixture-driven (`test/fixtures/monster-appsapi-has-jobs.json` + `test/fixtures/monster-appsapi-empty.json`):
  - has-jobs fixture → `'has-jobs'`
  - empty fixture → `'empty-payload'`
  - empty string / null / undefined → `'empty-payload'`
  - malformed JSON → `'unparseable'`
  - random unrelated object → `'unknown-shape'`
  - `{jobs: []}` synthetic → `'empty-payload'`
  - `{searchResults: {jobs: [{title:'X'}]}}` synthetic → `'has-jobs'`

- `test/core/monster-cooldown.test.js` — pure-function tests with injected fs + `now`:
  - read: file missing → `{blockedUntil: null}`
  - read: file is a stale ISO timestamp → `{blockedUntil: null}` (treated as expired)
  - read: file is a future ISO timestamp → `{blockedUntil: <Date>}`
  - read: file is garbage → `{blockedUntil: null}`
  - write: produces a file containing an ISO of `now + cooldownMs`
  - write: atomic (writes `<path>.tmp` first, then renames — verify via call-order capture on the injected `writeFile`/`rename`)
  - `isOnCooldown`: true for future, false for null, false for past
  - `cooldownMs`: defaults to 1800000 (30 min)
  - `cooldownMs`: reads `MONSTER_BLOCK_COOLDOWN_MIN` env when set to a positive integer
  - `cooldownMs`: ignores garbage env values (returns the default)

### Existing test extended

- `test/scrapers/monster-classify-page.test.js` adds two cases:
  - `apiResponseInspection: 'empty-payload'`, `cardCount: 0`, no empty-text → `soft_blocked`
  - `apiResponseInspection: 'has-jobs'`, `cardCount: 0` → `dom_changed`

### Fixtures

Two new files under `test/fixtures/`:
- `monster-appsapi-has-jobs.json` — a live capture of a successful Monster search response.
- `monster-appsapi-empty.json` — a live capture of a DataDome-suppressed response (zero results despite valid query).

Both captured during the implementation plan's Task 1 via a small probe script (see plan).

## Section D — Debug-harness change

`scripts/test-monster-scrape.js`:

- New env-gated escape hatch — `MONSTER_CLEAR_COOLDOWN=1 npm run monster:test-scrape -- "<role>"` deletes `~/.blacklight-monster-cooldown` before running. Lets operators manually retry without waiting out the 30-min cooldown.
- Without the env, the harness exits 4 with a clear message if it gets `BlockedError({kind: 'datadome-cooldown'})` (so operators can tell "in cooldown" from "real block"). The existing exit-2 (on other BlockedError kinds) is preserved.

## Section E — File map

| Path | Action | LOC |
|---|---|---|
| `scrapers/monster.js` | modify (capture appsapi body, pass to classifier, classifier branch update, cooldown read at entry + write at throw sites) | +80 |
| `src/core/monster-cooldown.js` | new | ~45 |
| `scripts/test-monster-scrape.js` | env-gated clear + cooldown-specific exit code | +12 |
| `test/scrapers/monster-inspect-appsapi-body.test.js` | new | ~55 |
| `test/core/monster-cooldown.test.js` | new | ~75 |
| `test/scrapers/monster-classify-page.test.js` | extend with 2 cases | +20 |
| `test/fixtures/monster-appsapi-has-jobs.json` | new (live-captured) | data |
| `test/fixtures/monster-appsapi-empty.json` | new (live-captured) | data |
| `scripts/monster-appsapi-probe.mjs` | new (one-time probe to capture both fixtures) | ~50 |

Total: ~340 LOC code + tests + fixtures + probe across 9 files.

## Section F — Operator-visible behavior

After this slice ships:

- A clean Monster scrape behaves identically to today.
- The first DataDome empty-payload run logs `Page N classified: soft_blocked (apiResponseInspection=empty-payload)` and throws `BlockedError({kind: 'datadome'})` instead of `DomChangedError`.
- The marker file appears at `~/.blacklight-monster-cooldown` containing an ISO timestamp 30 min in the future.
- Subsequent `scrapeMonster` calls within that window throw `BlockedError({kind: 'datadome-cooldown'})` immediately (no browser launch).
- After 30 min, the marker is considered stale; the next call proceeds normally.
- A real DOM change (Monster renames `data-testid="JobCard"`) still produces `DomChangedError` — that signal is preserved and is now actionable instead of being polluted by DataDome cases.

## Success criteria

- A captured `monster-appsapi-empty.json` fixture, fed through `inspectAppsapiBody`, returns `'empty-payload'`.
- A captured `monster-appsapi-has-jobs.json` fixture returns `'has-jobs'`.
- `classifyMonsterPage` returns `soft_blocked` when `apiResponseInspection: 'empty-payload'` + `cardCount: 0` + no empty-results text.
- `writeCooldownMarker` followed by `readCooldownMarker` returns a `blockedUntil` Date roughly `cooldownMs` in the future (allowing for clock drift).
- A `scrapeMonster` call immediately after `writeCooldownMarker` throws `BlockedError({kind: 'datadome-cooldown'})` without launching a browser.
- The next 30-min Monster stress test does not exhibit the cascading-failure pattern: after the first `BlockedError`, subsequent calls within 30 min throw immediately with the cooldown signal, NOT cascade through `NetworkError`.
- `scrapers/linkedin.js` and `scrapers/dice.js` not modified (sanity guard).
