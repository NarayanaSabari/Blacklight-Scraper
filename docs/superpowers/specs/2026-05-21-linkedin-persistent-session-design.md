# Design — LinkedIn persistent browser session (scraper-side, D1b)

> Status: proposed 2026-05-21, awaiting user review. Scraper-side companion to the user's cross-repo spec ("Persistent Browser Session for the LinkedIn Scraper"). Backend changes (heartbeat + long-lived lease) are a **parallel handoff** — see `docs/BACKEND_PERSISTENT_SESSION_SPEC.md`.
> Decision locked with user 2026-05-21: **D1b** (long-lived CloakBrowser context), NOT D1a (CDP-attach). Rationale: the codebase already migrated away from CDP-attach (`scrapers/linkedin.js:3-6`, `scrapers/indeed.js:11-16` — "fragile, single-browser bottleneck, broke when Chrome closed"); CDP is itself anti-bot-detectable and would forfeit CloakBrowser's stealth patches.

## 1. Problem & goal

Today every LinkedIn role scrape cold-launches a fresh CloakBrowser, injects the frozen cookie export, scrapes, and **closes** the browser (`scrapeLinkedIn` owns the full browser lifecycle). Two failure modes compound: (a) re-injecting a decaying point-in-time export never lets the session live/rotate organically; (b) repeated cold-launch + injection is itself an anti-bot signal — LinkedIn auth-walls the *next* session seconds after a successful one.

Goal: load cookies **once** into **one long-lived CloakBrowser context** held for the server process lifetime, and scrape every role as a **new tab** in that same context — so the session stays warm and cookies rotate in-place. Keep CloakBrowser's stealth (no CDP).

**Non-goal for this spec:** the backend heartbeat/lease change (separate doc); reverting the write-back (deferred until D1b is validated in prod, per the cross-repo spec §10 step 4).

## 2. Process & concurrency context (why this is feasible, and what it breaks)

- `node server.js` is a **long-running process**; `QueueOrchestrator.startAutoChecker()` runs `runOnce()` on an interval (`src/queue/orchestrator.js:95-103`). ✅ There is a process lifetime to hold a browser across roles.
- `runOnce` fires assignments **in the background**, and `#runAssignment` runs platforms **in parallel**, kicking `triggerNextPoll()` after each settles (`orchestrator.js:83-91, 211-231`).
- The orchestrator's safety comment (`orchestrator.js:211-214`) explicitly assumes *"its own browser context, its own credential lease"* per scrape. **D1b breaks that assumption** — one shared context + one shared lease. The backend's in-flight filter makes LinkedIn *mostly* one-at-a-time, but the post-platform re-poll means we cannot rely on it. **Therefore the session manager MUST be concurrency-safe.**

## 3. Architecture

### Component A — `LinkedInSession` singleton (new: `src/scrapers/linkedin-session.js`)

Owns exactly one browser + context + credential lease for the process lifetime.

```
class LinkedInSession {
  async ensureReady()        // idempotent, mutex-guarded: lease cred → launch CloakBrowser
                             //   → newContext → inject cookies ONCE → verify auth.
                             //   Concurrent callers await the same in-flight establish promise.
  async withPage(fn)         // newPage() → await fn(page) → finally page.close().
                             //   Establishes lazily via ensureReady() on first use.
  async reestablish()        // tear down dead/auth-failed context, re-acquire cred, re-open.
  async shutdown()           // graceful: (optional D3 jar persist) → release lease → close browser.
  isAlive()                  // health probe for reestablish decisions.
}
```

- **Concurrency safety:** `ensureReady()` stores the establish `Promise` and returns it to concurrent callers (single-flight). `withPage` allows concurrent tabs once ready — Playwright/CloakBrowser contexts are safe for concurrent pages.
- **Lease:** acquired once in `ensureReady()`, held for the process. `reportSuccess`/`reportFailure` are still called **per role** against the held lease (per-role outcome telemetry is preserved). `release` moves to `shutdown()`.
- **Re-login:** on per-role auth-wall, `withPage`'s caller (the scrape flow) attempts in-context `performLogin` first (existing flow); only if that fails does it call `reestablish()`.

### Component B — `scrapeLinkedIn` refactor (`scrapers/linkedin.js`)

Today `scrapeLinkedIn` does lease → launch → inject → navigate → scrape → writeback → reportSuccess → **close**. Refactor to:

```
scrapeLinkedIn(jobTitle, location, sessionId, options):
   session = getLinkedInSession()                 // module singleton
   return session.withPage(async (page) => {
       // (no launch, no inject — the context is already warm & authed)
       chosen = pickSessionQuery(options.searchQueries) ?? buildBooleanSearchQuery(jobTitle)
       await navigateToSearch(page, chosen)        // existing, minus the per-call ensureLoggedIn launch assumptions
       posts = await extractPosts(page, CONFIG.maxPosts, { ... })
       // per-role outcome on the HELD lease:
       session.reportRoleSuccess(`Scraped ${n} posts`)   // or reportRoleFailure on typed error
       return { jobs, emptyConfirmed }
   })
```

- `navigateToSearch`/`ensureLoggedIn`/`performLogin`/`extractPosts`/`pickSessionQuery`/pacing all stay. The change is **who owns the browser** (session manager, not scrapeLinkedIn) and **lease lifetime** (held, not per-call).
- The per-role write-back `lease.refreshCookies(...)` **call is dropped** in Phase 1 (as built — plan §4 step 4): once the context is never closed per role there is no close-time poison, so the call is a guaranteed no-op. The mid-scrape **capture vars** (`onAuthenticatedBatch`/`latestAuthenticatedJar`/`hasLiAt` on the scrape path) are **left in place** (now write-only) for reversibility; full removal is the §7 cleanup after prod validation. Rollback remains a clean `git revert` of the branch regardless. (Earlier draft said "keep the call unreached"; reconciled here to match the as-built code.)

### Component C — lifecycle wiring (`server.js`)

- On `SIGTERM`/`SIGINT` (server.js already has a shutdown path ~`:150` `stopAutoChecker`): also call `getLinkedInSession().shutdown()` (release lease, close browser). Best-effort, time-boxed.
- No orchestrator change required: the session establishes lazily on the first LinkedIn role and is generic from the orchestrator's view. (The stale safety comment at `orchestrator.js:211-214` gets corrected to note LinkedIn now shares one context — honesty fix.)

## 4. Phasing (validate the hypothesis before the full build)

**Phase 1 — MVP (validate "warm session reduces auth-walls"):**
- `LinkedInSession` singleton (lease once, launch once, inject once, hold; concurrency-safe; `withPage`).
- `scrapeLinkedIn` refactored to `withPage`.
- Shutdown hook releases lease + closes browser.
- **No heartbeat yet** — with 1 credential + 1 process there is no lease contention; the existing backend reaper *may* release the held lease after its assignment timeout, which is the known risk (mitigated fully only by the backend handoff). Acceptable for a local/single-host validation run.
- Keep write-back code in place (unreached); keep all error classification + pacing.
- **Success metric:** run one browser for hours across many roles; observe far fewer `/uas/login` auth-walls per role vs the cold-launch baseline.

**Phase 2 — production-correct (needs backend handoff shipped):**
- Heartbeat client (`POST …/queue/<credential_id>/heartbeat` on an interval while alive).
- `reestablish()` on browser crash / heartbeat-rejected lease.
- Then §7 cleanup: remove the now-dead write-back path (keep optional D3 persist-on-shutdown).

**Phase 3 — throughput (later, D4):** pool of N persistent browsers across N credentials.

## 5. Error handling

- Per-role failures (0 posts / DOM change / block) → report against the held lease, **keep the context open**, move on (matches cross-repo spec §6).
- Auth-wall mid-scrape → in-context `performLogin` (existing); on failure → `reestablish()`; if re-establish can't get a working cred → propagate typed `AuthError` so the role is reported failed (existing taxonomy + `cooldownMinutes` unchanged).
- Browser/context crash → `withPage` catches the Playwright "context closed" error → `reestablish()` once → retry the page op once; if still failing, fail the role.
- All existing typed errors (`AuthError`/`BlockedError`/`DomChangedError`) and `cooldownMinutes` reporting are preserved.

## 6. Testing

**Unit (pure / injectable, `test/`):**
- `LinkedInSession.ensureReady` single-flight: 10 concurrent `ensureReady()` calls → exactly **one** lease + one launch (inject a fake launcher/lease, assert call counts).
- `withPage`: opens a page, runs fn, closes the page even when fn throws (fake context).
- `reestablish`: tears down + re-leases + re-launches (fake).
- Shutdown: releases lease + closes browser exactly once; idempotent on double-call.
- Re-login decision: auth-wall → performLogin attempted before reestablish (fake page state).

**Not unit-testable (browser-driven, consistent with the rest of `test/scrapers/`):** the live navigate/scroll/scrape path. Verified by static probe + a local headed validation run.

**Honest caveat:** like every prior LinkedIn change, *effectiveness* ("warm session → fewer auth-walls") is observable only in prod over time. Phase-1 success is judged operationally (auth-wall rate per role, hours of uptime on one browser), not by unit tests.

## 7. What gets reverted, and WHEN (not now)

Per the cross-repo spec §7 + §10 step 4: **do not revert the write-back until Phase 1 is validated in prod.** Once validated:
- Remove the unreached per-role `lease.refreshCookies` path + the mid-scrape capture wiring (`onAuthenticatedBatch`, `latestAuthenticatedJar`, `hasLiAt` usage on the scrape path). Keep `hasLiAt` only if D3 reuses it.
- D3 (recommended): keep a single persist-jar-on-shutdown write for faster cold-restart seeding.
- Backend revert of `POST …/refresh` + the 4 metadata columns is backend-owned (handoff doc).

## 8. Risks

- **Single point of failure:** one browser down = LinkedIn scraping paused until `reestablish()`. Mitigated by health-probe + auto-reestablish (Phase 2).
- **Concurrency:** the orchestrator's "own context per scrape" assumption is violated; mitigated by the single-flight session manager. Must be covered by the concurrency unit test before shipping.
- **Memory growth:** long-lived Chromium; mitigated by strict per-role `page.close()` and a periodic context recycle (every K roles / H hours) — the recycle re-injects once, far less often than per-role.
- **Lease reaping (Phase 1 only):** without heartbeat the backend may reap the held lease; acceptable only for the single-cred validation window, fixed by the backend handoff.
- **Server-side flagging is NOT solved:** a warm session reduces per-launch auth-walls but cannot un-flag an already-burned account (credential 12: 12→2→1 posts/session). Operational fixes (fresh login/new account, set password, more creds) remain the highest-leverage moves and are orthogonal to this work.

## 9. Acceptance criteria (Phase 1)

1. One CloakBrowser context is launched once and reused across ≥2 LinkedIn roles in one process run (verified by log: one "Launching CloakBrowser" line for N roles).
2. Cookies injected exactly once per session establishment, never per role.
3. `ensureReady` is single-flight under concurrency (unit test: 1 lease/launch for 10 concurrent callers).
4. Each role runs in its own page and closes it; the context stays open.
5. Per-role success/failure still reported against the held lease; error taxonomy + `cooldownMinutes` unchanged.
6. Graceful shutdown releases the lease and closes the browser exactly once.
7. `npm test` green; no regression to the existing 142 tests.
8. Effectiveness documented as "validate in prod" — not claimed proven.
