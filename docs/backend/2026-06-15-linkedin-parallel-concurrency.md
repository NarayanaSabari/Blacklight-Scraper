# Backend request: allow N concurrent in-flight sessions per platform (LinkedIn parallelism)

**Date:** 2026-06-15
**For:** backend engineer who owns the scraper queue API (`api.qpeakhire.com`)
**From:** scraper team
**Priority:** Medium — unblocks LinkedIn throughput; scraper side is already shipped and waiting.

---

## TL;DR

The scraper can now safely run **2 LinkedIn scrapes in parallel on one machine** (bounded, paced, validated). But it never actually does in prod, because the **queue API only ever hands this scraper one LinkedIn role at a time** — it claims at most one pending pair *per platform* per poll, and excludes a platform that already has an in-flight session for the scraper.

**Ask:** let the queue allow up to **N in-flight sessions per (scraper, platform)** — default `1`, but **`2` for LinkedIn** — so the scraper can hold two LinkedIn roles at once. No other change needed; the scraper already caps and paces itself at N.

---

## Background — how the scraper claims work today

The scraper polls your queue API every ~30s:

1. `GET /api/scraper-credentials/queue/availability`
   → per-platform leasable-credential counts, e.g. `{ "linkedin": 1, "dice": 999, ... }` (`999` = public/no-auth). The scraper drops platforms returning `0`.
2. `GET /api/scraper/queue/next-role?platforms=<csv>`
   → returns `{ assignments: [ { session_id, role, platforms:[...] }, ... ] }`. Per its documented contract, **a single poll claims "one pending pair per platform"** across the queue.
3. The scraper runs each assignment; on completion it submits results and re-polls.

There's also a `409 "Scraper already has an active session"` surfaced from one of the queue endpoints.

The scraper runs assignments **concurrently** (fire-and-forget) and is internally safe to run multiple LinkedIn roles at once (see "Scraper side is ready" below).

---

## The problem

Two rules in the queue API together cap LinkedIn at **1 concurrent session per scraper**:

1. **One pending pair *per platform* per poll** — a single `next-role` claim returns at most one LinkedIn role, even if several are queued.
2. **In-flight exclusion** — while the scraper has an in-flight LinkedIn session, LinkedIn is excluded from the next claim until that session completes.

Net effect: LinkedIn roles are processed strictly one-after-another, even though the scraper is ready to do two at once.

### Evidence (prod logs, 2026-06-15, scraper on the parallel-enabled build)

LinkedIn sessions are **sequential, never overlapping**:

```
04:11:25  Starting scrape  IT Operations Manager   (sessionId 55585c32…)
04:11:31→04:14:19  …IT Ops extracting (Found 8, 8, 8, 11 new posts)…
04:15:20  Starting scrape  Vue.js Developer         (sessionId ae513600…)  ← starts only after IT Ops wraps
04:15:48  Starting scrape  Quantum Computing Res.   (sessionId 5e68f9c6…)  ← starts only after Vue.js (fast 0-result) wraps
```

Each LinkedIn session begins only as the previous one finishes. At no point are two LinkedIn sessions extracting in the same window. A LinkedIn scrape takes ~3–6 min, so if the API allowed a 2nd in-flight LinkedIn role, the two would clearly overlap — they never do.

---

## What we need the backend to change

Allow up to **N in-flight sessions per (scraper, platform)**, where N is configurable per platform:

| Platform | Desired max in-flight per scraper |
|---|---|
| **linkedin** | **2** |
| everything else | 1 (unchanged) |

Concretely, **either** of these (whichever fits your implementation) achieves it:

- **Option A (relax in-flight exclusion):** stop excluding a platform from the claim until it already has `N` in-flight sessions for that scraper (instead of excluding at the first). With `next-role` polled every ~30s and LinkedIn scrapes lasting minutes, successive polls would then build up to 2 concurrent LinkedIn sessions.
- **Option B (multi-claim per poll):** let a single `next-role` claim return up to `N` pending pairs for a platform (instead of one), for platforms whose cap > 1.

Either way the rule is: **a scraper may hold at most `N(platform)` in-flight sessions for that platform**, `N(linkedin) = 2`, default `1`.

### Suggested contract (clean + future-proof)

Let the scraper tell you its per-platform concurrency so you don't hardcode it backend-side. Two low-effort shapes:

- Add an optional query param to `next-role`, e.g.
  `GET /api/scraper/queue/next-role?platforms=linkedin,dice&max_inflight=linkedin:2`
  and have the claim honor up to that many in-flight per platform; **or**
- A static per-platform config on the backend (`{ linkedin: 2 }`), if you'd rather not change the contract.

We're fine with either. If you take the param route, tell us the exact param name/shape and we'll send it from the orchestrator.

### Don't forget the 409 / active-session check

If `409 "Scraper already has an active session"` (or `GET /api/scraper/queue/current-session`) enforces a **scraper-level** single-active-session rule, that would also need to permit ≥2 concurrent sessions for this to work. Please confirm whether that path gates concurrency too.

---

## Scraper side is already ready (no further scraper change needed)

The scraper enforces its own safety so you can hand it 2 LinkedIn roles without risk:

- A process-wide semaphore caps concurrent LinkedIn browser tabs at `LINKEDIN_MAX_CONCURRENCY` (**default 2**), with a 500–2000 ms staggered start so the tabs don't hit LinkedIn in lockstep.
- All LinkedIn work shares one logged-in browser profile (one account); 2 concurrent tabs is the **validated-safe** ceiling.
- **Validated:** a 30-minute live run on the real account drove this at 2-up — 81/81 searches succeeded, peak concurrency held at exactly 2, **0 auth-walls / shadow-bans, 0 leaks.**

So once the API allows 2 in-flight LinkedIn sessions, the scraper immediately runs 2-up and bounds itself — no coordination beyond the claim rule.

> ⚠️ Please keep the LinkedIn cap at **2**. Higher concurrency on a single LinkedIn account risks shadow-bans; we have not validated >2.

---

## Acceptance criteria

1. With LinkedIn roles queued, the scraper can hold **2** in-flight LinkedIn sessions simultaneously (and a 3rd is not handed out until one frees).
2. Other platforms remain at 1 in-flight (unchanged).
3. Prod logs show two `[linkedin]` sessions extracting in the same window (overlapping start→complete), instead of strictly sequential.
4. No regression to the existing in-flight / availability / 409 behavior for other platforms.

---

## Related (context, already resolved)

This is the same class of "backend claim-filter coordination" as the earlier fix where **monster** and **techfetch** were marked public (`999`) in `/api/scraper-credentials/queue/availability` so they'd stop being starved. This request is the analogous knob for *concurrency* rather than *availability*.
