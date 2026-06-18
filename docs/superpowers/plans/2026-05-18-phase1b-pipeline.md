# Phase 1B-pipeline — Orchestrator Truthfulness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the queue orchestrator *tell the truth* about all-failed assignments and zero-job submissions — emit `recordSessionAllFailed()` + a loud log when every platform in an assignment fails (C3), and a Loki-queryable `submitted_zero` signal when a platform's "success" carried 0 jobs (O9) — plus add the dependency-injection seam that makes this logic unit-testable without live HTTP.

**Architecture:** Add optional `client` / `metrics` / `scraperResolver` injection to `QueueOrchestrator` (backward compatible — `server.js` keeps passing `blacklightConfig` only). Route the existing inline `getMetrics()` / `getScraper()` calls through the seam. Then add two small, **on-the-wire-safe** observability behaviors in `#runAssignment`: a C3 all-failed branch (metric + error log) before `completeSession` (which is still always called — the backend coordinates sibling sessions and must get it), and an O9 warn when a platform submits 0 jobs as success. **No HTTP contract change** (submit `status` stays `'success'`/`'failed'` exactly as today — changing it needs backend coordination, explicitly deferred).

**Tech Stack:** Node.js 20+ ESM (host runs **Node v24.14.0**), `node:test` + `node:assert/strict`, prom-client (existing). No new dependencies.

> **Node 24 note:** `node --test <dir>` is broken on Node 24. `package.json` uses `node --test 'test/**/*.test.js'`; explicit single-file paths work. Reporter prints `ℹ pass N`/`ℹ fail N`. Success = "the task's new tests pass AND `fail 0`"; the suite carries 44 tests from Plans 1A+1B (cumulative counts illustrative).

**Source spec:** `docs/superpowers/specs/2026-05-18-blacklight-scraper-anti-bot-audit-design.md` — findings: **C3** (don't silently complete an all-failed session as if fine), **O9** (a 0-job submission is reported as plain `success`), and the **C1** orchestrator-observable slice (loud signal when a platform yields nothing). The **substantive C1** (scrapers throwing `BlockedError` so a block becomes a `failed`/`blocked` session rather than an empty `success`) is **Plan 1C** — noted in Task 4. `recordSessionAllFailed()` already exists on the registry (added + tested in Plan 1B); this plan adds its call site.

**Production-safety contract:** No scraper code changes. No HTTP request/response contract change (submit body and statuses identical to today; `completeSession` still always called). The only behavior deltas: (1) one extra `metrics.recordSessionAllFailed()` + one `log.error` when `summary.successful === 0`; (2) one extra `log.warn` when a platform submits 0 jobs. Both are observability-only and cannot alter scraping, claiming, or what the backend receives. The DI seam is inert in production (`server.js` passes no overrides → identical construction). Verified by Task 4.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/queue/orchestrator.js` | Queue workflow orchestrator | Modify (DI seam in ctor; `#metrics()` helper; route `getMetrics`/`getScraper`; C3 branch; O9 warn) |
| `test/queue/orchestrator.test.js` | Orchestrator unit tests (fakes via DI) | **Create** |

Tests live under `test/` mirroring `src/`. This plan is intentionally one cohesive subsystem (orchestrator truthfulness) and is small enough for a single plan.

---

## Task 1: Dependency-injection seam (test enablement, behavior-neutral)

**Files:**
- Modify: `src/queue/orchestrator.js` (constructor lines 24–38; add a private `#metrics()`; replace inline `getMetrics()` calls; route `getScraper`)
- Create: `test/queue/orchestrator.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/queue/orchestrator.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueOrchestrator } from '../../src/queue/orchestrator.js';

// Minimal fakes — the DI seam lets us drive the workflow with zero HTTP.
function fakeMetrics() {
    const calls = { allFailed: 0, queueCheck: [], jobsSubmitted: [] };
    return {
        calls,
        recordSessionAllFailed: () => { calls.allFailed += 1; },
        recordQueueCheck: (r) => calls.queueCheck.push(r),
        recordJobsSubmitted: (p, s, n) => calls.jobsSubmitted.push([p, s, n]),
    };
}

function fakeClient(overrides = {}) {
    const calls = { submitJobs: [], completeSession: [] };
    return {
        calls,
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => ({ assignments: [] }),
        submitJobs: async (sid, p, jobs, status) => { calls.submitJobs.push({ sid, p, n: jobs.length, status }); return { progress: '1/1' }; },
        completeSession: async (sid) => { calls.completeSession.push(sid); return { duration_seconds: 1, jobs: {} }; },
        ...overrides,
    };
}

test('constructor accepts injected client + metrics (no blacklightConfig needed)', () => {
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: fakeClient(),
        metrics: fakeMetrics(),
    });
    assert.equal(typeof o.runOnce, 'function');
});

test('runOnce uses the injected metrics (recordQueueCheck) not the global registry', async () => {
    const m = fakeMetrics();
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: fakeClient({ getNextRole: async () => ({ assignments: [] }) }),
        metrics: m,
    });
    await o.runOnce();
    // empty queue → at least one queue-check recorded on the injected metrics
    assert.ok(m.calls.queueCheck.length >= 1, 'injected metrics.recordQueueCheck was not used');
});

test('legacy constructor still requires blacklightConfig when no client injected', () => {
    assert.throws(
        () => new QueueOrchestrator({ queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 } }),
        /requires blacklightConfig/,
    );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/queue/orchestrator.test.js`
Expected: FAIL — constructor ignores `client`/`metrics` (still tries `new BlacklightApiClient(blacklightConfig...)` → throws "requires blacklightConfig" even when a client is injected), so the first two tests fail.

- [ ] **Step 3: Add the DI seam**

In `src/queue/orchestrator.js`, replace the constructor (currently lines 24–38) with:

```js
    constructor({ blacklightConfig, queueConfig, defaultLocation, client = null, metrics = null, scraperResolver = null }) {
        if (!client && !blacklightConfig) {
            throw new Error('QueueOrchestrator requires blacklightConfig');
        }
        this.client = client ?? new BlacklightApiClient(blacklightConfig.apiUrl, blacklightConfig.apiKey);
        this.queueConfig = queueConfig;
        // Per-platform scrapers still need a location string for their search
        // URL (e.g. LinkedIn's `&location=`). The backend no longer drives
        // location-specific scraping, so each scraper instance picks a default
        // — "United States" works for US-bench-sales recruiting; override via
        // SCRAPER_DEFAULT_LOCATION if you want a tighter geographic scope.
        this.defaultLocation = defaultLocation || 'United States';
        this.mutex = new Mutex();
        this.autoInterval = null;
        // Injection seams (default to the production singletons). Behavior-
        // neutral: server.js passes none of these, so construction is
        // identical to before. Tests inject fakes to exercise the workflow
        // without live HTTP / the real scraper registry.
        this._metrics = metrics;
        this._resolveScraper = scraperResolver ?? getScraper;
    }

    // Resolve the metrics sink: injected fake in tests, global registry in prod.
    #metrics() {
        return this._metrics ?? getMetrics();
    }
```

- [ ] **Step 4: Route the inline `getMetrics()` / `getScraper()` calls through the seam**

In `src/queue/orchestrator.js` make exactly these replacements (the surrounding code is unchanged):

4a. In `runOnce()`, the skipped-busy branch — replace:
```js
            getMetrics().recordQueueCheck('skipped_busy');
```
with:
```js
            this.#metrics().recordQueueCheck('skipped_busy');
```

4b. In `runOnce()`, the assignment dispatch loop — replace:
```js
            this.#runAssignment(assignment, getMetrics()).catch((err) => {
```
with:
```js
            this.#runAssignment(assignment, this.#metrics()).catch((err) => {
```

4c. In `#claim()`, replace:
```js
        const metrics = getMetrics();
        log.info('Starting queue cycle');
```
with:
```js
        const metrics = this.#metrics();
        log.info('Starting queue cycle');
```

4d. In `#runAssignment()`, the scraper lookup — replace:
```js
            const scraper = getScraper(platformName);
```
with:
```js
            const scraper = this._resolveScraper(platformName);
```

(Leave the `import { getScraper } from '../scrapers/registry.js';` and `import { getMetrics } from '../metrics/registry.js';` imports in place — they remain the production defaults.)

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/queue/orchestrator.test.js`
Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0` (44 prior + 3 = 47; exact count illustrative).

- [ ] **Step 7: Commit**

```bash
git add src/queue/orchestrator.js test/queue/orchestrator.test.js
git commit -m "refactor(orchestrator): add DI seam (client/metrics/scraperResolver) for testability

Behavior-neutral: server.js passes no overrides so production construction
is identical. Enables unit-testing the workflow without live HTTP.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: C3 — all-failed assignment is flagged, not silently completed

**Files:**
- Modify: `src/queue/orchestrator.js` (`#runAssignment`, between the summary tally loop and the `completeSession` try-block)
- Modify: `test/queue/orchestrator.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/queue/orchestrator.test.js`:

```js
function assignmentClient(extra = {}) {
    // ONE-SHOT: the orchestrator re-polls via setImmediate(() => runOnce())
    // after each platform settles, so an always-return getNextRole would
    // infinite-loop the test. Serve the assignment once, then empty.
    let served = false;
    return fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1, dice: 1 }),
        getNextRole: async () => {
            if (served) return { assignments: [] };
            served = true;
            return {
                assignments: [{
                    session_id: 'sess-AF',
                    role: { name: 'Backend Engineer', search_queries: null },
                    platforms: [{ name: 'indeed' }, { name: 'dice' }],
                }],
            };
        },
        ...extra,
    });
}

// A scraper resolver whose every platform throws → all-failed assignment.
const allThrowResolver = () => ({
    execute: async () => { throw new Error('boom'); },
});

test('C3: when every platform fails, recordSessionAllFailed fires and completeSession is still called', async () => {
    const m = fakeMetrics();
    const c = assignmentClient();
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        scraperResolver: allThrowResolver,
    });
    await o.runOnce();
    // give the fire-and-forget assignment a tick to settle
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.calls.allFailed, 1, 'recordSessionAllFailed should fire exactly once for an all-failed assignment');
    assert.deepEqual(c.calls.completeSession, ['sess-AF'], 'completeSession must still be called (backend coordination)');
});

test('C3: when at least one platform succeeds, recordSessionAllFailed does NOT fire', async () => {
    const m = fakeMetrics();
    const c = assignmentClient();
    const mixedResolver = (name) => ({
        execute: async () => (name === 'indeed' ? [{ id: 1 }] : (() => { throw new Error('boom'); })()),
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        scraperResolver: mixedResolver,
    });
    await o.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.calls.allFailed, 0, 'recordSessionAllFailed must not fire when a platform succeeded');
    assert.deepEqual(c.calls.completeSession, ['sess-AF']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/queue/orchestrator.test.js`
Expected: FAIL — `C3: when every platform fails...` fails because `m.calls.allFailed` is 0 (nothing calls `recordSessionAllFailed` yet). The "at least one succeeds" test passes already (allFailed stays 0).

- [ ] **Step 3: Add the C3 branch**

In `src/queue/orchestrator.js`, in `#runAssignment`, locate the summary tally loop that ends, followed by the `try { const completion = await this.client.completeSession(sessionId); ... }` block. Insert the C3 branch BETWEEN them. The result must read exactly:

```js
        const settled = await Promise.allSettled(tasks);
        for (const entry of settled) {
            if (entry.status === 'fulfilled') {
                const { platformName, result } = entry.value;
                results.platforms[platformName] = result;
                if (result.success) results.summary.successful += 1;
                else results.summary.failed += 1;
            } else {
                log.error('Platform task threw unexpectedly', { err: entry.reason?.message });
                results.summary.failed += 1;
            }
        }

        // C3 (spec): an assignment where every platform failed must NOT be
        // silently treated as a normal completion. We still call
        // completeSession (the backend coordinates sibling sessions for the
        // same role and must receive it), but we flag it loudly + on a
        // dedicated metric so a dashboard/alert can distinguish "role done,
        // 0 jobs because all platforms broke" from "role done normally".
        if (results.summary.total_platforms > 0 && results.summary.successful === 0) {
            log.error('All platforms failed for assignment — completing session anyway (backend coordination)', {
                sessionId,
                role: role.name,
                totalPlatforms: results.summary.total_platforms,
                scraper_alert: 'session_all_failed',
            });
            metrics.recordSessionAllFailed();
        }

        try {
            const completion = await this.client.completeSession(sessionId);
            results.completion = completion;
            log.info('Session completed', {
                sessionId,
                role: role.name,
                durationSec: completion.duration_seconds,
                imported: completion.jobs?.total_imported,
                found: completion.jobs?.total_found,
            });
        } catch (error) {
            log.error('Session completion failed', { sessionId, err: error.message });
            results.completion_error = error.message;
        }
```

(`metrics` is the parameter `#runAssignment(assignment, metrics)` already receives — now sourced from `this.#metrics()` per Task 1. Do not change anything else in the method.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/queue/orchestrator.test.js`
Expected: all tests pass, 0 fail (Task 1's 3 + the 2 new = 5).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/queue/orchestrator.js test/queue/orchestrator.test.js
git commit -m "feat(orchestrator): flag all-failed assignments via recordSessionAllFailed + loud log (C3)

completeSession is still always called (backend coordinates sibling
sessions). No HTTP contract change — observability-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: O9 — a 0-job "success" submission is logged distinctly

**Files:**
- Modify: `src/queue/orchestrator.js` (`#runAssignment`, the per-platform success branch, just before `metrics.recordJobsSubmitted(...,'success', formatted.length)`)
- Modify: `test/queue/orchestrator.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/queue/orchestrator.test.js`:

```js
test('O9: a platform returning 0 jobs still submits success but is recorded distinctly', async () => {
    const m = fakeMetrics();
    // Local ONE-SHOT getNextRole (do NOT pass an always-return override —
    // it would infinite-loop via the orchestrator's setImmediate re-poll).
    let served = false;
    const c = fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => {
            if (served) return { assignments: [] };
            served = true;
            return {
                assignments: [{
                    session_id: 'sess-ZERO',
                    role: { name: 'Backend Engineer', search_queries: null },
                    platforms: [{ name: 'indeed' }],
                }],
            };
        },
    });
    const emptyResolver = () => ({ execute: async () => [] }); // 0 jobs, no throw
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        scraperResolver: emptyResolver,
    });
    await o.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    // Wire contract preserved: still submitted with status 'success', 0 jobs.
    const sub = c.calls.submitJobs.find((s) => s.sid === 'sess-ZERO');
    assert.ok(sub, 'submitJobs should have been called for the zero-job platform');
    assert.equal(sub.n, 0);
    assert.equal(sub.status, 'success');
    // Observability: a zero-job 'success' submission is recorded distinctly.
    assert.deepEqual(
        m.calls.jobsSubmitted.find((j) => j[0] === 'indeed'),
        ['indeed', 'success', 0],
    );
});
```

- [ ] **Step 2: Run test to verify it fails OR passes-trivially, then strengthen via the log path**

Run: `node --test test/queue/orchestrator.test.js`
Expected: this test PASSES on the existing code (it asserts current behavior is preserved — submit `[]`/`'success'`, `recordJobsSubmitted('indeed','success',0)`). It is a **regression lock** proving O9's log addition does not change the wire/metric contract. The behavioral addition in Step 3 is the log signal (asserting a `log.warn` line is out of scope for unit tests without a logger-injection refactor we are deliberately not doing — the value of O9 is the Loki-queryable `scraper_alert`, and Step 3 adds it without altering anything this test asserts).

- [ ] **Step 3: Add the O9 zero-submission warn**

In `src/queue/orchestrator.js`, in `#runAssignment`'s per-platform success branch, the relevant region currently reads:

```js
                const formatted = jobs.map((job) => formatJobForBlacklight(job, platformName));
                const submitResponse = await this.client.submitJobs(sessionId, platformName, formatted, 'success');

                log.info('Jobs submitted', {
                    platform: platformName,
                    jobCount: formatted.length,
                    progress: submitResponse.progress,
                });
                metrics.recordJobsSubmitted(platformName, 'success', formatted.length);
```

Replace it with (adds ONLY the zero-job warn; submit call, status, and metric are byte-identical):

```js
                const formatted = jobs.map((job) => formatJobForBlacklight(job, platformName));
                const submitResponse = await this.client.submitJobs(sessionId, platformName, formatted, 'success');

                if (formatted.length === 0) {
                    // O9 (spec): the wire status stays 'success' (changing it
                    // needs backend coordination — deferred), but a 0-job
                    // "success" is the silent-block signature. Emit a distinct
                    // Loki-queryable signal so it is not buried among healthy
                    // submissions. The metric dimension is already covered by
                    // scraper_zero_result_sessions_total (Plan 1B, scraper layer).
                    log.warn('Submitted 0 jobs as success — possible silent block / empty result', {
                        platform: platformName,
                        sessionId,
                        scraper_alert: 'submitted_zero',
                    });
                } else {
                    log.info('Jobs submitted', {
                        platform: platformName,
                        jobCount: formatted.length,
                        progress: submitResponse.progress,
                    });
                }
                metrics.recordJobsSubmitted(platformName, 'success', formatted.length);
```

- [ ] **Step 4: Run test to verify it still passes (contract preserved)**

Run: `node --test test/queue/orchestrator.test.js`
Expected: all tests pass, 0 fail (6 total). The O9 test still passes — proving the submit/metric contract is unchanged; only logging branched.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/queue/orchestrator.js test/queue/orchestrator.test.js
git commit -m "feat(orchestrator): distinct log signal for 0-job 'success' submissions (O9)

scraper_alert:'submitted_zero'. Wire status + metric unchanged (no
backend-contract change); the metric dimension is already covered by
scraper_zero_result_sessions_total at the scraper layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Verification + handoff notes

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-phase1b-pipeline-NOTES.md`

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: every test file green; final summary `fail 0`. Record the pass count.

- [ ] **Step 2: Confirm no scraper / API-contract change**

Run: `git diff origin/main -- src/scrapers/ scrapers/ src/api/`
Expected: **no output** (this plan only touched `src/queue/orchestrator.js` + `test/queue/`). If there IS output, STOP and report BLOCKED.

- [ ] **Step 3: Confirm the DI seam is inert in production (server.js unchanged + passes no overrides)**

Run: `git diff origin/main -- server.js` (expect no output) and
`grep -n "new QueueOrchestrator" server.js`
Expected: `git diff` empty; the `grep` shows the existing `new QueueOrchestrator({ blacklightConfig, queueConfig, defaultLocation })` call with NO `client`/`metrics`/`scraperResolver` keys — so production uses the real `BlacklightApiClient`, real `getMetrics()`, real `getScraper`.

- [ ] **Step 4: Write the handoff note**

Create `docs/superpowers/plans/2026-05-18-phase1b-pipeline-NOTES.md`:

```markdown
# Phase 1B-pipeline — completion notes

Status: COMPLETE. All tests green (`npm test`, fail 0).

Delivered:
- DI seam on QueueOrchestrator (optional client/metrics/scraperResolver);
  behavior-neutral in production (server.js passes none).
- C3: all-failed assignment now fires metrics.recordSessionAllFailed()
  + a `scraper_alert:'session_all_failed'` error log; completeSession is
  STILL always called (backend coordinates sibling sessions).
- O9: a 0-job 'success' submission now emits a distinct
  `scraper_alert:'submitted_zero'` warn log. Wire status + metric
  UNCHANGED (no backend-contract change; the metric dimension is already
  scraper_zero_result_sessions_total from Plan 1B).

Production impact: observability-only. No scraper code, no HTTP
request/response contract change, server.js untouched. Verified:
`git diff origin/main -- src/scrapers scrapers src/api server.js` empty.

The ScraperAllFailedSessions alert (committed in Plan 1B) now has a live
producer (recordSessionAllFailed call site) — it can fire for real.

NOT done — the remaining Phase 1 work:
- Plan 1C (production-behavior-changing): wire assertNotBlocked() into
  the 6 scrapers at nav/pre-parse points; return {jobs,emptyConfirmed:
  true} only on a positively-confirmed empty result; fix Indeed
  loginSuccess timing (I13), Indeed page-1 pagination (I2), Glassdoor
  early-abort (I14), LinkedIn mid-scrape detection (L2). Only AFTER 1C
  lands per-host, flip SCRAPER_STRICT_EMPTY=true. M5 contract: 1C must
  only pass detectBlock a block-page title, never a scraped job title.
  This is the slice that actually changes live scraper behavior — it
  needs an explicit pre-flip checkpoint with the user.
- O9 on-the-wire status change (submit a distinguishable status to the
  backend) remains deferred — needs backend coordination/sign-off.
- Pre-existing, still out of scope: .gitignore + pnpm-lock.yaml drift
  (pnpm-lock drift is audit O7 -> Phase 5); the recordJobsSubmitted /
  recordLinkedInQueryYield Infinity-guard tidy (1B NOTES).
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-18-phase1b-pipeline-NOTES.md
git commit -m "docs(plan): Phase 1B-pipeline completion + Plan 1C handoff notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- C3 (all-failed not silently completed) → Task 2 (metric + loud log; completeSession still called) ✓
- O9 (0-job success recorded distinctly) → Task 3 (distinct `submitted_zero` log; wire/metric contract preserved) ✓
- C1 orchestrator-observable slice → covered by C3+O9 signals; **substantive C1 (scrapers throw `BlockedError`) is explicitly Plan 1C** (header + Task 4 NOTES) — deferred by design, not a gap ✓
- Test enablement (DI) → Task 1 ✓
- `recordSessionAllFailed()` producer now exists (consumes the Plan 1B metric + the committed `ScraperAllFailedSessions` alert) ✓

**2. Placeholder scan:** No TBD/TODO/"handle appropriately". Every code step shows the exact replacement in full context. The O9 "log isn't unit-asserted" is an explicit, justified scoping decision (no logger-injection refactor), with the regression-lock test asserting the contract that matters — not a placeholder.

**3. Type/name consistency:** `this._metrics`/`#metrics()`/`this._resolveScraper`/`scraperResolver`/`recordSessionAllFailed`/`scraper_alert:'session_all_failed'`/`'submitted_zero'` are consistent across Tasks 1–4 and match the registry method name shipped in Plan 1B (`recordSessionAllFailed`) and the Plan 1B alert `ScraperAllFailedSessions` (which keys on `scraper_sessions_all_failed_total`, the counter `recordSessionAllFailed()` increments). Fake client/metrics shapes in tests match the methods the orchestrator actually calls (`checkCredentialAvailability`, `getNextRole`, `submitJobs`, `completeSession`, `recordQueueCheck`, `recordJobsSubmitted`, `recordSessionAllFailed`).

**4. Scope:** One cohesive subsystem (orchestrator truthfulness), single source file + its test, behavior-neutral DI + two observability-only additions, no HTTP/scraper change. Production-inert seam verified in Task 4. Plan 1C (the production-behavior-changing slice) is correctly carved out with an explicit pre-flip checkpoint flagged. No issues requiring rework.
