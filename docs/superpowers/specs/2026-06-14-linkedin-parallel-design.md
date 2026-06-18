# LinkedIn parallel scraping — bounded tab pool (single account)

**Date:** 2026-06-14
**Scope:** Make LinkedIn concurrency on one machine **deliberate, bounded, and paced** — a controlled pool of N concurrent tabs in the single persistent-profile context, default N=2, tunable via env. No orchestrator changes.

## Goal

Run ~2 LinkedIn roles in parallel on one machine without shadow-banning the single account. Turn today's *uncontrolled* concurrency into a *bounded, paced* pool with a live knob.

## Context (current behavior)

- `src/scrapers/linkedin-session.js` — a singleton `LinkedInSession` holds ONE long-lived CloakBrowser **persistent-profile context** (one logged-in account, `~/.blacklight-linkedin-profile`). `withPage(sessionId, fn)` opens a fresh tab from that context per call, runs `fn`, closes the tab.
- The orchestrator (`#runAssignment` → `Promise.allSettled`, plus fire-and-forget assignments) calls `scrapeLinkedIn` — hence `withPage` — **concurrently and unbounded**. If several LinkedIn roles land at once, several tabs open simultaneously in the one session.
- LinkedIn aggressively throttles/shadow-bans a single session that fires many concurrent searches. The existing `DomChangedError` / `articles=0 feedUpdates=0` path is the symptom.

**Decisions (brainstorm 2026-06-14):** one LinkedIn account only → parallelism must share one session as concurrent tabs. Conservative default of **2** concurrent tabs, tunable.

## Design

### A) `src/core/semaphore.js` (new, pure, unit-tested)

A minimal async counting semaphore:

```js
export class Semaphore {
    constructor(max)            // max >= 1
    async acquire(): Promise<release>   // resolves when a slot is free; returns a one-shot release fn
    // FIFO queue for waiters; release() frees a slot and hands it to the next waiter
}
```

- `acquire()` resolves immediately if a slot is free, else queues (FIFO) until one frees.
- Returns a `release` function; calling it twice is a no-op (idempotent) so a double-release can't over-grant.
- No timeouts/cancellation (YAGNI for this use).

### B) `LinkedInSession` — bound + pace `withPage`

- Constructor takes `maxConcurrency` (default from `cooldown`/env resolver, see C). Creates `this._sem = new Semaphore(maxConcurrency)`.
- `withPage(sessionId, fn)`:
  1. `const release = await this._sem.acquire();`
  2. `try { await ensureReady(sessionId); await jitter(); const page = await this._context.newPage(); try { return await fn(page); } finally { await page.close().catch(()=>{}); } }`
  3. `finally { release(); }`
- **Jitter**: `jitter()` awaits a small randomized delay (default 500–2000ms) AFTER acquiring the slot and BEFORE opening/navigating the tab, so the N tabs don't fire in lockstep. Configurable off (0) for tests.
- Singleton ⇒ the semaphore caps total concurrent LinkedIn tabs **process-wide**, across every concurrent `scrapeLinkedIn` call.
- `ensureReady` stays single-flight (unchanged) — the first borrower establishes the context; the rest reuse it.

### C) Config — `LINKEDIN_MAX_CONCURRENCY`

- `src/config/env.js`: read `LINKEDIN_MAX_CONCURRENCY`, positive integer, **default 2**; invalid/≤0 → default. Exposed on the config object; `getLinkedInSession()` passes it to the constructor.
- (Jitter bounds can stay hard-coded constants; only the concurrency cap needs to be a live knob.)
- Dial `LINKEDIN_MAX_CONCURRENCY=1` to effectively serialize (safest); raise to 3 if LinkedIn tolerates it.

### D) No orchestrator changes

The orchestrator already calls `withPage` concurrently; the semaphore transparently bounds it. Nothing else changes.

## Error handling

- `release()` is called in `finally` — a throwing `fn`, a failed `newPage`, or a failed `ensureReady` never leaks a slot (no deadlock).
- `page.close()` is best-effort (`.catch(()=>{})`).
- Shadow-ban detection is unchanged (`DomChangedError`); operators respond by lowering `LINKEDIN_MAX_CONCURRENCY`.

## Testing

- **Semaphore unit tests**: immediate acquire when free; queues beyond max; FIFO release order; release-on-success and release-on-throw free a slot; idempotent double-release; a counting harness asserts in-flight never exceeds max under a burst of M ≫ max acquirers.
- **Session test** (if cheaply injectable): with a fake launcher returning a fake context whose `newPage` increments/decrements a live counter, drive K concurrent `withPage` calls and assert the observed max concurrency == `maxConcurrency`, and that all K complete (queued ones run after slots free).

## Non-goals

- Multi-account / multi-profile pool (no second account available).
- Per-account proxies.
- Concurrency beyond ~3 (unsafe on one account).
- Auto-tuning / dynamic backoff on shadow-ban (manual env knob only, for now).

## Success criteria

- With default config, at most **2** LinkedIn tabs run at once; a 3rd concurrent role queues and runs when a slot frees; never >2 tabs observed.
- `LINKEDIN_MAX_CONCURRENCY=1` serializes; `=3` allows 3.
- No slot leak: after a burst (including failures), the semaphore returns to full availability.
- Existing LinkedIn behavior (auth, extraction, DomChangedError path) unchanged. Full suite stays green.
