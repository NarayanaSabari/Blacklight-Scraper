# Design — Scraper-side Cookie-Jar Write-back + §5 Graceful-Fail Fix

> Status: approved 2026-05-19. Source of truth for the implementation plan.
> Backend contract is **fixed and deployed** (`docs/BACKEND_CREDENTIAL_REFRESH_SPEC.md` → backend handoff). This spec is the *scraper-side* change only.

## 1. Goal

After a LinkedIn (cookie-credential) scrape that ended **still authenticated**, capture the full browser cookie jar and POST it to the deployed
`POST /api/scraper-credentials/queue/<credential_id>/refresh` **before** reporting the lease verdict, so the next lease of that credential gets a fresh jar instead of the decaying frozen seed. Additionally, fix the adjacent §5 bug where a logged-out cookie credential crashes (`CONFIG.email is not iterable`) and permanently burns the credential.

Empirical basis: a single ~3-min authenticated session rotates `lidc`, slides `bcookie`/`sdui_ver` expiry +185d, adds anti-abuse cookies; the frozen seed drifts into a bot-flag/expiry trigger within days. See memory `linkedin-cookie-expiry-analysis`.

## 2. Fixed external contract (from backend handoff — do not redesign)

```
POST https://api.qpeakhire.com/api/scraper-credentials/queue/<credential_id>/refresh
X-Scraper-API-Key: <key>          # same header already used for success/failure/release
Content-Type: application/json
{ "session_id": "<same session_id passed to GET /queue/<platform>/next at lease time>",
  "cookies": [ <full Chrome-export jar, every cookie, not a delta> ] }
```
- `<credential_id>` == `lease.id` (already used by `#postLeaseAction` for success/failure/release).
- Backend rejects a jar missing the platform auth cookie (`linkedin → li_at`) with `400 missing_auth_cookie`; rejects `>64 KB` with `413`; is idempotent (order-independent hash, returns `200 "unchanged"`); `409 superseded` if the lease/session no longer matches.
- **Golden rule:** refresh is best-effort. A non-`200` must never fail the scrape or change the success/failure verdict.

## 3. Architecture (Approach 1 — thin method + 2-line call site + pure §5 helper)

Three components. The cookie jar and the "ended authenticated" signal only exist inside `scrapers/linkedin.js`'s browser scope, so the call site lives there; all HTTP/lease plumbing stays beside its siblings in `src/api/credentials.js`.

### Component A — `src/api/credentials.js`

**A1. Thread `sessionId` onto the lease.** Currently `acquire(platform, sessionId)` uses `sessionId` only for the `?session_id=` acquire query (lines ~112) and discards it; `#issueLease(platform, id, data)` (line ~51) stores `{leaseKey, platform, id, data}`. Change `#issueLease` to also store `sessionId`, and pass it from both `acquire` branches (REMOTE line ~142 and local line ~107). The refresh body requires the exact same `session_id`.

**A2. New method `async refreshCookies(leaseKeyOrPlatform, cookies)`** — structured exactly like `reportSuccess` (lines ~169-187):
- `#resolveLease`; if none → `log.warn` + return (no throw).
- If `this.isLocal || String(lease.id).startsWith('local-')` → **no-op** (REMOTE-only; LOCAL is a documented non-goal — §6), record metric `skipped_local`, return.
- Client-side mirror of backend Rule 3: if `cookies` is not a non-empty array, or has no entry with `name === 'li_at'` and a non-empty `value`, or `JSON.stringify({session_id,cookies})` byte length `> 64*1024` → `log.warn` + metric `skipped_no_li_at` (or `skipped_too_large`) + return (do not POST a guaranteed reject).
- Else `await this.#postLeaseAction(lease, 'refresh', { session_id: lease.sessionId ?? null, cookies })` inside `try/catch`. On success `log.info('Credential jar refreshed', { platform: lease.platform })` + metric `refreshed`. On any error `log.warn('Credential refresh failed (best-effort)', { platform: lease.platform, err: error.message })` + metric `error`. **Never re-throw. Never `#forgetLease`** — refresh is non-terminal; `reportSuccess`/`reportFailure`/`release` still own lease lifecycle.

**A3. Expose on the `#wrapLease` facade** (lines ~151-160): add `refreshCookies: (cookies) => this.refreshCookies(lease.leaseKey, cookies)`.

**A4. Metric.** Add `recordCredentialRefresh(platform, outcome)` to the metrics registry mirroring the existing `recordCredentialsFetch(platform, outcome)` shape; `outcome ∈ {refreshed, skipped_local, skipped_no_li_at, skipped_too_large, error}`.

### Component B — `scrapers/linkedin.js` write-back call site

On the success path, immediately **before** `await lease.reportSuccess(...)` (currently line ~1411). `context` from `launchWithCookies` (line ~1229) is still open here — the `finally` (line ~1466) closes only `browser`. Insert:
```js
const jar = await context.cookies().catch(() => null);
await lease.refreshCookies(jar);          // best-effort; never throws
```
Reaching this line already implies an authenticated session (an auth-wall throws `AuthError` at line ~518, long before). Order is refresh → success because `reportSuccess` calls `#forgetLease` (matches handoff §4). No other change to the success path; the returned `{ jobs, emptyConfirmed }` contract is untouched.

### Component C — §5 graceful-fail fix (`scrapers/linkedin.js`)

**C1. Pure helper** `export function canPasswordLogin(credential)` → `true` iff `credential` has a non-empty string `email` **and** non-empty string `password`. (Cookie-only leased credentials have neither.)

**C2. `ensureLoggedIn(page, credential)`** (currently line ~206, takes only `page`): when `!isAuthenticatedPage(currentUrl)` (line ~217 is the authed branch; the else at ~222 currently calls `performLogin`): if `!canPasswordLogin(credential)` →
```js
throw new AuthError(
  'LinkedIn session not authenticated and credential has no password to log in with (cookies expired/rotated)',
  { platform: 'linkedin' });
```
instead of calling `performLogin`. This routes through the existing `AuthError` branch (line ~1436) — typed, classified, **no `CONFIG.email` iteration, no crash.** `ensureLoggedIn`'s caller must pass `credential` through (it is in scope where `ensureLoggedIn` is invoked).

**C3. Recoverable cooldown.** The `AuthError` branch currently calls `await lease.reportFailure('Auth/cookies expired: …', 0)` (line ~1438). Replace the literal `0` with a single named constant `const COOKIES_EXPIRED_COOLDOWN_MIN = 60;` (declared near the other tuning constants) so a dead cookie session **benches-and-rotates for 60 min** instead of a permanent-`0` burn — satisfying the handoff's "recoverable, not permanent." This is the only behavioral change to the `AuthError` routing and it is shared by both the §5 path (C2) and the existing post-search auth-wall path (line ~518); both are "cookies expired" and want the same recoverable semantics.

## 4. Data flow

`acquire('linkedin', sessionId)` → lease carries `{id, sessionId}` → scrape →
**success:** `context.cookies()` → `lease.refreshCookies(jar)` → POST `…/<lease.id>/refresh {session_id, cookies}` (best-effort, swallowed) → `lease.reportSuccess()` →
**logged-out cookie cred:** `ensureLoggedIn` → `AuthError` → `reportFailure('Auth/cookies expired…', 60)` → backend benches + rotates; out-of-band / another session's write-back recovers it.

## 5. Error handling

Every refresh failure (HTTP non-2xx incl. 400/409/413, network error, malformed jar, missing `li_at`) is caught, logged at `warn`, recorded as a metric, and **discarded**. It can never change the scrape result, the `{jobs,emptyConfirmed}` payload, or the success/failure verdict. `reportSuccess` already independently swallows its own errors; `refreshCookies` precedes it and is independently best-effort.

## 6. Non-goals (YAGNI — explicit)

- **No LOCAL-file write-back.** LOCAL mode `refreshCookies` is a deliberate no-op; LOCAL users refresh by re-pasting via the setup wizard's merge mode. (Handoff is REMOTE-only.)
- **No client-side jar-change detection.** Backend is idempotent and explicitly says this is optional; POST whenever on the success path with a valid `li_at`. Simpler, fewer moving parts.
- **No Glassdoor/Indeed wiring.** `refreshCookies` is generic and reusable, but only LinkedIn's pain is proven; wiring others is a future, separate change.
- No change to acquire/success/failure/release/availability semantics or the BaseScraper return contract.

## 7. Testing strategy

**Unit (new):**
- `test/api/credentials.test.js` (reuse the existing HTTP-mock harness used for `reportSuccess`/`reportFailure`):
  - REMOTE happy path: `refreshCookies` POSTs to `…/queue/<id>/refresh` with body `{ session_id: <the sessionId passed to acquire>, cookies }` — asserts the URL, the threaded `session_id`, and the cookies round-trip.
  - `sessionId` is threaded from `acquire(platform, sessionId)` onto the lease (regression-pins A1).
  - LOCAL / `local-` lease → no HTTP, returns, metric `skipped_local`.
  - jar without a non-empty `li_at`, empty/non-array jar, and `>64 KB` jar → no HTTP, returns, correct metric.
  - HTTP error / network throw → `refreshCookies` resolves (never throws) and does **not** forget the lease (a following `reportSuccess` still works).
- `test/scrapers/linkedin-helpers.test.js` (or the existing linkedin pure-helper test file): `canPasswordLogin` truth table — `{email,password}` present/non-empty → true; missing/empty either → false; `null`/`undefined` credential → false.

**Empirical:** the established local headed run validates the wired path (jar captured on success, `refreshCookies` invoked, §5 logged-out cred → AuthError + 60-min cooldown, no crash). **Honest caveat:** full REMOTE end-to-end against prod cannot be verified here because the currently-provided API key 401s (`Invalid or revoked`); REMOTE is validated by the unit tests + the backend team's handoff §6 curl test + log/metric inspection. This limitation is stated, not worked around.

**Regression:** full `npm test` green; the inert/byte-identical guarantees of prior phases unaffected (write-back only adds a best-effort call on the success path; §5 only changes a crash into a typed AuthError + a named cooldown constant).

## 8. Security

Cookie values are secrets: never log jar values (log counts/outcomes/`platform` only — mirrors the existing credential-logging discipline); the jar travels only over HTTPS to the existing authenticated endpoint; nothing is written to disk or git. No new secret persistence on the scraper host.

## 9. Acceptance criteria

1. Successful LinkedIn scrape → exactly one `refresh` POST to `…/<lease.id>/refresh` with the correct `session_id` and full jar, **before** the `success` POST; a refresh failure does not change the reported verdict or returned jobs.
2. A logged-out **cookie-only** credential → `AuthError` (no `CONFIG.email`/iteration crash) → `reportFailure(…, 60)`; the credential is recoverable, not permanently burned.
3. LOCAL mode unchanged (no HTTP from `refreshCookies`).
4. `npm test` green incl. the new unit tests; no cookie value ever logged.
5. Existing scrapers/flows byte-unchanged except: +1 best-effort call on the LinkedIn success path, and the §5 crash→AuthError+60-min routing.
