# Backend request: stop withholding the 2nd in-flight LinkedIn role (raise per-scraper cap 1 → 2)

**Date:** 2026-06-16
**For:** backend engineer who owns the scraper queue API (`api.qpeakhire.com`)
**From:** scraper team
**Priority:** Medium — unblocks ~2× LinkedIn throughput. The scraper side is already shipped and waiting; this is the only remaining blocker.

> Supersedes `docs/backend/2026-06-15-linkedin-parallel-concurrency.md` — same ask, clearer framing + fresh log evidence.

---

> ## ⚠️ RESOLVED / OBSOLETE — no backend action needed (2026-06-16)
>
> The backend team confirmed the per-scraper LinkedIn in-flight cap was **already
> raised to 2** and deployed **2026-06-15 07:42 UTC** (PR #265), per-scraper-key,
> DB-tunable (`scraper_platforms.max_inflight`). Verified independently in Loki:
> 2,257 overlapping LinkedIn session pairs in 6h — cap=2 is live and working.
>
> My "strictly sequential" evidence below was a **misread**: I used
> *Assignment-started* spacing, which says nothing about when a session *ends*.
> Sessions overlap; they're just very short.
>
> **The real LinkedIn bottleneck is NOT the queue and NOT cookies — it's our own
> two concurrency crashes, still UNDEPLOYED to prod.** Last 6h: 2,493× lease-race
> (`reading 'credential'`, fix `555eeb5`) + 2,478× context-race (`newPage …closed`,
> fix `3dfa0ab`) vs **1** auth failure. Fix = **prod `git pull` + restart onto
> `3dfa0ab`**. The cap=2 the backend enabled is what *exposed* these races.
>
> Kept for the record. The request below is satisfied; do not action it.

---

## TL;DR

The scraper is already built to run **2 LinkedIn scrapes at once** on one machine (one logged-in browser, two tabs — bounded and paced). It **already polls your queue continuously**, including *while* a LinkedIn session is mid-scrape.

The only reason it never actually runs two is this: **when the scraper asks for the next role while it already has one LinkedIn session in flight, the queue API refuses to hand out a second LinkedIn role.** Your in-flight filter is capped at **1 per (scraper, platform)**.

**Ask:** raise that cap to **2 for LinkedIn** (keep every other platform at 1). Nothing else changes — the scraper paces and bounds itself.

---

## The mental model (this is a *pull* system, and the client side already works)

There is **no push**. The scraper *pulls*: it repeatedly asks "got another role for me?" and you answer.

The scraper already asks continuously, even while busy:
- a **30-second timer** calls `GET /api/scraper/queue/next-role` on a loop, and a long-running LinkedIn scrape does **not** block it (the scrape runs in the background; only the quick claim is serialized);
- the moment **any** session finishes, the scraper **immediately** re-polls.

So from the client's side, the desired behavior is already happening:

> "LinkedIn session A is still running (slow role, ~4 min). 40s in, the timer polls again — *give me more work.*"

Your queue's answer to that poll is the whole problem. Today it replies:

> "You already have a LinkedIn session open → **no LinkedIn role for you.** Here's nothing (for LinkedIn)."

We are **not** asking you to push two roles simultaneously. We're asking you to **stop withholding** the 2nd LinkedIn role when the scraper pulls for it. Raise the ceiling from 1 to 2.

---

## How the scraper claims work today (endpoints)

Every ~30s, and after every session completes, the scraper does:

1. `GET /api/scraper-credentials/queue/availability`
   → per-platform leasable-credential counts, e.g. `{ "linkedin": 1, "dice": 999, ... }` (`999` = public/no-auth; `0` = scraper drops that platform this cycle).
2. `GET /api/scraper/queue/next-role?platforms=<csv>`
   → `{ assignments: [ { session_id, role, platforms:[...] }, ... ] }`, or `204` (nothing claimable).
3. Runs each assignment's scrape in the **background** (fire-and-forget, concurrent), then:
   - `POST /api/scraper/queue/jobs` (results, status `success`/`failed`)
   - `POST /api/scraper/queue/complete` (session done → **this is what frees the in-flight slot**).

Key point: step 3's scrape does **not** block step 1/2. The scraper is polling for the next role the entire time a LinkedIn scrape is running. It is **ready** to hold a second LinkedIn session right now.

---

## Root cause

Two rules in the queue API together pin LinkedIn at **1 concurrent session per scraper**:

1. **One pending pair *per platform* per poll** — a single `next-role` claim returns at most one LinkedIn role, even if several are queued.
2. **In-flight exclusion** — while the scraper has an in-flight LinkedIn session (claimed but not yet `complete`d), LinkedIn is excluded from subsequent claims.

Net effect: LinkedIn roles are processed strictly one-after-another, no matter how fast the scraper pulls.

### Evidence — prod logs, 2026-06-16 (UTC), scraper `Aravind-Mini-PC-2`

LinkedIn `Assignment started` events are **strictly sequential — never overlapping**:

```
06:30:35  Assignment started … linkedin  (Compliance Data Governance Analyst)
06:31:06  Assignment started … linkedin  (FinTech Implementation Consultant)   +31s
06:31:54  Assignment started … linkedin  (Solutions Engineer)                  +48s
06:34:54  Assignment started … linkedin  (Oracle PL/SQL Developer)            +3min
```

Each LinkedIn session begins only **after** the previous one finishes. A healthy LinkedIn scrape takes ~30s–4min; if the API allowed a 2nd in-flight LinkedIn role, two would visibly overlap. They never do — which is exactly the cap we're asking you to lift.

---

## What we need you to change

Allow up to **N in-flight sessions per (scraper, platform)**, configurable per platform:

| Platform | Max in-flight per scraper |
|---|---|
| **linkedin** | **2** |
| everything else | **1** (unchanged) |

Either implementation works — pick whichever fits your code:

- **Option A — relax the in-flight exclusion (recommended):** stop excluding a platform from the claim until it already has `N` in-flight sessions for that scraper (instead of excluding at the first). Because `next-role` is polled every ~30s and LinkedIn scrapes last minutes, successive polls naturally build up to 2 concurrent LinkedIn sessions. This matches the pull model exactly — you just stop saying "no" until the scraper is holding 2.
- **Option B — multi-claim per poll:** let a single `next-role` claim return up to `N` pending pairs for a platform whose cap > 1.

The invariant either way: **a scraper may hold at most `N(platform)` in-flight sessions for that platform; `N(linkedin) = 2`, default `1`.**

### Optional: don't hardcode it — let the scraper declare the cap

So you never have to touch backend config again when we re-tune, accept an optional hint on the claim:

```
GET /api/scraper/queue/next-role?platforms=linkedin,dice&max_inflight=linkedin:2
```

Honor up to that many in-flight per platform, default 1 if absent. (Nice-to-have, not required — a hardcoded `linkedin: 2` is fine for now.)

---

## Why this is safe — and why ONLY LinkedIn

- **LinkedIn is special:** all LinkedIn roles share **one** logged-in browser session (a persistent profile the operator logged into once). Running 2 is just **2 tabs in that one browser** — the scraper bounds it to 2 with a semaphore and staggers their start (0.5–2s jitter) so they don't hit LinkedIn in lockstep. 2 is a deliberately conservative cap to avoid shadow-banning the single account.
- **⚠️ Do NOT raise the cap for other platforms.** Monster/Dice/Indeed/Glassdoor/TechFetch each launch a **fresh, separate browser per scrape**. Two at once = two ~350MB Chromium instances → memory blow-up on the host **and** a much louder anti-bot footprint. Keep them at 1. This change is **LinkedIn-only**.
- **No new failure mode:** the scraper already handles concurrent LinkedIn sessions safely (shared-context/lease teardown was just hardened on our side, 2026-06-16). Worst case if you over-grant is wasted work, not corruption.

---

## How to verify after you deploy

Once the cap is live, two LinkedIn sessions should overlap. In the logs (`scraper_name="Aravind-Mini-PC-2"`) you'll see **two `Assignment started … linkedin` with different `session_id`s before the first one completes** — e.g.:

```
HH:MM:05  Assignment started … linkedin  (Role A, session 111…)
HH:MM:12  Assignment started … linkedin  (Role B, session 222…)   ← starts while A still running
HH:MM:48  Jobs submitted     … linkedin  (session 222, fast role done first)
HH:MM:59  Jobs submitted     … linkedin  (session 111, slow role)
```

Different roles finish at different times and each pulls its own next job — that's the goal. On the host you'd also see the LinkedIn browser showing **2 active tabs** instead of 1.

We can confirm it from our side via Grafana/Loki the moment you deploy.

---

## Report back to the scraper team

Please reply with:

1. **Which option** you implemented (A relax-exclusion / B multi-claim / the `max_inflight` param).
2. **Whether the cap is global or per-scraper-key** (we run one prod scraper today; local test runs use a different key — confirm both can get 2, or tell us which key got it).
3. **Deploy time (UTC)** so we can check Loki for overlapping LinkedIn sessions right after.
4. Confirm **other platforms are untouched** (still capped at 1).

---

## Appendix — endpoint reference (as the scraper uses them)

| Call | Method + path | Role in this issue |
|---|---|---|
| Availability pre-flight | `GET /api/scraper-credentials/queue/availability` | `0` excludes a platform; `999` = public |
| Claim next role | `GET /api/scraper/queue/next-role?platforms=<csv>` | **where the 2nd LinkedIn role is withheld today** |
| Submit results | `POST /api/scraper/queue/jobs` | `success` / `failed` |
| Complete session | `POST /api/scraper/queue/complete` | **frees the in-flight slot** |
| (Active-session guard) | `GET /api/scraper/queue/current-session` | returns `409` if a key already has an active session |

Auth: `X-Scraper-API-Key` header on every call.
