# Cookie-Jar Write-back + §5 Graceful-Fail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a LinkedIn cookie-credential scrape that ended authenticated, POST the full browser cookie jar to the deployed `…/queue/<credential_id>/refresh` before reporting the lease verdict; and fix the §5 crash where a logged-out cookie credential hits `for (let char of CONFIG.email)` → permanent-0 credential burn.

**Architecture:** Pure decider `planCookieRefresh()` + pure `canPasswordLogin()` carry all the new logic and get exhaustive unit tests; thin I/O wiring in `src/api/credentials.js` (`refreshCookies` mirrors `reportSuccess`) and a 2-line call site + 3-line guard in `scrapers/linkedin.js` are best-effort, never-throw, and verified by the established local empirical run. Zero new dependencies.

**Tech Stack:** Node 20+ ESM (host Node v24.14.0), `node:test` + `node:assert/strict`, `prom-client` (existing), the existing `requestWithRetry` HTTP client.

> **Source of truth:** `docs/superpowers/specs/2026-05-19-cookie-writeback-design.md`. Backend contract: `docs/BACKEND_CREDENTIAL_REFRESH_SPEC.md`.
> **Node 24:** run a single file with `node --test test/path/file.test.js`; full suite `npm test` (= `node --test 'test/**/*.test.js'`). Success = the task's tests pass AND `fail 0`.
> **Never stage** `.gitignore` or `pnpm-lock.yaml` (pre-existing unrelated dirty). Never log cookie values.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/metrics/registry.js` | Prometheus metrics | Modify: add `credentialRefreshesTotal` counter + `recordCredentialRefresh()` |
| `src/api/credentials.js` | Credential lease client | Modify: export pure `planCookieRefresh`; thread `sessionId` onto leases; add `refreshCookies` method + facade entries; `export` the class |
| `test/api/credentials-refresh.test.js` | Pure decider + method tests | Create |
| `test/metrics/credential-refresh-metric.test.js` | Metric safe-call test | Create |
| `scrapers/linkedin.js` | LinkedIn scraper | Modify: write-back call site; `export canPasswordLogin`; §5 guard in `ensureLoggedIn`; `COOKIES_EXPIRED_COOLDOWN_MIN` constant |
| `test/scrapers/linkedin-can-password-login.test.js` | `canPasswordLogin` truth table | Create |
| `docs/superpowers/plans/2026-05-19-cookie-writeback-NOTES.md` | Completion notes | Create (Task 6) |

---

## Task 1: Metrics counter `recordCredentialRefresh`

**Files:** Modify `src/metrics/registry.js`; Create `test/metrics/credential-refresh-metric.test.js`

- [ ] **Step 1: Write the failing test** — create `test/metrics/credential-refresh-metric.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMetrics } from '../../src/metrics/registry.js';

test('recordCredentialRefresh exists and is crash-safe for any args', () => {
    const m = getMetrics();
    assert.equal(typeof m.recordCredentialRefresh, 'function');
    // #safe wraps inc(); bad labels must never throw and crash the scrape loop.
    assert.doesNotThrow(() => m.recordCredentialRefresh('linkedin', 'refreshed'));
    assert.doesNotThrow(() => m.recordCredentialRefresh('linkedin', 'skipped_no_li_at'));
    assert.doesNotThrow(() => m.recordCredentialRefresh(undefined, undefined));
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/metrics/credential-refresh-metric.test.js` (method undefined).

- [ ] **Step 3: Add the counter.** In `src/metrics/registry.js`, immediately AFTER the `this.credentialsFetchesTotal = new Counter({...});` block (ends line ~224) and BEFORE the `// Logger tap` comment (line ~226), insert:

```js
        this.credentialRefreshesTotal = new Counter({
            name: 'scraper_credential_refreshes_total',
            help: 'Cookie-jar write-back attempts per platform.',
            labelNames: ['platform', 'outcome'], // refreshed|skipped_local|skipped_no_li_at|skipped_too_large|error
            registers: reg,
        });
```

- [ ] **Step 4: Add the recorder.** Immediately AFTER the `recordCredentialsFetch(platform, result) { … }` method (ends line ~321), insert:

```js
    recordCredentialRefresh(platform, outcome) {
        this.#safe(() => this.credentialRefreshesTotal.labels(platform, outcome).inc());
    }
```

- [ ] **Step 5: Run → PASS** — `node --test test/metrics/credential-refresh-metric.test.js` (1 pass, 0 fail).

- [ ] **Step 6: Commit**

```bash
git add src/metrics/registry.js test/metrics/credential-refresh-metric.test.js
git commit -m "feat(metrics): scraper_credential_refreshes_total counter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure decider `planCookieRefresh`

**Files:** Modify `src/api/credentials.js`; Create `test/api/credentials-refresh.test.js`

- [ ] **Step 1: Write the failing test** — create `test/api/credentials-refresh.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCookieRefresh } from '../../src/api/credentials.js';

const LI = [{ name: 'li_at', value: 'tok', domain: '.www.linkedin.com' },
            { name: 'lidc', value: 'x', domain: '.linkedin.com' }];

test('local lease → skip (skipped_local), no body', () => {
    const p = planCookieRefresh({ isLocal: true, sessionId: 's', cookies: LI });
    assert.equal(p.action, 'skip');
    assert.equal(p.outcome, 'skipped_local');
});

test('missing/empty/li_at-less jar → skip (skipped_no_li_at)', () => {
    for (const c of [null, undefined, [], [{ name: 'lidc', value: 'x' }],
                     [{ name: 'li_at', value: '' }], [{ name: 'li_at' }]]) {
        const p = planCookieRefresh({ isLocal: false, sessionId: 's', cookies: c });
        assert.equal(p.action, 'skip', JSON.stringify(c));
        assert.equal(p.outcome, 'skipped_no_li_at');
    }
});

test('valid jar → post with body { session_id, cookies }', () => {
    const p = planCookieRefresh({ isLocal: false, sessionId: 'sess-9', cookies: LI });
    assert.equal(p.action, 'post');
    assert.equal(p.outcome, 'refreshed');
    assert.deepEqual(p.body, { session_id: 'sess-9', cookies: LI });
});

test('null sessionId still posts with session_id:null (backend will 409 if it must)', () => {
    const p = planCookieRefresh({ isLocal: false, sessionId: null, cookies: LI });
    assert.equal(p.action, 'post');
    assert.equal(p.body.session_id, null);
});

test('jar over 64 KB → skip (skipped_too_large)', () => {
    const big = [{ name: 'li_at', value: 'v', domain: '.www.linkedin.com' },
                 { name: 'pad', value: 'A'.repeat(70 * 1024), domain: '.linkedin.com' }];
    const p = planCookieRefresh({ isLocal: false, sessionId: 's', cookies: big });
    assert.equal(p.action, 'skip');
    assert.equal(p.outcome, 'skipped_too_large');
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/api/credentials-refresh.test.js` (export missing).

- [ ] **Step 3: Implement.** In `src/api/credentials.js`, after the imports and `const log = createLogger('credentials');` (line ~31) and BEFORE `class CredentialsClient {`, add the exported pure function:

```js
// Pure decision for the cookie-jar write-back (handoff §3/§4). No I/O.
// Mirrors the backend's reject rules so we never POST a guaranteed-400:
// local → no-op; jar must be a non-empty array containing a non-empty
// `li_at`; serialized body must be ≤ 64 KB.
export function planCookieRefresh({ isLocal, sessionId, cookies }) {
    if (isLocal) return { action: 'skip', outcome: 'skipped_local' };
    const hasAuth = Array.isArray(cookies) && cookies.length > 0
        && cookies.some((c) => c && c.name === 'li_at'
            && typeof c.value === 'string' && c.value.length > 0);
    if (!hasAuth) return { action: 'skip', outcome: 'skipped_no_li_at' };
    const body = { session_id: sessionId ?? null, cookies };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 64 * 1024) {
        return { action: 'skip', outcome: 'skipped_too_large' };
    }
    return { action: 'post', outcome: 'refreshed', body };
}
```

- [ ] **Step 4: Run → PASS** — `node --test test/api/credentials-refresh.test.js` (5 pass, 0 fail).

- [ ] **Step 5: Commit**

```bash
git add src/api/credentials.js test/api/credentials-refresh.test.js
git commit -m "feat(credentials): pure planCookieRefresh decider (mirrors backend reject rules)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire `refreshCookies` into the lease client

**Files:** Modify `src/api/credentials.js`; append to `test/api/credentials-refresh.test.js`

- [ ] **Step 1: Write the failing test** — append to `test/api/credentials-refresh.test.js`:

```js
import { CredentialsClient } from '../../src/api/credentials.js';

test('refreshCookies with no active lease: returns, never throws', async () => {
    const c = new CredentialsClient({ apiUrl: 'https://x', apiKey: 'k' });
    await assert.doesNotReject(() => c.refreshCookies('linkedin', [{ name: 'li_at', value: 'v' }]));
});

test('refreshCookies on a local-lease client is a no-op (no throw, no HTTP)', async () => {
    const c = new CredentialsClient({ apiUrl: 'https://x', apiKey: 'k' });
    // Issue a synthetic local-style lease via the public wrap path:
    const lease = c._issueLeaseForTest('linkedin', 'local-linkedin', { id: 'local-linkedin' }, 'sess-77');
    assert.equal(lease.sessionId, 'sess-77');                 // pins sessionId threading (A1)
    assert.equal(typeof lease.refreshCookies, 'function');     // pins facade (A3)
    await assert.doesNotReject(() => lease.refreshCookies([{ name: 'li_at', value: 'v' }]));
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/api/credentials-refresh.test.js` (`CredentialsClient` not exported / `_issueLeaseForTest` missing).

- [ ] **Step 3: Implement** in `src/api/credentials.js`:

**3a.** Export the class: change `class CredentialsClient {` to `export class CredentialsClient {`.

**3b.** Thread `sessionId` through `#issueLease`. Replace the whole method (currently lines ~51-58):

```js
    #issueLease(platform, id, data, sessionId = null) {
        const nonce = this.nextNonce++;
        const leaseKey = `${platform}:${id}:${nonce}`;
        const lease = { leaseKey, platform, id, data, sessionId };
        this.leases.set(leaseKey, lease);
        this.latestByPlatform.set(platform, leaseKey);
        return lease;
    }

    // Test-only: construct a lease + facade without network/config. Not
    // used in production paths (mirrors resetConfigForTest convention).
    _issueLeaseForTest(platform, id, data, sessionId = null) {
        return this.#wrapLease(this.#issueLease(platform, id, data, sessionId));
    }
```

**3c.** Pass `sessionId` at both `acquire` call sites. The local branch (currently line ~107) `const lease = this.#issueLease(platform, id, { id, ...cred });` → add `, sessionId`:

```js
            const lease = this.#issueLease(platform, id, { id, ...cred }, sessionId);
```

The REMOTE branch (currently line ~142) `const lease = this.#issueLease(platform, credential.id, credential);` → add `, sessionId`:

```js
        const lease = this.#issueLease(platform, credential.id, credential, sessionId);
```

**3d.** Add the `refreshCookies` method immediately AFTER `reportSuccess` (after its closing brace, line ~187):

```js
    async refreshCookies(leaseKeyOrPlatform, cookies) {
        const lease = this.#resolveLease(leaseKeyOrPlatform);
        if (!lease) {
            log.warn('No active credential to refresh cookies for', { key: leaseKeyOrPlatform });
            return;
        }
        const metrics = getMetrics();
        const isLocal = this.isLocal || String(lease.id).startsWith('local-');
        const plan = planCookieRefresh({ isLocal, sessionId: lease.sessionId, cookies });
        if (plan.action === 'skip') {
            metrics.recordCredentialRefresh(lease.platform, plan.outcome);
            log.info('Cookie write-back skipped', { platform: lease.platform, reason: plan.outcome });
            return;
        }
        try {
            await this.#postLeaseAction(lease, 'refresh', plan.body);
            metrics.recordCredentialRefresh(lease.platform, 'refreshed');
            log.info('Credential jar refreshed', { platform: lease.platform });
        } catch (error) {
            metrics.recordCredentialRefresh(lease.platform, 'error');
            log.warn('Credential refresh failed (best-effort, ignored)', { platform: lease.platform, err: error.message });
        }
        // NOTE: never #forgetLease — refresh is non-terminal; success/
        // failure/release still own lease lifecycle (handoff §4).
    }
```

**3e.** Extend the `#wrapLease` facade (currently lines ~151-160) — add the `sessionId` getter and `refreshCookies`:

```js
    #wrapLease(lease) {
        return {
            get leaseKey() { return lease.leaseKey; },
            get credential() { return lease.data; },
            get platform() { return lease.platform; },
            get sessionId() { return lease.sessionId; },
            reportSuccess: (message) => this.reportSuccess(lease.leaseKey, message),
            reportFailure: (msg, cooldownMinutes) => this.reportFailure(lease.leaseKey, msg, cooldownMinutes),
            refreshCookies: (cookies) => this.refreshCookies(lease.leaseKey, cookies),
            release: () => this.release(lease.leaseKey),
        };
    }
```

- [ ] **Step 4: Run → PASS** — `node --test test/api/credentials-refresh.test.js` (7 pass, 0 fail).

- [ ] **Step 5: Full suite (no regression)** — `npm test` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/api/credentials.js test/api/credentials-refresh.test.js
git commit -m "feat(credentials): lease.refreshCookies write-back (best-effort, sessionId-threaded)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: LinkedIn write-back call site

**Files:** Modify `scrapers/linkedin.js`

> No unit test: `scrapeLinkedIn` drives a real browser and is not unit-testable (consistent with the rest of `test/scrapers/`, which tests only pure helpers). Behaviour is verified by the Task 6 empirical run. This step is a 2-line, best-effort insertion that cannot change the returned jobs or the verdict.

- [ ] **Step 1: Implement.** In `scrapers/linkedin.js`, on the success path (currently lines ~1409-1411):

```js
        // Report success against THIS lease (not the platform name).
        loginSuccess = true;
        await lease.reportSuccess(`Scraped ${normalizedPosts.length} posts successfully`);
```

Change to (insert two lines BEFORE `reportSuccess` — `context` from `launchWithCookies` (line ~1229) is still open; the `finally` closes only `browser`; refresh must precede `reportSuccess` because the latter forgets the lease):

```js
        // Report success against THIS lease (not the platform name).
        loginSuccess = true;
        // Cookie-jar write-back (handoff §4): reaching here means the
        // session was authenticated (an auth-wall throws AuthError far
        // earlier). Best-effort — never throws, never affects the verdict.
        const jar = await context.cookies().catch(() => null);
        await lease.refreshCookies(jar);
        await lease.reportSuccess(`Scraped ${normalizedPosts.length} posts successfully`);
```

- [ ] **Step 2: Syntax check** — `node --check scrapers/linkedin.js` → no output (valid).

- [ ] **Step 3: Full suite (no regression)** — `npm test` → `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add scrapers/linkedin.js
git commit -m "feat(linkedin): write back the rotated cookie jar on a successful scrape

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: §5 graceful-fail fix

**Files:** Modify `scrapers/linkedin.js`; Create `test/scrapers/linkedin-can-password-login.test.js`

- [ ] **Step 1: Write the failing test** — create `test/scrapers/linkedin-can-password-login.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPasswordLogin } from '../../scrapers/linkedin.js';

test('canPasswordLogin: true only with non-empty email AND password', () => {
    assert.equal(canPasswordLogin({ email: 'a@b.c', password: 'p' }), true);
});

test('canPasswordLogin: false for cookie-only / partial / missing creds', () => {
    assert.equal(canPasswordLogin({}), false);
    assert.equal(canPasswordLogin({ email: 'a@b.c' }), false);
    assert.equal(canPasswordLogin({ password: 'p' }), false);
    assert.equal(canPasswordLogin({ email: '', password: 'p' }), false);
    assert.equal(canPasswordLogin({ email: 'a@b.c', password: '' }), false);
    assert.equal(canPasswordLogin(null), false);
    assert.equal(canPasswordLogin(undefined), false);
    assert.equal(canPasswordLogin({ credentials: [{ name: 'li_at' }] }), false);
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/scrapers/linkedin-can-password-login.test.js` (export missing).

- [ ] **Step 3a: Add the constant.** In `scrapers/linkedin.js`, immediately AFTER `const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true';` (line ~34), insert:

```js
// A logged-out COOKIE credential is recoverable, not a permanent burn:
// bench-and-rotate so out-of-band / another session's write-back can
// revive it. (Was a permanent 0-min burn after a CONFIG.email crash.)
const COOKIES_EXPIRED_COOLDOWN_MIN = 60;
```

- [ ] **Step 3b: Add the pure helper.** Immediately BEFORE `async function ensureLoggedIn(page) {` (line ~206), insert:

```js
// A cookie-only leased credential has no email/password — attempting a
// password login iterates `CONFIG.email` (undefined) → "not iterable"
// crash → permanent credential burn. This gate prevents that.
export function canPasswordLogin(cred) {
    return !!cred
        && typeof cred.email === 'string' && cred.email.length > 0
        && typeof cred.password === 'string' && cred.password.length > 0;
}
```

- [ ] **Step 3c: Guard `ensureLoggedIn`.** It currently is (lines ~206-226):

```js
async function ensureLoggedIn(page) {
    logProgress('LinkedIn', '🔐 Verifying authentication status...');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(3000, 5000);
    const currentUrl = page.url();
    logProgress('LinkedIn', `   Current URL after feed navigation: ${currentUrl}`);
    if (isAuthenticatedPage(currentUrl)) {
        logProgress('LinkedIn', '✅ Already logged in (verified via feed navigation)');
        return true;
    }
    // We got redirected to a login page - need to perform login
    logProgress('LinkedIn', '🔑 Not logged in, performing login...');
    await performLogin(page);
    return true;
}
```

Replace the comment + `performLogin` tail (the last three lines before `return true;`) so it reads:

```js
    if (isAuthenticatedPage(currentUrl)) {
        logProgress('LinkedIn', '✅ Already logged in (verified via feed navigation)');
        return true;
    }
    // §5: a cookie-only credential cannot password-login. Fail typed &
    // recoverable instead of crashing on `for (const c of CONFIG.email)`.
    // CONFIG.{email,password} are set from the leased credential in
    // scrapeLinkedIn (lines ~1218-1219) before navigateToSearch runs;
    // performLogin already reads the same module CONFIG.
    if (!canPasswordLogin(CONFIG)) {
        throw new AuthError(
            'LinkedIn session not authenticated and credential has no password to log in with (cookies expired/rotated)',
            { platform: 'linkedin' });
    }
    logProgress('LinkedIn', '🔑 Not logged in, performing login...');
    await performLogin(page);
    return true;
```

- [ ] **Step 3d: Recoverable cooldown.** The `AuthError` branch currently is (line ~1438):

```js
            await lease.reportFailure(`Auth/cookies expired: ${error.message}`, 0);
```

Change the `0` to the constant:

```js
            await lease.reportFailure(`Auth/cookies expired: ${error.message}`, COOKIES_EXPIRED_COOLDOWN_MIN);
```

- [ ] **Step 4: Run → PASS** — `node --test test/scrapers/linkedin-can-password-login.test.js` (2 pass, 0 fail). Then `node --check scrapers/linkedin.js`.

- [ ] **Step 5: Full suite** — `npm test` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add scrapers/linkedin.js test/scrapers/linkedin-can-password-login.test.js
git commit -m "fix(linkedin): cookie-only logged-out session fails typed+recoverable, not crash+burn (§5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verification + NOTES

**Files:** Create `docs/superpowers/plans/2026-05-19-cookie-writeback-NOTES.md`

- [ ] **Step 1: Full suite** — `npm test` → record `pass N / fail 0`. New tests: metric safe-call, `planCookieRefresh` ×5, `refreshCookies` ×2, `canPasswordLogin` ×2.

- [ ] **Step 2: Static inertness probe** — confirm no behavior change for the non-write-back path:

```bash
node --check scrapers/linkedin.js && node --check src/api/credentials.js && node --check src/metrics/registry.js && echo "syntax OK"
grep -n "refreshCookies\|planCookieRefresh\|canPasswordLogin\|COOKIES_EXPIRED_COOLDOWN_MIN" src/api/credentials.js scrapers/linkedin.js | wc -l
```

- [ ] **Step 3: Empirical local run (honest caveat).** With the operator's LinkedIn cookies in LOCAL mode, run the established headed scrape. Expected: scrape succeeds; logs show `Cookie write-back skipped … reason=skipped_local` (LOCAL is a deliberate no-op — spec §6); no crash; suite green. **REMOTE end-to-end against prod cannot be verified here** — the provided API key 401s (`Invalid or revoked`); REMOTE is covered by the pure-decider unit tests + the backend handoff §6 curl + log/metric inspection. State this explicitly; do not fake a REMOTE result.

- [ ] **Step 4: Write NOTES** — create `docs/superpowers/plans/2026-05-19-cookie-writeback-NOTES.md`:

```markdown
# Cookie write-back + §5 — completion notes
Status: COMPLETE. `npm test` <N>/0.
Delivered: pure `planCookieRefresh` (backend reject-rule mirror); `lease.
refreshCookies()` best-effort write-back (sessionId-threaded, never throws,
never forgets the lease); LinkedIn success-path call site; §5 — cookie-only
logged-out session now throws typed AuthError (no CONFIG.email crash) and
reports a recoverable 60-min cooldown instead of a permanent-0 burn;
`scraper_credential_refreshes_total` metric.
Spec deviation (intent-preserving): spec C2 said `ensureLoggedIn(page,
credential)`; implemented as `canPasswordLogin(CONFIG)` — CONFIG.{email,
password} are already set from the leased credential (linkedin.js ~1218-9)
and performLogin already reads module CONFIG, so this needs no signature/
caller change (smaller blast radius, same behaviour).
Non-goals honored: no LOCAL-file write-back; no client-side change
detection; no Glassdoor/Indeed wiring.
Verification: full suite green; pure logic exhaustively unit-tested;
thin I/O wiring + linkedin call site verified by the local empirical run.
HONEST CAVEAT: prod REMOTE e2e blocked on a valid API key (current key
401s); REMOTE validated via unit tests + backend §6 curl + log/metrics.
Production impact: best-effort write-back adds one swallowed POST on the
LinkedIn success path; §5 turns a crash+permanent-burn into a typed,
recoverable failure. No other flow changes.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-19-cookie-writeback-NOTES.md
git commit -m "docs(plan): cookie-writeback completion notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** §2 contract → Task 2 (`planCookieRefresh` body/`session_id`/64 KB/li_at mirror) + Task 3 (`#postLeaseAction(lease,'refresh',body)` → exact URL `…/queue/<lease.id>/refresh`, same `X-Scraper-API-Key`). §3 Component A → Tasks 1 (A4 metric), 2 (decider), 3 (A1 sessionId thread, A2 method, A3 facade). Component B → Task 4 (call site before `reportSuccess`, `context` open). Component C → Task 5 (C1 `canPasswordLogin`, C2 guard, C3 `COOKIES_EXPIRED_COOLDOWN_MIN=60`). §4 data flow, §5 error handling (best-effort, never throw, never forget) → Task 3 method body + Task 4 comment. §6 non-goals → not implemented (LOCAL no-op = `skipped_local` in Task 2; no change-detection; no other platforms). §7 testing → Tasks 1-5 unit + Task 6 empirical with the explicit honest caveat. §8 security → no cookie values logged (Task 3 logs `platform`/`reason` only). §9 acceptance → Task 6. No gaps.

**2. Placeholder scan:** none — every code step has complete code; every run step has an exact command + expected result. The "no unit test for the browser path" (Task 4) and the REMOTE-e2e caveat (Task 6) are explicit, justified strategy carried verbatim from spec §7, not hidden TODOs.

**3. Type/name consistency:** `planCookieRefresh({isLocal,sessionId,cookies}) → {action:'skip'|'post', outcome, body?}` defined Task 2, consumed Task 3 identically. `refreshCookies(leaseKeyOrPlatform, cookies)` (method) / `lease.refreshCookies(cookies)` (facade) consistent Task 3 ↔ Task 4. `recordCredentialRefresh(platform, outcome)` defined Task 1, called Task 3 with outcomes exactly from the counter's documented label set (`refreshed|skipped_local|skipped_no_li_at|skipped_too_large|error`). `canPasswordLogin(cred)` defined Task 5, tested Task 5. `COOKIES_EXPIRED_COOLDOWN_MIN` defined Task 5 Step 3a, used Step 3d. `_issueLeaseForTest` defined Task 3 Step 3b, used Step 1. `#issueLease` 4-arg signature consistent across 3b/3c. No mismatches.

**Intent-preserving deviation from spec (noted, not a gap):** spec §C2 specified `ensureLoggedIn(page, credential)`; the plan gates on `canPasswordLogin(CONFIG)` instead because `ensureLoggedIn` has exactly one caller (`navigateToSearch`, line 376), `CONFIG.{email,password}` are populated from the leased credential at lines ~1218-1219 before that runs, and `performLogin` already depends on module `CONFIG` — so this needs no signature/caller change and is strictly lower-risk while producing identical behaviour. Recorded in NOTES.
