# Design — LinkedIn cookie write-back: capture *mid-scrape*, not at close

> Status: approved 2026-05-20. Source of truth for the implementation plan.
> Scope: **scraper-only** (`scrapers/linkedin.js` + tests). No orchestrator / backend / proxy changes.
> Companion to: `docs/BACKEND_CREDENTIAL_REFRESH_SPEC.md`, the original cookie write-back design (`2026-05-19-cookie-writeback-design.md`), and the backend's 2026-05-20 follow-up handoff (`SCRAPER_COOKIE_REFRESH_HANDOFF.md` + the timing-race diagnosis).

## 1. Problem & goal

PR #7 wired the write-back path correctly (planCookieRefresh → refreshCookies → POST). But in prod, the `skipped_no_li_at` guard fires **every** session — `rotation_count` on credential 12 is still **0** despite multiple successful scrapes.

**Root cause (handoff §2-3):** LinkedIn invalidates `li_at` server-side *during/right after* a successful scrape. Our `context.cookies()` call at session close (`scrapers/linkedin.js:1480`) runs ~30 s after the last authenticated request and reads a jar that has already been poisoned. The guard correctly refuses to post it (Rule 3 from `planCookieRefresh` mirrors the backend); the rotated jar from earlier in the scrape is lost.

Goal: capture the cookie jar **while still authenticated** (immediately after a scroll batch yields posts), hold onto the latest known-good jar across the scroll loop, and post **that** at session close — not a re-capture from a possibly-poisoned context.

## 2. Architecture

Repo-proven pattern: small **pure, exported, unit-tested** helper + a thin optional callback into `extractPosts` + minimal wiring in `scrapeLinkedIn`. No new files in `scrapers/`; tests live in `test/scrapers/` next to the other linkedin unit suites.

### Component A — pure helper

```
hasLiAt(jar) → boolean
```
- `Array.isArray(jar) && jar.some(c => c && c.name === 'li_at' && typeof c.value === 'string' && c.value.length > 0)`.
- `null` / `undefined` / non-array / `[]` / missing `li_at` / empty `li_at` → `false`.
- Exported from `scrapers/linkedin.js` for the existing test pattern; replaces the inline `some(...)` currently inside `planCookieRefresh`'s caller-side check (kept identical-semantics; the backend Rule 3 still rejects no-li_at jars defensively).

### Component B — `extractPosts` accepts an optional capture callback

`extractPosts(page, maxPosts)` becomes `extractPosts(page, maxPosts, opts = {})` where `opts.onAuthenticatedBatch` is an optional `async (jar) => void`. After the existing `if (newPostsCount > 0)` block (`scrapers/linkedin.js:1100`), if the callback is provided, fire `onAuthenticatedBatch(await page.context().cookies())`. Wrapped in try/catch — capture is **best-effort**, never throws, never affects the scrape verdict or the existing logs.

**Why this hook point:** `newPostsCount > 0` means LinkedIn just served real results on the search page. That is the strongest "still authenticated" signal we have. Capturing right then maximizes the chance the jar still has a live `li_at`.

### Component C — `scrapeLinkedIn` stashes the freshest authenticated jar

In `scrapeLinkedIn` (`:~1260` region, before the `extractPosts` call site at `:1328`):

```js
let latestAuthenticatedJar = null;
const onAuthenticatedBatch = (jar) => { if (hasLiAt(jar)) latestAuthenticatedJar = jar; };
```

Pass `{ onAuthenticatedBatch }` into the `extractPosts` call. After each batch yields ≥1 new post, the callback fires and the closure variable is updated **iff** the jar still has `li_at` — so we always hold the most-recent *known-good* jar. (Every-batch capture, not first-batch-only: backend hash-dedups (`status: "unchanged"`), the cost is one `context.cookies()` per scroll, and we get the freshest jar — strictly more diligent than first-batch-only, no downside. Handoff §4 says either is fine.)

### Component D — close-time write-back uses the stashed jar

`scrapers/linkedin.js:1480-1481` currently:
```js
const jar = await context.cookies().catch(() => null);
await lease.refreshCookies(jar);
```
Becomes:
```js
await lease.refreshCookies(latestAuthenticatedJar);
```
- **Dropped:** the close-time `context.cookies()` recapture — that is exactly the call returning a poisoned jar in prod today.
- **Preserved:** `refreshCookies` is already null-safe (it calls `planCookieRefresh` which returns `{action:'skip', reason:'skipped_no_li_at'}` for `null` / no-`li_at` jars) → if no batch ever yielded posts, `latestAuthenticatedJar` is `null` → write-back falls through to the existing `skipped_*` log, no error, no verdict impact.
- **Preserved:** `reportSuccess` call immediately after — verdict logic untouched.

## 3. Data flow

lease → `pickSessionQuery` → one variant → `navigateToSearch` (one `ensureLoggedIn`) → `extractPosts(page, budget, { onAuthenticatedBatch })`:
- scroll loop, on each batch with newPostsCount>0: capture `await page.context().cookies()` → if `hasLiAt(jar)` → `latestAuthenticatedJar = jar`
- early-stop / maxScrolls unchanged
→ verdict (unchanged) → `await lease.refreshCookies(latestAuthenticatedJar)` (best-effort) → `reportSuccess`.

## 4. Error handling

Unchanged. The capture call is wrapped in try/catch and **never** throws into the scroll loop; `refreshCookies` already provably never throws and never `#forgetLease`s (regression-pinned by the `refreshCookies NEVER forgets the lease` test in `test/api/credentials-refresh.test.js:58`). Verdict / `{jobs, emptyConfirmed}` / AuthError / BlockedError / DomChangedError taxonomies are not touched.

## 5. Testing

**Unit (pure, `test/scrapers/linkedin-has-li-at.test.js`):**
- `null` → `false`
- `undefined` → `false`
- non-array (`"foo"`, `42`, `{}`) → `false`
- `[]` → `false`
- jar with no `li_at` entry → `false`
- jar with `li_at` but empty / missing `value` → `false`
- jar with `li_at: 'AQED...'` → `true`
- jar with `li_at` among other cookies → `true`

**Regression:**
- The `refreshCookies NEVER forgets the lease` test in `test/api/credentials-refresh.test.js:58` still passes (the never-`#forgetLease` invariant is unaffected by the capture-site change).
- `npm test` green (133 → 141+ with the new helper tests).

**Empirical (out-of-scope here, by design):**
- Mid-scrape capture is browser-driven; cannot be unit-tested without Playwright fixtures. Verification of the wired path is static (`grep` probes for call-site presence + `node --check`) + the unit suite for the pure helper.
- **Honest caveat — the *real* validation is operational:** `rotation_count` on credential 12 should increment above `0` after the next successful scrape in prod. That is the single number the handoff (§6) tells us to watch. Not provable in this environment (no valid prod credential / no successful prod scrape this session) — stated, not worked around.

## 6. Non-goals (YAGNI)

- No diffing of leased vs. captured `li_at`/`lidc` before posting — backend hash-dedups, idempotent (handoff §4 explicitly endorses this).
- No retry / queueing of failed `/refresh` POSTs — best-effort by design (matches PR #7 semantics).
- No change to `planCookieRefresh` rules, `refreshCookies` contract, or the credential-lease lifecycle.
- No backend changes; no orchestrator changes; no pacing changes (PR #8 stands as-is).

## 7. Acceptance criteria

1. `hasLiAt` exported from `scrapers/linkedin.js`, unit-tested with at least the 8 cases above, all green.
2. `extractPosts` accepts an optional `opts.onAuthenticatedBatch(jar)`; when provided, it fires after each batch with `newPostsCount > 0`, wrapped in try/catch, never throws into the scroll loop.
3. `scrapeLinkedIn` declares `latestAuthenticatedJar`, passes the callback, and replaces lines 1480-1481 with `await lease.refreshCookies(latestAuthenticatedJar)`. The close-time `context.cookies()` recapture is **gone**.
4. `npm test` green; existing never-`#forgetLease` regression still passes.
5. `node --check scrapers/linkedin.js` clean; no orphan references to the dropped close-time capture.
6. Real-world effectiveness explicitly documented as "expected, confirm in prod via `rotation_count` > 0" — not claimed proven.
