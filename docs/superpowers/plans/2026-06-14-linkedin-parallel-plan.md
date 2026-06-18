# LinkedIn Parallel Scraping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound LinkedIn concurrency to a deliberate, paced pool of N tabs (default 2, `LINKEDIN_MAX_CONCURRENCY`) in the single persistent-profile context, so parallel scraping on one machine/one account doesn't shadow-ban the account.

**Architecture:** A new generic async `Semaphore` caps concurrent `withPage` borrowers process-wide inside the singleton `LinkedInSession`; each borrower waits a small randomized jitter after acquiring a slot (staggered start) before opening its tab. No orchestrator changes — it already calls `withPage` concurrently; the semaphore transparently bounds it.

**Tech Stack:** Node 24 ESM, `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-14-linkedin-parallel-design.md`

---

## Constraints

1. Do NOT modify other scrapers (`monster/dice/indeed/glassdoor/techfetch`) or the orchestrator.
2. NEVER stage `.gitignore`, `pnpm-lock.yaml`, `.claude/`, `node_modules/`. Stage files by name only.
3. Tests: `node --test 'test/**/*.test.js'` (quoted glob — Node 24).
4. Every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
5. Working dir `/Users/sabari/Developer/freelancing/Blacklight-Scraper`, branch `emdash/linkedin-parallel`.
6. Baseline: 428 tests passing.

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `src/core/semaphore.js` | new | Generic async counting semaphore (acquire→release, FIFO, max N, idempotent release) |
| `src/scrapers/linkedin-session.js` | modify | `linkedinMaxConcurrency()` env reader + `defaultJitter`; construct `this._sem`; `withPage` acquires/jitters/releases |
| `test/core/semaphore.test.js` | new | Semaphore unit tests |
| `test/scrapers/linkedin-session-concurrency.test.js` | new | `withPage` never exceeds the cap; all queued borrowers complete |

---

## Task 1: Generic `Semaphore`

**Files:**
- Create: `src/core/semaphore.js`
- Create: `test/core/semaphore.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/core/semaphore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../../src/core/semaphore.js';

const tick = () => new Promise((r) => setImmediate(r));

test('acquire: grants immediately up to max', async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    assert.equal(typeof r1, 'function');
    assert.equal(typeof r2, 'function');
});

test('acquire: blocks beyond max until a slot frees (FIFO)', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    let got2 = false;
    let got3 = false;
    const p2 = s.acquire().then((r) => { got2 = true; return r; });
    const p3 = s.acquire().then((r) => { got3 = true; return r; });
    await tick();
    assert.equal(got2, false, 'second waiter blocked while slot held');
    assert.equal(got3, false);
    r1();                 // free the slot → first waiter (p2) gets it
    const r2 = await p2;
    assert.equal(got2, true);
    assert.equal(got3, false, 'third waiter still blocked (FIFO)');
    r2();                 // free → p3 gets it
    await p3;
    assert.equal(got3, true);
});

test('release is idempotent — double-release does not over-grant', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    r1();
    r1();                 // no-op
    const r2 = await s.acquire();   // only one extra slot should exist
    let got3 = false;
    s.acquire().then(() => { got3 = true; });
    await tick();
    assert.equal(got3, false, 'double-release must not have granted an extra slot');
    r2();
});

test('never exceeds max under a burst of M >> max acquirers', async () => {
    const s = new Semaphore(2);
    let live = 0;
    let maxLive = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
        const release = await s.acquire();
        live++; maxLive = Math.max(maxLive, live);
        await tick(); await tick();
        live--; release();
    }));
    assert.equal(maxLive, 2, `observed max concurrency ${maxLive}, expected 2`);
    assert.equal(live, 0);
});

test('max < 1 is clamped to 1', async () => {
    const s = new Semaphore(0);
    const r1 = await s.acquire();
    let got2 = false;
    s.acquire().then(() => { got2 = true; });
    await tick();
    assert.equal(got2, false, 'clamped to 1 → second blocks');
    r1();
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `node --test 'test/core/semaphore.test.js'`
Expected: FAIL — `Cannot find module 'src/core/semaphore.js'`.

- [ ] **Step 3: Implement**

Create `src/core/semaphore.js`:

```js
// Minimal async counting semaphore. acquire() resolves with a one-shot
// release function when a slot is free, else queues FIFO. release() frees a
// slot (handing it directly to the next waiter if any) and is idempotent so a
// double-release can't over-grant. No timeouts/cancellation (YAGNI).
export class Semaphore {
    constructor(max) {
        this._max = Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1);
        this._inUse = 0;
        this._queue = [];
    }

    async acquire() {
        if (this._inUse < this._max) {
            this._inUse++;
            return this.#makeRelease();
        }
        return new Promise((resolve) => {
            this._queue.push(() => resolve(this.#makeRelease()));
        });
    }

    #makeRelease() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = this._queue.shift();
            if (next) {
                next();          // hand the held slot straight to the next waiter
            } else {
                this._inUse--;   // no waiter: free the slot
            }
        };
    }
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test 'test/core/semaphore.test.js'`
Expected: PASS (5 tests).

Full suite: `node --test 'test/**/*.test.js'` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/core/semaphore.js test/core/semaphore.test.js
git commit -m "$(cat <<'EOF'
feat(core): generic async Semaphore (FIFO, idempotent release)

Caps concurrent borrowers at N; acquire() returns a one-shot release fn,
release hands the held slot straight to the next FIFO waiter and is
idempotent. Foundation for bounding LinkedIn tab concurrency.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Bound + pace `LinkedInSession.withPage`

**Files:**
- Modify: `src/scrapers/linkedin-session.js`
- Create: `test/scrapers/linkedin-session-concurrency.test.js`

### Current code (for reference — do not change the parts not shown)

Constructor (lines ~15-25) and `withPage` (lines ~59-64):

```js
export class LinkedInSession {
    constructor({ apiClient = null, launcher = launchPersistentProfile, platform = 'linkedin',
                  maxLeaseRetries = 10, leaseRetryDelayMs = 60000 } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._launch = launcher;
        this._platform = platform;
        this._maxLeaseRetries = maxLeaseRetries;
        this._leaseRetryDelayMs = leaseRetryDelayMs;
        this._lease = null;
        this._context = null;
        this._establishing = null; // single-flight promise
    }
    // ...
    async withPage(sessionId, fn) {
        await this.ensureReady(sessionId);
        const page = await this._context.newPage();
        try { return await fn(page); }
        finally { await page.close().catch(() => {}); }
    }
```

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/linkedin-session-concurrency.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession, linkedinMaxConcurrency } from '../../src/scrapers/linkedin-session.js';

const tick = () => new Promise((r) => setImmediate(r));

// Fake context whose newPage/close track live concurrency.
function makeFakeDeps() {
    const state = { live: 0, maxLive: 0, opened: 0 };
    const context = {
        newPage: async () => {
            state.opened++;
            state.live++;
            state.maxLive = Math.max(state.maxLive, state.live);
            return { close: async () => { state.live--; } };
        },
    };
    const apiClient = { acquire: async () => ({ credential: { id: 'test' }, release: async () => {} }) };
    const launcher = async () => context;
    return { state, apiClient, launcher };
}

test('linkedinMaxConcurrency: default 2, env override, invalid → default', () => {
    assert.equal(linkedinMaxConcurrency({}), 2);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '3' }), 3);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '1' }), 1);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '0' }), 2);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: 'abc' }), 2);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '' }), 2);
});

test('withPage never exceeds maxConcurrency under a burst, and all complete', async () => {
    const { state, apiClient, launcher } = makeFakeDeps();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 2, jitter: () => Promise.resolve(),
    });
    let done = 0;
    await Promise.all(Array.from({ length: 6 }, () =>
        session.withPage('sid', async () => { await tick(); await tick(); done++; })));
    assert.equal(state.maxLive, 2, `observed max ${state.maxLive}, expected 2`);
    assert.equal(state.opened, 6, 'all 6 borrowers opened a page');
    assert.equal(done, 6, 'all 6 completed');
    assert.equal(state.live, 0, 'every page closed');
});

test('withPage releases the slot even when fn throws', async () => {
    const { state, apiClient, launcher } = makeFakeDeps();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 1, jitter: () => Promise.resolve(),
    });
    await assert.rejects(session.withPage('sid', async () => { throw new Error('boom'); }));
    // Slot must be free again — a follow-up borrower completes.
    let ok = false;
    await session.withPage('sid', async () => { ok = true; });
    assert.equal(ok, true);
    assert.equal(state.live, 0);
});

test('maxConcurrency: 1 serializes (max live never exceeds 1)', async () => {
    const { state, apiClient, launcher } = makeFakeDeps();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 1, jitter: () => Promise.resolve(),
    });
    await Promise.all(Array.from({ length: 4 }, () =>
        session.withPage('sid', async () => { await tick(); })));
    assert.equal(state.maxLive, 1);
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `node --test 'test/scrapers/linkedin-session-concurrency.test.js'`
Expected: FAIL — `linkedinMaxConcurrency is not a function` / constructor ignores `maxConcurrency`.

- [ ] **Step 3: Implement**

In `src/scrapers/linkedin-session.js`:

(a) Add the import for the semaphore near the top imports:

```js
import { Semaphore } from '../core/semaphore.js';
```

(b) Add these two exports ABOVE the `export class LinkedInSession` line:

```js
// Concurrency cap for parallel LinkedIn tabs on the single account. Default 2
// (conservative — one session running many concurrent searches gets
// shadow-banned). Override with LINKEDIN_MAX_CONCURRENCY (positive integer).
export function linkedinMaxConcurrency(env = process.env) {
    const raw = env?.LINKEDIN_MAX_CONCURRENCY;
    if (raw === undefined || raw === null || raw === '') return 2;
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return 2;
    return n;
}

// Staggered start so the N tabs don't hit LinkedIn in lockstep. 500–2000ms.
function defaultJitter() {
    return new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 1500)));
}
```

(c) Replace the constructor with (adds `maxConcurrency` + `jitter` options, builds the semaphore):

```js
    constructor({ apiClient = null, launcher = launchPersistentProfile, platform = 'linkedin',
                  maxLeaseRetries = 10, leaseRetryDelayMs = 60000,
                  maxConcurrency = linkedinMaxConcurrency(), jitter = defaultJitter } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._launch = launcher;
        this._platform = platform;
        this._maxLeaseRetries = maxLeaseRetries;
        this._leaseRetryDelayMs = leaseRetryDelayMs;
        this._lease = null;
        this._context = null;
        this._establishing = null; // single-flight promise
        this._sem = new Semaphore(maxConcurrency);
        this._jitter = jitter;
    }
```

(d) Replace `withPage` with (acquire slot → jitter → ensureReady → tab → release):

```js
    async withPage(sessionId, fn) {
        const release = await this._sem.acquire();
        try {
            await this.ensureReady(sessionId);
            await this._jitter();            // staggered start (no-op in tests)
            const page = await this._context.newPage();
            try { return await fn(page); }
            finally { await page.close().catch(() => {}); }
        } finally {
            release();
        }
    }
```

Note: `ensureReady` runs INSIDE the acquired slot so the first borrower's context establishment doesn't count as extra concurrency; it stays single-flight so the other (queued) borrowers reuse the same context.

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test 'test/scrapers/linkedin-session-concurrency.test.js'`
Expected: PASS (4 tests).

Full suite: `node --test 'test/**/*.test.js'` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/linkedin-session.js test/scrapers/linkedin-session-concurrency.test.js
git commit -m "$(cat <<'EOF'
feat(linkedin): bounded + paced parallel tab pool (LINKEDIN_MAX_CONCURRENCY)

withPage now acquires a Semaphore slot (default 2, process-wide via the
singleton), waits a 500-2000ms jitter, then opens its tab — so the single
account runs at most N concurrent searches with staggered starts instead
of unbounded simultaneous tabs (shadow-ban risk). Slot released in finally
(no leak on throw). Tunable live via LINKEDIN_MAX_CONCURRENCY (=1
serializes). No orchestrator change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step 1: Full suite**

```bash
node --test 'test/**/*.test.js'
```
Expected: all green; +9 tests (5 semaphore + 4 session) → ~437.

- [ ] **Step 2: Module shape**

```bash
node -e "import('./src/core/semaphore.js').then(m => console.log(Object.keys(m).join(',')))"   # Semaphore
node -e "import('./src/scrapers/linkedin-session.js').then(m => console.log(Object.keys(m).sort().join(',')))"  # includes LinkedInSession, getLinkedInSession, linkedinMaxConcurrency
```

- [ ] **Step 3: Ring-fence check**

```bash
git diff main..HEAD --stat -- scrapers/ src/queue/orchestrator.js
```
Expected: empty (no scraper or orchestrator files changed — only `src/core/semaphore.js`, `src/scrapers/linkedin-session.js`, tests, docs).

- [ ] **Step 4: Hand off to `superpowers:finishing-a-development-branch`.**

## Self-review

- **Spec coverage:** §A Semaphore → Task 1. §B withPage bound+jitter → Task 2 (c,d). §C `LINKEDIN_MAX_CONCURRENCY` reader → Task 2 (b) [in-module reader, mirroring the cooldown `cooldownMs` pattern, rather than env.js — same effect, less churn; noted deviation from spec §C]. §D no orchestrator change → enforced by ring-fence check. Error handling (release in finally) → Task 2 (d) + test. Testing → Tasks 1 & 2.
- **Placeholders:** none — all code shown in full.
- **Type consistency:** `Semaphore(max)` / `acquire()→release()` consistent across Tasks 1-2; `linkedinMaxConcurrency(env)` consistent between reader (Task 2b) and test (Task 2 Step 1); `withPage(sessionId, fn)` signature unchanged (callers untouched); constructor options `maxConcurrency` + `jitter` consistent between impl and tests.
