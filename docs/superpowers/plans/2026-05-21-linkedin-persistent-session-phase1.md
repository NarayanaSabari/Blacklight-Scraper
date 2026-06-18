# LinkedIn persistent session — Phase 1 (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Hold one warm CloakBrowser context for the server process lifetime and scrape every LinkedIn role as a new tab in it (D1b), instead of cold-launching + re-injecting cookies per role.

**Architecture:** New `LinkedInSession` singleton owns the browser+context+lease (lazy, single-flight). `scrapeLinkedIn` is refactored from "own the browser" to "borrow a page via `session.withPage`". Per-role outcome is decoupled from credential outcome (content failures keep the session; only auth failures reestablish). No heartbeat in P1 (single-cred, no contention).

**Tech Stack:** Node 24 ESM, `node:test`, CloakBrowser (`launch`), the credentials lease API.

**Source spec:** `docs/superpowers/specs/2026-05-21-linkedin-persistent-session-design.md`.

**Land order (de-risking):** Tasks 1-2 add the new module fully unit-tested and ISOLATED (scrapeLinkedIn untouched, suite stays green). Task 3 rewires the hot path. Task 4 wires shutdown. Task 5 verifies + reviews.

---

### Task 1: `LinkedInSession.ensureReady` — single-flight lease + launch + inject

**Files:**
- Create: `src/scrapers/linkedin-session.js`
- Test: `test/scrapers/linkedin-session-ensure-ready.test.js`

The module reuses the existing `launchWithCookies(credential)` helper. To make it usable here without circular import, **export `launchWithCookies` from `scrapers/linkedin.js`** (it currently is a private function — add `export`). The session takes injectable `launcher` (defaults to that export) and `apiClient` (defaults to `getCredentialsAPIClient()`).

- [ ] **Step 1: Write the failing tests**

```js
// test/scrapers/linkedin-session-ensure-ready.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../scrapers/../src/scrapers/linkedin-session.js';

function fakeDeps() {
    let leases = 0, launches = 0;
    const apiClient = {
        acquire: async () => { leases++; return { credential: { id: 12, email: 'a@b.c', password: 'p' }, reportSuccess: async () => {}, reportFailure: async () => {}, release: async () => {} }; },
    };
    const launcher = async () => { launches++; return { browser: { close: async () => {} }, context: { newPage: async () => ({ close: async () => {} }) } }; };
    return { apiClient, launcher, counts: () => ({ leases, launches }) };
}

test('ensureReady leases + launches exactly once', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await s.ensureReady('sess-1');
    await s.ensureReady('sess-1');
    assert.deepEqual(d.counts(), { leases: 1, launches: 1 });
});

test('ensureReady is single-flight under concurrency (1 lease/launch for 10 callers)', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await Promise.all(Array.from({ length: 10 }, () => s.ensureReady('sess-1')));
    assert.deepEqual(d.counts(), { leases: 1, launches: 1 });
});

test('ensureReady throws if no credential available', async () => {
    const apiClient = { acquire: async () => null };
    const launcher = async () => { throw new Error('should not launch'); };
    const s = new LinkedInSession({ apiClient, launcher, leaseRetryDelayMs: 0, maxLeaseRetries: 2 });
    await assert.rejects(() => s.ensureReady('sess-1'), /No LinkedIn credential/);
});
```

- [ ] **Step 2: Run, verify fail** — `node --test 'test/scrapers/linkedin-session-ensure-ready.test.js'` → module not found / class missing.

- [ ] **Step 3: Implement `src/scrapers/linkedin-session.js`**

```js
// One long-lived CloakBrowser context + credential lease for the process
// lifetime (design: persistent-session D1b). scrapeLinkedIn borrows a page
// per role via withPage(); the context/lease are NOT torn down per role.
import { launchWithCookies } from '../../scrapers/linkedin.js';
import { getCredentialsAPIClient } from '../api/credentials.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('linkedin-session');

export class LinkedInSession {
    constructor({ apiClient = null, launcher = launchWithCookies, platform = 'linkedin',
                  maxLeaseRetries = 10, leaseRetryDelayMs = 60000 } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._launch = launcher;
        this._platform = platform;
        this._maxLeaseRetries = maxLeaseRetries;
        this._leaseRetryDelayMs = leaseRetryDelayMs;
        this._lease = null;
        this._browser = null;
        this._context = null;
        this._establishing = null; // single-flight promise
    }

    get lease() { return this._lease; }
    isAlive() { return !!this._context; }

    async ensureReady(sessionId) {
        if (this._context) return;
        if (this._establishing) return this._establishing;
        this._establishing = this.#establish(sessionId).finally(() => { this._establishing = null; });
        return this._establishing;
    }

    async #establish(sessionId) {
        const lease = await this.#acquireLease(sessionId);
        if (!lease) throw new Error('No LinkedIn credential available from API');
        this._lease = lease;
        const { browser, context } = await this._launch(lease.credential);
        this._browser = browser;
        this._context = context;
        log.info('Persistent LinkedIn session established', { credentialId: lease.credential?.id });
    }

    async #acquireLease(sessionId) {
        for (let i = 0; i < this._maxLeaseRetries; i++) {
            const lease = await this._apiClient.acquire(this._platform, sessionId);
            if (lease) return lease;
            if (i < this._maxLeaseRetries - 1 && this._leaseRetryDelayMs > 0) {
                await new Promise(r => setTimeout(r, this._leaseRetryDelayMs));
            }
        }
        return null;
    }

    async withPage(sessionId, fn) {
        await this.ensureReady(sessionId);
        const page = await this._context.newPage();
        try { return await fn(page); }
        finally { await page.close().catch(() => {}); }
    }

    async reestablish(sessionId) {
        await this.#teardownBrowser();
        try { await this._lease?.release?.(); } catch { /* best-effort */ }
        this._lease = null;
        await this.ensureReady(sessionId);
    }

    async shutdown() {
        await this.#teardownBrowser();
        try { await this._lease?.release?.(); } catch { /* best-effort */ }
        this._lease = null;
    }

    async #teardownBrowser() {
        const b = this._browser;
        this._browser = null;
        this._context = null;
        if (b) { try { await b.close(); } catch { /* already closed */ } }
    }
}

let _singleton = null;
export function getLinkedInSession() { return (_singleton ??= new LinkedInSession()); }
export function __resetLinkedInSessionForTest() { _singleton = null; }
```

- [ ] **Step 4: Add `export` to `launchWithCookies`** in `scrapers/linkedin.js` (change `async function launchWithCookies` → `export async function launchWithCookies`).

- [ ] **Step 5: Run tests** — `node --test 'test/scrapers/linkedin-session-ensure-ready.test.js'` → 3/3 pass.

- [ ] **Step 6: Full suite** — `npm test` → 142 + 3 = 145, all green (scrapeLinkedIn still uses its own launch path; new module is isolated).

- [ ] **Step 7: Commit**
```
git add src/scrapers/linkedin-session.js test/scrapers/linkedin-session-ensure-ready.test.js scrapers/linkedin.js
git commit -m "feat(linkedin): LinkedInSession singleton — single-flight lease+launch+inject"
```

---

### Task 2: `withPage` / `shutdown` / `reestablish` behavior + singleton

**Files:**
- Modify: `src/scrapers/linkedin-session.js` (already has the methods from Task 1 — this task PINS their behavior with tests)
- Test: `test/scrapers/linkedin-session-lifecycle.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession, getLinkedInSession, __resetLinkedInSessionForTest } from '../../src/scrapers/linkedin-session.js';

function fakeDeps() {
    const closed = { browser: 0, pages: 0 }; let released = 0;
    const apiClient = { acquire: async () => ({ credential: { id: 12 }, release: async () => { released++; } }) };
    const launcher = async () => ({
        browser: { close: async () => { closed.browser++; } },
        context: { newPage: async () => ({ close: async () => { closed.pages++; } }) },
    });
    return { apiClient, launcher, closed, released: () => released };
}

test('withPage opens a page, runs fn, closes the page even on throw', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    const out = await s.withPage('sess', async (page) => { assert.ok(page); return 'ok'; });
    assert.equal(out, 'ok');
    await assert.rejects(() => s.withPage('sess', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(d.closed.pages, 2);   // both pages closed
    assert.equal(d.closed.browser, 0); // browser stays open across roles
});

test('shutdown closes browser + releases lease exactly once, idempotent', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await s.ensureReady('sess');
    await s.shutdown();
    await s.shutdown(); // idempotent
    assert.equal(d.closed.browser, 1);
    assert.equal(d.released(), 1);
    assert.equal(s.isAlive(), false);
});

test('reestablish tears down then re-leases + re-launches', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await s.ensureReady('sess');
    await s.reestablish('sess');
    assert.equal(d.closed.browser, 1); // old browser closed
    assert.equal(s.isAlive(), true);   // new one up
});

test('getLinkedInSession is a singleton; reset clears it', () => {
    __resetLinkedInSessionForTest();
    const a = getLinkedInSession();
    const b = getLinkedInSession();
    assert.equal(a, b);
    __resetLinkedInSessionForTest();
    assert.notEqual(getLinkedInSession(), a);
});
```

- [ ] **Step 2: Run, verify fail** (then most should pass from Task 1's impl; fix any gaps — e.g. `shutdown` double-call must not double-release: guard `this._lease = null` before the await, already done).

- [ ] **Step 3: Make green** — adjust `linkedin-session.js` only if a test fails (the Task-1 impl already satisfies these; the likely fix is ensuring `shutdown` is idempotent — it is, since `#teardownBrowser` nulls `_browser` first and `release` is guarded by `_lease` null-after).

- [ ] **Step 4: Full suite** — `npm test` → 145 + 4 = 149 green.

- [ ] **Step 5: Commit**
```
git add src/scrapers/linkedin-session.js test/scrapers/linkedin-session-lifecycle.test.js
git commit -m "test(linkedin): pin LinkedInSession withPage/shutdown/reestablish/singleton"
```

---

### Task 3: Refactor `scrapeLinkedIn` to borrow a page (the hot-path rewire)

**Files:**
- Modify: `scrapers/linkedin.js` (`scrapeLinkedIn` body, ~1231-1600)

No new unit test (browser-driven). Verified by static probe + full suite + Task 5 review. **This is the high-risk step — keep the scrape body (navigate/scroll/pacing/extract/verdict) byte-identical; only change the lifecycle wrapper around it.**

- [ ] **Step 1: Replace the lease/launch/while-retry scaffold with `session.withPage`**

Conceptually, transform:
```js
// OLD (1258-1320): apiClient + while(attempt<3){ acquire lease (10x60s); set CONFIG; try { launchWithCookies; page=newPage(); ...SCRAPE... } catch {reportFailure by type} finally {browser.close()} }
// NEW:
const session = getLinkedInSession();
return await session.withPage(sessionId, async (page) => {
    // set CONFIG.email/password/credentialId from session.lease.credential
    const credential = session.lease.credential;
    CONFIG.email = credential.email; CONFIG.password = credential.password; CONFIG.credentialId = credential.id;
    // ...SCRAPE BODY (navigateToSearch → pre-scroll capture → extractPosts → dedup → verdict)
    //    — copied verbatim from the current try-block, MINUS launchWithCookies/newPage (page is provided)...
    // verdict success:
    return { jobs: normalizedPosts, emptyConfirmed };
});
```

- [ ] **Step 2: Decouple per-role outcome from credential outcome (spec §5)**

Replace the per-type `lease.reportFailure(...)` catch (1551-1583) + the `lease.reportSuccess` (1531) with this policy:
- **Content success/empty:** `await session.lease.reportSuccess('Scraped N posts')` (liveness) then return. Keep the `{jobs, emptyConfirmed}` contract.
- **`AuthError`:** the credential is bad → `await session.lease.reportFailure('Auth/cookies expired: '+msg, COOKIES_EXPIRED_COOLDOWN_MIN)` then `await session.reestablish(sessionId)` and **re-throw** the AuthError so BaseScraper records the role failure (the next role will use the fresh session). Do NOT close on every role — only reestablish on auth death.
- **`BlockedError`/`DomChangedError` and other scrape errors:** **keep the session open**, do NOT reportFailure the credential (the credential is fine; the platform blocked/served odd DOM). Just re-throw so BaseScraper classifies the role failure. (This is the key behavior change from per-scrape-isolated: a DOM/block failure no longer cools down the credential.)

Wrap the scrape body in a `try/catch` INSIDE the `withPage` callback to apply this policy; let `withPage`'s `finally` close the page.

- [ ] **Step 3: Remove the now-dead `finally { browser.close() }` and the `while/attempt` credential-retry loop**

The session manager owns lease-retry (`#acquireLease`, 10×) and there is no per-role browser to close. Delete the `while (attemptCount < maxAttempts)` wrapper and the `finally { browser.close() }` (1586-1595). The 3-attempt credential retry is superseded by reestablish-on-auth-death.

- [ ] **Step 4: Leave the write-back path in but unreached**

The mid-scrape capture (`onAuthenticatedBatch`, `latestAuthenticatedJar`, `hasLiAt`) and `lease.refreshCookies` may stay for now (P1 keeps it reversible). Since we no longer close per role, `refreshCookies` is simply not needed — it's fine to drop the `await lease.refreshCookies(latestAuthenticatedJar)` call here (the close-time poison problem no longer exists). Keep `hasLiAt`/the capture vars unused-but-harmless OR remove the capture wiring in this task — implementer's choice, but the suite + `node --check` must stay clean (no unused-var lint errors; this repo has no linter gate, so leaving them is acceptable). **Recommended:** drop the `refreshCookies` call; leave the capture vars (smaller diff, full removal happens in §7 cleanup post-validation).

- [ ] **Step 5: Static probe**
```
node --check scrapers/linkedin.js
grep -c "browser.close()" scrapers/linkedin.js      # expect 0 in scrapeLinkedIn (launchWithCookies has none); the only close is in linkedin-session.js
grep -c "session.withPage\|getLinkedInSession" scrapers/linkedin.js   # expect >=2
grep -c "while (attemptCount" scrapers/linkedin.js  # expect 0
```

- [ ] **Step 6: Full suite** — `npm test` → 149 green, no regression.

- [ ] **Step 7: Commit**
```
git add scrapers/linkedin.js
git commit -m "refactor(linkedin): scrapeLinkedIn borrows a page from the persistent session"
```

---

### Task 4: server.js shutdown hook + correct the stale orchestrator comment

**Files:**
- Modify: `server.js` (the existing shutdown path near `stopAutoChecker`, ~:150)
- Modify: `src/queue/orchestrator.js:211-214` (the now-false "its own browser context, its own credential lease" comment)

- [ ] **Step 1: Add the shutdown hook**

In server.js's SIGTERM/SIGINT handler (alongside `orchestrator?.stopAutoChecker()`), add:
```js
try { await (await import('./src/scrapers/linkedin-session.js')).getLinkedInSession().shutdown(); }
catch (err) { log.warn?.('LinkedIn session shutdown failed', { err: err.message }); }
```
(Dynamic import keeps server.js from eagerly constructing the session at boot.)

- [ ] **Step 2: Correct the orchestrator comment**

Change `orchestrator.js:211-214` to note LinkedIn now shares ONE persistent context + lease across roles (single-flight in `LinkedInSession`), while other platforms still launch per-scrape. Honesty fix — no code change.

- [ ] **Step 3: Syntax + suite** — `node --check server.js`; `npm test` → 149 green.

- [ ] **Step 4: Commit**
```
git add server.js src/queue/orchestrator.js
git commit -m "feat(linkedin): release persistent session on shutdown; fix stale concurrency comment"
```

---

### Task 5: Verify + completion notes + final review

**Files:**
- Create: `docs/superpowers/plans/2026-05-21-linkedin-persistent-session-phase1-NOTES.md`

- [ ] **Step 1: Static probe** — confirm: one launch path for the session, `withPage` used by scrapeLinkedIn, no per-role `browser.close`, shutdown hook present.
- [ ] **Step 2: Full suite** — `npm test` green (149).
- [ ] **Step 3: Completion notes** — what shipped, the per-role/credential decoupling, the **honest caveat** (P1 effectiveness = "warm session reduces auth-walls", observable only in a prod/local headed run over hours; lease-reaping risk until backend heartbeat ships).
- [ ] **Step 4: Final whole-increment opus review** — focus: single-flight correctness, page-always-closed, browser-never-closed-per-role, auth-vs-content failure decoupling, no regression to the scrape body, shutdown idempotency.
- [ ] **Step 5: Commit notes, push, open PR.**

---

## Self-review

- ✅ Spec coverage: Component A (Task 1-2), B (Task 3), C (Task 4), failure model §5 (Task 3 step 2), testing §6 (Task 1-2 units + Task 5), phasing P1 (whole plan).
- ✅ No heartbeat / no reestablish-on-crash retry-loop hardening (P2, out of scope) — explicitly deferred.
- ✅ Type consistency: `LinkedInSession({apiClient, launcher})`, `ensureReady(sessionId)`, `withPage(sessionId, fn)`, `lease` getter, `getLinkedInSession()`/`__resetLinkedInSessionForTest()` consistent across tasks.
- ✅ De-risked order: new module green+isolated (T1-2) before the hot-path rewire (T3).
- ⚠️ Known P1 limitation documented: no heartbeat → backend may reap a held lease; acceptable for single-cred validation, fixed by the backend handoff.
