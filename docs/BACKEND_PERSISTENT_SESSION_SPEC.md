# Backend Spec — Long-lived credential lease for the persistent-browser scraper

> **Date:** 2026-05-21 · **For:** the Blacklight backend engineer.
> **Context:** the LinkedIn scraper is moving from "cold-launch a fresh browser + re-inject cookies per role" to **one long-lived browser session per scraper process** (decision D1b — long-lived stealth Chromium, cookies injected once, a new tab per role). The scraper-side design is in the scraper repo (`docs/superpowers/specs/2026-05-21-linkedin-persistent-session-design.md`). This doc is the **backend half**: let one scraper hold one credential for hours instead of leasing per role.
> **TL;DR:** add a **heartbeat** endpoint and switch stale-lease reaping to heartbeat-based, so a continuously-scraping browser can legitimately hold its credential for its whole lifetime. The role queue stays per-role; only the **credential lease** becomes once-per-browser. Do **not** revert the cookie write-back yet — only after the scraper validates the persistent model in prod.

---

## 1. The model change

**Today (lease-per-role):**
```
per role:  GET /queue/<platform>/next  → credential marked in_use + assigned_to_session_id
           ... scrape ...
           POST /queue/<id>/success|failure|release  → credential freed
```
The credential is leased and released for **every role**. A stale-assignment timeout reaps credentials stuck `in_use`.

**Proposed (lease-once-per-browser):**
```
on browser start:   GET /queue/<platform>/next  → lease ONE credential, hold it
while alive:         POST /queue/<id>/heartbeat  (every ~2 min)   ← NEW
per role:            (no re-lease; reuse held credential) report per-role success/failure as today
on browser stop:     POST /queue/<id>/release
```
One browser drains many roles against one held credential. Reaping must now key off **heartbeat staleness**, not a fixed assignment age — otherwise a legitimately-busy browser gets its credential yanked mid-run.

---

## 2. Required changes

### 2.1 NEW: heartbeat endpoint
```
POST /api/scraper-credentials/queue/<credential_id>/heartbeat
Header: X-Scraper-API-Key: <key>
Body:   { "session_id": "<the lease session_id>" }
```
- **Auth/ownership:** same key auth as the other `/queue/<id>/*` routes. Verify the credential is currently `in_use` AND `assigned_to_session_id == session_id` from the body (reject otherwise — a heartbeat from a non-owner must not refresh the lease).
- **Effect:** set `last_heartbeat_at = now()` on the credential row.
- **Responses:** `200 {"status":"ok","last_heartbeat_at":...}` on success; `404` unknown credential; `409 {"status":"not_owner"}` if the session no longer owns the lease (the scraper treats 409 as "I lost my lease → re-acquire / re-establish"); `401` bad key.
- Idempotent; cheap; called every ~2 min per live browser.

### 2.2 CHANGE: stale-lease reaping → heartbeat-based
- Add column `last_heartbeat_at TIMESTAMP NULL` to the scraper-credentials table (set on acquire and on each heartbeat).
- In `cleanup_stale_scraper_credentials` (the existing reaper): release a credential held `in_use` only if **`last_heartbeat_at` is older than `HEARTBEAT_TIMEOUT` (suggest 10 min)** — not on a fixed assignment age.
  - Back-compat: if `last_heartbeat_at IS NULL` (a legacy per-role lease that never heartbeats), keep the **old** assignment-age timeout so other platforms' per-role leases still get reaped normally. Only heartbeating leases get the long-lived treatment.
- Net: a browser heartbeating every 2 min holds its credential indefinitely; a crashed browser stops heartbeating and is reaped within ~10 min so the credential returns to the pool.

### 2.3 KEEP: the role queue is unchanged
- `GET /api/scraper/queue/next-role` (what to scrape) is untouched and stays per-role.
- The credential lease (`GET /queue/<platform>/next`) is now called **once per browser** by the scraper, not per role. No backend change needed to *enforce* this — the scraper simply stops re-leasing — but the reaping change (2.2) is what makes holding safe.

### 2.4 KEEP (do NOT revert yet): cookie write-back
- Leave `POST /queue/<id>/refresh` + the 4 metadata columns (`cookies_updated_at`, `rotation_count`, `cookies_sha256`, `auth_cookie_expires_at`) in place **until the scraper team confirms the persistent model works in prod.** Reverting working code before the replacement is validated risks having neither. The scraper will stop *calling* `/refresh` first (no traffic), then we revert the route + columns in a follow-up once validated. (Optional: keep a single `cookies_updated_at` + storage write if we want persist-on-shutdown seeding — scraper decision D3, TBD.)

### 2.5 KEEP: everything else
- Cooldown auto-recovery semantics (positive `cooldown_minutes` → COOLDOWN, not sticky FAILED) — still correct and still used for **per-role** failure handling against the held lease.
- The Edit-credential UI (load fresh cookies / email+password).
- The auth `== True` fix.

---

## 3. Failure / ownership edge cases to handle

| Case | Expected backend behavior |
|---|---|
| Heartbeat for a credential the session no longer owns (got reaped, reassigned) | `409 not_owner` — scraper re-acquires |
| Heartbeat after the browser crashed (stops arriving) | reaper releases after `HEARTBEAT_TIMEOUT`; credential returns to pool |
| `release` never arrives (hard crash) | same as above — heartbeat staleness is the backstop |
| Two scraper processes, one credential | only one can hold `in_use`; the second's `GET /queue/next` returns a different cred or none (existing behavior) |
| Per-role `failure` with `cooldown_minutes>0` while holding the lease | apply cooldown to the credential as today; the scraper will `release` + re-acquire a different cred on its side |

---

## 4. Rollout (coordinated with scraper)

1. **Backend ships 2.1 + 2.2** (heartbeat endpoint + heartbeat-based reaping + `last_heartbeat_at` column) behind no behavior change for non-heartbeating leases. *This unblocks the scraper's Phase 2.*
2. Scraper ships Phase 1 (persistent session, no heartbeat) for local validation — does not need the backend yet, but with 1 cred there's no contention so the existing reaper won't bite in practice.
3. Scraper ships Phase 2 (heartbeat client + reestablish) once 2.1/2.2 are live.
4. After prod validation: revert write-back (2.4) in a follow-up.

## 5. The one number to verify

After the scraper holds a lease and heartbeats:
```sql
SELECT id, status, assigned_to_session_id, last_heartbeat_at FROM scraper_credentials WHERE id = 12;
```
- `last_heartbeat_at` advances every ~2 min while the browser is alive → lease held correctly.
- Credential stays `in_use` across many role scrapes (not flipping in_use→available per role) → lease-once working.
- After a forced browser kill, the credential returns to the pool within ~10 min → reaping works.

## 6. Migration note

`last_heartbeat_at` is a single nullable column add — a normal forward migration, not a parallel head. (Unlike the write-back migration `r2s3t4u5v6w7`, which when we eventually revert needs a forward drop migration, not an un-merge.)
