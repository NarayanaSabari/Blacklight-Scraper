# Backend Spec — Credential Cookie-Jar Refresh (write-back)

> **Audience:** Blacklight backend engineer.
> **Status:** rough spec / proposal for review — 2026-05-19. Backend paths are `server/`-relative and follow the conventions in [`SCRAPER_BACKEND_API.md`](./SCRAPER_BACKEND_API.md) and [`SCRAPER_AUTH_AND_ROLES.md`](./SCRAPER_AUTH_AND_ROLES.md).
> **One-line ask:** add a way for a scraper that holds a credential lease to **push the rotated cookie jar back**, so the next lease hands out a *fresh* jar instead of the frozen seed.

---

## 0. Why this is needed (empirically verified)

The scraper currently **replays a frozen cookie export** every run and never persists what the site rotated. We proved on a real LinkedIn account that in a **single ~3-minute authenticated session** the jar diverges from the seed:

- `lidc` value **rotated** (routing/affinity cookie — rolls every session)
- `bcookie` same value but expiry **renewed +185 days** (sliding expiration)
- `sdui_ver` +185d, `_uetvid` +246d (sliding renewal)
- `UserMatchHistory`, `AMCV…AdobeOrg` value changed
- Server **added** anti-abuse cookies (`audit_p`, `khaos_p`, `XANDR_PANID`, …)
- `li_at` itself was stable in a short session (it rolls on a *longer* cadence)

A frozen seed therefore drifts within days into something a real returning browser never looks like (stale `lidc`, un-renewed `bcookie`, missing anti-abuse cookies) — **that drift is itself an expiry / bot-flag trigger**, independent of `li_at`'s nominal date. Write-back keeps the pooled credential coherent and current, continuously renews sliding cookies, and — critically — **captures the new `li_at` the moment the site rotates it, before the old one is invalidated**.

The whole scraper↔backend credential contract today is **lease → success / failure / release**. There is **no path to persist a refreshed jar**. This spec fills exactly that gap. Everything scraper-side is ready; this backend endpoint is the only blocker.

---

## 1. Scope

**In scope:** persist a refreshed cookie jar for a *cookie-type* leased credential; hand out the latest jar on the next lease; ownership/concurrency/validation rules; observability.

**Out of scope:** email/password credentials (no jar — refresh is N/A / never called); changing the lease, success/failure, cooldown, or availability semantics; the scraper-side capture logic (summarized in §7 for context only).

**Design principle:** additive and backward-compatible. A scraper that never calls the new endpoint behaves exactly as today (keeps using the seed, expires as today). No existing endpoint changes behavior.

---

## 2. The endpoint

Recommended: a **dedicated, single-responsibility endpoint** (Option B). An alternative folded-into-`success` variant is in §6 — pick one; B is recommended.

```
POST /api/scraper-credentials/queue/<lease_id>/refresh
X-Scraper-API-Key: <raw key>
Content-Type: application/json
```

- `<lease_id>` is the **same lease id** used for `…/success` / `…/failure` / `…/release` (scraper client: `lease.id`).
- Same auth as every scraper endpoint: `require_scraper_auth` → `g.scraper_key` (see `SCRAPER_AUTH_AND_ROLES.md §1.3`). No new auth mechanism.

### 2.1 Request body

The **complete, authoritative** cookie jar captured from the browser at session close — the *same Chrome-cookie-export array shape the backend already returns* from `GET /queue/<platform>/next` for a cookie credential (round-trips its own schema):

```jsonc
{
  "cookies": [
    {
      "name": "li_at",
      "value": "<opaque>",
      "domain": ".www.linkedin.com",
      "path": "/",
      "secure": true,
      "httpOnly": true,
      "sameSite": "no_restriction",        // chrome-export style; backend stores verbatim
      "expirationDate": 1794729485.6011    // unix seconds (float ok); omitted/absent = session cookie
    }
    // … the FULL jar (typically 25–40 entries, a few KB). NOT a delta.
  ]
}
```

Rules for the body:

- It is the **entire jar**, not a diff and not just `li_at`. Backend stores it **wholesale, replacing** the prior jar for that credential. (Partial merges produce incoherent sessions — the scraper always sends the complete authoritative set.)
- The jar is **opaque** to the backend except for the validation in §3. Do not parse/normalize individual cookies; persist verbatim so it round-trips byte-for-byte to the next lease.
- Soft size cap: reject > **64 KB** with `413` (real jars are 3–8 KB).

### 2.2 Success response — `200 OK`

```jsonc
{
  "status": "refreshed",
  "credential_id": 42,
  "platform": "linkedin",
  "cookies_updated_at": "2026-05-19T12:34:56Z",
  "rotation_count": 7            // monotonic; how many times this credential's jar has been written back
}
```

---

## 3. Validation & integrity rules (the important part)

These are the backend-side guarantees that keep the pool from being poisoned. Implement all of them.

| # | Rule | On violation |
|---|------|--------------|
| 1 | **Lease ownership.** `<lease_id>` must be an **active** lease, owned by **this** `g.scraper_key`, for a cookie-type credential. | `403` if not owner; `404` if lease/credential unknown |
| 2 | **Lease still valid.** Lease not expired, not already `released`/`success`/`failure`-finalized, and the underlying credential has not been re-leased/replaced since this lease was issued (optimistic concurrency — compare a credential `version`/`updated_at` captured at lease time). | `409 {"error":"lease superseded"}` — a slow scraper must never clobber a credential someone else has since refreshed |
| 3 | **Auth-cookie presence (anti-poison).** The jar **must contain the platform's required auth cookie** with a non-empty value. Per-platform map, backend-owned; e.g. `linkedin → li_at`. A jar missing it is a logged-out/auth-walled session — refuse it. | `400 {"error":"jar missing required auth cookie for <platform>"}` — **do not persist** |
| 4 | **Well-formed.** `cookies` is a non-empty array; each entry has at least `name`,`value`,`domain`. | `400` |
| 5 | **Size cap.** Body ≤ 64 KB. | `413` |
| 6 | **Rate limit.** Reuse the key's existing `rate_limit`; refresh is at most once per session so this is generous. | `429` |
| 7 | **Idempotent.** If the posted jar is byte-identical to what's stored (hash compare), treat as a no-op success (still `200`, `rotation_count` unchanged). | — |

Rule 3 is the backend mirror of the scraper-side guard (“only write back if the session ended still authenticated”). Defense in depth: **both** sides refuse a poisoned jar.

---

## 4. Data model (suggested — backend owns the final shape)

The leased credential record needs the jar to become **mutable state** plus a little metadata. Illustrative columns on the existing scraper-credential row (adapt to the real model):

| Field | Type | Purpose |
|---|---|---|
| `cookies` | JSONB / encrypted blob | The current authoritative jar. Seeded at creation; **overwritten** by refresh. Handed out by `…/next`. |
| `cookies_updated_at` | timestamptz | Last successful write-back (null = still the original seed). |
| `rotation_count` | int | Monotonic refresh counter (observability / “is this credential actually being kept alive?”). |
| `cookies_sha256` | text | Hash of the stored jar for the idempotency no-op check (never store/return raw values in logs). |
| `auth_cookie_expires_at` | timestamptz (derived) | Min of the auth-cookie / key sliding-cookie expirations, recomputed on each refresh. Powers proactive “credential approaching expiry / stale” alerting (see §5). |

Storage posture: **match the existing credential store** — if seed credentials are encrypted at rest, the refreshed jar must be too. Never log cookie values; logs/audit use `credential_id` + `cookies_sha256` + `rotation_count` only.

The key behavioral change: **`GET /api/scraper-credentials/queue/<platform>/next` must return the latest `cookies` (the refreshed jar), not the original seed.** That single read-path change + this write endpoint is the whole feature.

---

## 5. Lifecycle & interaction with existing endpoints

- **Independent of verdict.** Refresh does not finalize the lease. Normal scraper order: `refresh` (if authed & jar changed) → then `POST …/success`. The lease is still released by `success`/`failure`/`release` as today.
- **Failure path.** If the session ended unauthenticated, the scraper reports `failure` and **does not** call refresh (and Rule 3 would reject it anyway). Existing `cooldown_minutes` benching is unchanged. A benched/cooled credential simply keeps whatever jar it last had.
- **Re-lease.** Next `…/next` for that platform hands out the freshest jar. Pool-selection (if you pick “freshest” / least-recently-failed) can use `cookies_updated_at` / `auth_cookie_expires_at`.
- **Concurrency.** Leasing is exclusive (one active lease per credential), so within a lease last-write-wins is correct; Rule 2 prevents a stale lease from overwriting a credential that has since moved on.
- **Proactive expiry (bonus, enabled by `auth_cookie_expires_at`).** Backend can now alert when a pooled credential’s freshest jar is approaching auth-cookie expiry **or hasn’t been refreshed in N days** (stale jar = at-risk) — refresh *before* an outage instead of after. This is the “Tier 2” win and is essentially free once the metadata exists.

---

## 6. Alternative: fold into `…/success` (Option A)

If you prefer one fewer round-trip, accept an optional field on the existing success call:

```
POST /api/scraper-credentials/queue/<lease_id>/success
{ "message": "...", "refreshed_cookies": [ ... ] }   // optional; absent = behave exactly as today
```

Backend applies §3 validation to `refreshed_cookies`; if it fails validation, **still record the success** but **skip the jar update** and return a soft warning (don’t fail the success over a bad jar). Trade-off: simpler wire flow, but it overloads `success` semantics and couples jar persistence to lease finalization. **Recommendation: Option B (dedicated `…/refresh`)** — single responsibility, independently authorizable/observable, and a bad jar can’t complicate verdict reporting. Pick one and tell the scraper team which; the scraper side is a ~1-call difference.

---

## 7. Scraper-side companion (context only — not backend work)

So you know your caller. At session close the scraper will:

1. Only if the session ended **authenticated** (page state = results/feed, not auth-wall/checkpoint) **and** the jar changed vs the leased one,
2. capture the full `context.cookies()` (same array shape as §2.1),
3. `POST …/<lease_id>/refresh` with it, **then** `POST …/success`.

It will **never** send a jar from a logged-out/auth-walled session (Rule 3 is the backend backstop). It sends the complete jar, never a delta. This is gated behind the scraper being in REMOTE mode with a valid lease; nothing ships scraper-side until this endpoint exists.

---

## 8. Status-code reference (for the integration doc)

| Code | Meaning | Scraper action |
|---|---|---|
| `200` | Jar stored (or idempotent no-op) | Proceed to `…/success` |
| `400` | Malformed jar, or missing the platform’s required auth cookie | Log; do **not** retry; proceed to `…/success` without refresh (don’t fail the scrape over it) |
| `401` | Missing/invalid/revoked key | Fatal — fix the key |
| `403` | Caller is not the lease holder | Abandon refresh; continue |
| `404` | Lease / credential not found | Abandon refresh; continue |
| `409` | Lease expired or superseded since issue | Abandon refresh (a newer lease owns the credential); continue |
| `413` | Jar too large | Log; skip refresh |
| `429` | Rate limited | Skip refresh this cycle |
| `5xx` | Backend error | Skip refresh (best-effort; never block the scrape/verdict on it) |

Refresh is **best-effort**: a failed refresh must never fail the scrape or the lease verdict.

---

## 9. Acceptance criteria

1. New cookie-type credential: first `…/next` returns the seed; after a `…/refresh`, the **next** `…/next` returns the **refreshed** jar byte-for-byte.
2. `…/refresh` from a non-lease-holder key → `403`; unknown lease → `404`; finalized/superseded lease → `409`; jar without `li_at` (LinkedIn) → `400` and **stored jar unchanged**.
3. Posting the identical jar twice → `200` both times, `rotation_count` increments only on actual change.
4. Cookie values never appear in logs/audit/metrics; jar encrypted at rest if seeds are.
5. Existing scrapers that never call `…/refresh` are byte-for-byte unaffected.
6. `rotation_count` / `cookies_updated_at` visible in the centralD credential view; optional alert when a pooled credential is stale or near auth-cookie expiry.

---

## 10. Open questions for the backend engineer

1. Where do scraper credentials live (table/columns) and what is the at-rest encryption posture to match?
2. Option B (dedicated `…/refresh`) vs Option A (fold into `…/success`) — your call; scraper adapts.
3. The per-platform **required auth cookie** map — confirm `linkedin → li_at`; define for any other cookie platforms (glassdoor/indeed) you intend to pool.
4. Pool selection: should `…/next` prefer the credential with the freshest / furthest-from-expiry jar? (Enabled by §4 metadata; not required for v1.)
5. Concurrency token: do credential rows already have a `version`/`updated_at` usable for the Rule-2 superseded check, or is one to be added?
