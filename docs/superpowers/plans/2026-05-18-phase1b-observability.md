# Phase 1B — Observability Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a blocked / silently-empty scraper *detectable from telemetry* — add per-platform zero-result + last-nonzero-scrape metrics wired to the existing BaseScraper seam, commit Prometheus alert rules + a Grafana dashboard into the repo, honest `scraper_up` help, and the ops-doc/advisory cleanups — so an operator (and an alert) can tell "100% blocked" from "no jobs matched" even before per-scraper detection (Plan 1C) lands.

**Architecture:** Pure-additive metrics on the existing `MetricsRegistry` (new gauges/counters + a `noteZeroJobs()`/`recordSessionAllFailed()` method; the `noteZeroJobs?.()` call site already exists in `base-scraper.js` from Plan 1A, so wiring is "implement the method the seam already calls"). `recordJobsScraped` is changed to set a per-platform *gauge* on every session (including 0) and a *last-nonzero timestamp* only when >0 — turning the previously-invisible "counter stops incrementing" into an alertable flatline. Alert rules + dashboard are committed as version-controlled YAML/JSON. No scraper or orchestrator behavior changes here.

**Tech Stack:** Node.js 20+ ESM (host runs **Node v24.14.0**), `node:test` + `node:assert/strict`, prom-client (existing, installed). No new dependencies.

> **Node 24 note (carried from 1A):** `node --test <dir>` is broken on Node 24. `package.json` already uses `node --test 'test/**/*.test.js'`; explicit single-file paths work on all versions. Node 24's reporter prints `ℹ pass N`/`ℹ fail N`. Success = "the task's new tests pass AND fail 0", never an exact cumulative count (the suite carries 26 tests from Plan 1A).

**Source spec:** `docs/superpowers/specs/2026-05-18-blacklight-scraper-anti-bot-audit-design.md` — Phase 1B findings covered **here**: **O1** (per-platform zero/last-scraped signal), **O3** (last-nonzero-scrape gauge + heartbeat≠scrape-health doc), **O4** (commit alert rules + dashboard), **O5** (daemon-mode runbooks), **O10** (deceptive `scraper_up`), plus Plan 1A final-review advisories **M1, M2, M3, M4**. **Deferred to sibling plans** (documented in Task 6 NOTES): **Plan 1B-pipeline** = orchestrator **C1/C3/O9** (submit/complete truthfulness; needs a client-injection refactor to be TDD-able); **Plan 1C** = per-scraper `assertNotBlocked` wiring + I13/I2/I14/L2 + enabling `SCRAPER_STRICT_EMPTY`.

**Production-safety contract:** every change is additive or a help-text/doc/test change. No scraper, orchestrator, or submit/complete behavior changes. The new metrics are written by code paths that already run (`recordJobsScraped`, the existing `noteZeroJobs?.()` seam). The only runtime delta is extra metric series being emitted. Verified inert at the pipeline level by Task 6.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/core/block-detection.js` | Block detection constants | Modify (M1: host-qualify `/authwall`) |
| `test/core/block-detection.test.js` | Detection tests | Modify (M1 regression + M2 HTTP 401 test) |
| `src/metrics/classify.js` | Error→reason classifier | Modify (M3: reword misleading header comment only) |
| `src/metrics/registry.js` | Metrics single-source-of-truth | Modify (O1/O3/O10 collectors + methods + `recordJobsScraped`) |
| `test/metrics/registry.test.js` | Registry unit tests | **Create** |
| `test/core/base-scraper-metrics.test.js` | BaseScraper↔registry integration | **Create** |
| `observability/alerts.yml` | Prometheus alerting rules (O4) | **Create** |
| `observability/dashboard.json` | Grafana dashboard (O4) | **Create** |
| `observability/README.md` | Heartbeat≠scrape-health + load instructions (O3) | **Create** |
| `test/observability/artifacts.test.js` | Validate committed alert/dashboard artifacts | **Create** |
| `.env.example` | Document `SCRAPER_STRICT_EMPTY` (M4) | Modify |
| `docs/MAC_SETUP.md` | launchd `SCRAPER_MODE=daemon` (O5) | Modify |
| `docs/WINDOWS_SETUP.md` | NSSM `SCRAPER_MODE=daemon` (O5) | Modify |
| `test/observability/ops-docs.test.js` | Assert ops-doc/.env changes present | **Create** |
| `docs/superpowers/plans/2026-05-18-phase1b-NOTES.md` | Completion + 1B-pipeline/1C handoff | **Create** |

Tests live under `test/` mirroring `src/`.

---

## Task 1: Final-review advisory cleanups (M1, M2, M3)

**Files:**
- Modify: `src/core/block-detection.js` (the `BLOCK_URL_FRAGMENTS` array)
- Modify: `test/core/block-detection.test.js` (append 2 tests)
- Modify: `src/metrics/classify.js` (header comment lines 7–8 only)

- [ ] **Step 1: Write the failing tests**

Append to the END of `test/core/block-detection.test.js`:

```js
test('M1: a non-LinkedIn job URL containing "authwall" substring is NOT blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://jobs.example.com/authwall-platform-engineer/9912',
        title: 'Authwall Platform Engineer | Example Jobs',
        html: '<div class="job_seen_beacon">role</div>',
    });
    assert.equal(r.blocked, false);
});

test('M1: a real LinkedIn authwall URL is still blocked (auth_wall)', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.linkedin.com/authwall?trk=bf&sessionRedirect=%2Fjobs',
        title: 'LinkedIn',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'auth_wall');
});

test('M2: HTTP 401 is blocked (http_forbidden)', () => {
    const r = detectBlock({ status: 401, finalUrl: 'https://x', title: '' });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'http_forbidden');
});
```

- [ ] **Step 2: Run the tests to verify the M1 substring test fails**

Run: `node --test test/core/block-detection.test.js`
Expected: the test `M1: a non-LinkedIn job URL containing "authwall" substring is NOT blocked` FAILS (current `BLOCK_URL_FRAGMENTS` contains bare `'/authwall'`, which `.includes()`-matches `/authwall-platform-engineer`). The real-LinkedIn-authwall test and the HTTP-401 test PASS already (401 is handled identically to 403; the LinkedIn URL still contains `/authwall`). 0 unexpected regressions in the other tests.

- [ ] **Step 3: Host-qualify the authwall fragment**

In `src/core/block-detection.js`, replace the `BLOCK_URL_FRAGMENTS` array (the bare `'/authwall'` is the false-positive surface — qualify it to LinkedIn's host so a generic job slug can't trip it, while the real `https://www.linkedin.com/authwall?...` still matches):

```js
// URL path fragments meaning "not on a content page".
const BLOCK_URL_FRAGMENTS = [
    '/checkpoint/', 'linkedin.com/authwall', '/uas/login', '/account/login',
    '/captcha/', '/challenge/',
];
```

- [ ] **Step 4: Run the detection tests to verify all pass**

Run: `node --test test/core/block-detection.test.js`
Expected: every test passes, 0 fail (the original 12 + the 3 appended). The `signal` for the LinkedIn authwall case is now `url:linkedin.com/authwall` (kind still `auth_wall`).

- [ ] **Step 5: Reword the misleading classify.js header comment (M3)**

In `src/metrics/classify.js`, replace lines 7–8 (the comment claiming reasons must match a registry label set):

Old:
```js
// Reasons must match the label set declared in src/metrics/registry.js
// (see scraper_failures_total) or Grafana alert rules will miss them.
```

New:
```js
// prom-client does NOT enforce a closed set of `reason` label values, so
// adding a reason here cannot break metric writes. The real coupling is
// the committed Grafana alert rules (observability/alerts.yml): a reason
// string used in an alert expr must match what this file emits.
```

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: whole suite green, `fail 0` (Plan 1A's 26 + the 3 new detection tests = 29; exact count illustrative).

- [ ] **Step 7: Commit**

```bash
git add src/core/block-detection.js test/core/block-detection.test.js src/metrics/classify.js
git commit -m "fix(detection): host-qualify authwall fragment + 401 test; reword classify header (M1,M2,M3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Registry observability metrics (O1, O3, O10)

**Files:**
- Modify: `src/metrics/registry.js` (add collectors in `buildCollectors()`; reword `scraper_up` help; rewrite `recordJobsScraped`; add `noteZeroJobs` + `recordSessionAllFailed`)
- Create: `test/metrics/registry.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/metrics/registry.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMetrics, resetMetricsForTest } from '../../src/metrics/registry.js';
import { resetConfigForTest } from '../../src/config/env.js';

function freshMetrics() {
    resetConfigForTest();
    resetMetricsForTest();
    return getMetrics();
}

test('recordJobsScraped sets the last-scraped gauge on every call, including 0', async () => {
    const m = freshMetrics();
    m.recordJobsScraped('indeed', 0);
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="indeed"[^}]*\}\s+0\b/);
});

test('a >0 scrape sets the gauge, increments the counter, and sets last-nonzero timestamp', async () => {
    const m = freshMetrics();
    m.recordJobsScraped('dice', 7);
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="dice"[^}]*\}\s+7\b/);
    assert.match(text, /scraper_jobs_scraped_total\{[^}]*platform="dice"[^}]*\}\s+7\b/);
    assert.match(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="dice"[^}]*\}\s+\d{10}/);
});

test('a 0 scrape does NOT set last-nonzero timestamp or bump the total counter', async () => {
    const m = freshMetrics();
    m.recordJobsScraped('glassdoor', 0);
    const text = await m.snapshot();
    assert.doesNotMatch(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="glassdoor"/);
    assert.doesNotMatch(text, /scraper_jobs_scraped_total\{[^}]*platform="glassdoor"/);
});

test('noteZeroJobs increments scraper_zero_result_sessions_total per platform', async () => {
    const m = freshMetrics();
    m.noteZeroJobs('indeed');
    m.noteZeroJobs('indeed');
    const text = await m.snapshot();
    assert.match(text, /scraper_zero_result_sessions_total\{[^}]*platform="indeed"[^}]*\}\s+2\b/);
});

test('recordSessionAllFailed increments scraper_sessions_all_failed_total', async () => {
    const m = freshMetrics();
    m.recordSessionAllFailed();
    const text = await m.snapshot();
    assert.match(text, /scraper_sessions_all_failed_total(\{[^}]*\})?\s+1\b/);
});

test('scraper_up help no longer claims to be a health signal', async () => {
    const m = freshMetrics();
    const text = await m.snapshot();
    assert.match(text, /# HELP scraper_up .*liveness/i);
    assert.match(text, /scraper_last_nonzero_scrape_timestamp_seconds/); // referenced in help
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/metrics/registry.test.js`
Expected: FAIL — `m.noteZeroJobs`/`m.recordSessionAllFailed` are not functions; `scraper_jobs_last_scraped` / `scraper_last_nonzero_scrape_timestamp_seconds` / `scraper_zero_result_sessions_total` / `scraper_sessions_all_failed_total` not in snapshot; `scraper_up` help still says "up (1) or down (0)".

- [ ] **Step 3: Add the four collectors**

In `src/metrics/registry.js`, inside `buildCollectors()`, immediately after the `this.jobsScrapedTotal = new Counter({...});` block (currently ends at line 121), add:

```js

        // Silent-block visibility (spec O1/O3) ----------------------------
        // jobsScrapedTotal is a monotonic counter — it simply STOPS
        // incrementing when a scraper is blocked, which is invisible on a
        // rate() panel and identical to "no jobs matched". These three
        // make the silent case loud:
        this.jobsLastScraped = new Gauge({
            name: 'scraper_jobs_last_scraped',
            help: 'Jobs from the most recent scrape per platform, set on EVERY session including 0. A flatline at 0 is the silent-block / DOM-change signal.',
            labelNames: ['platform'],
            registers: reg,
        });

        this.lastNonzeroScrapeTimestamp = new Gauge({
            name: 'scraper_last_nonzero_scrape_timestamp_seconds',
            help: 'Unix seconds of the last scrape that returned > 0 jobs, per platform. Staleness here = blocked/broken even while scraper_up=1.',
            labelNames: ['platform'],
            registers: reg,
        });

        this.zeroResultSessionsTotal = new Counter({
            name: 'scraper_zero_result_sessions_total',
            help: 'Sessions that did not throw but yielded 0 jobs and were NOT positively confirmed-empty (suspected silent block / DOM change).',
            labelNames: ['platform'],
            registers: reg,
        });

        this.sessionsAllFailedTotal = new Counter({
            name: 'scraper_sessions_all_failed_total',
            help: 'Assignments where every platform failed or yielded zero. Completed anyway (backend coordination) but flagged for alerting.',
            registers: reg,
        });
```

- [ ] **Step 4: Reword the `scraper_up` help (O10)**

In `src/metrics/registry.js`, replace the `this.up = new Gauge({...})` block (currently lines 72–76) with:

```js
        this.up = new Gauge({
            name: 'scraper_up',
            help: 'Process liveness ONLY — 1 while the push loop runs; never 0 in practice. NOT scrape health: a 100%-blocked scraper still reports 1. Use scraper_last_nonzero_scrape_timestamp_seconds for scrape health.',
            registers: reg,
        });
```

(Keep the `this.up.set(1);` line that follows it unchanged.)

- [ ] **Step 5: Rewrite `recordJobsScraped` and add the two methods**

In `src/metrics/registry.js`, replace the entire `recordJobsScraped(platform, count) { ... }` method (currently lines 223–226) with:

```js
    recordJobsScraped(platform, count) {
        const n = Number.isFinite(count) && count > 0 ? count : 0;
        this.#safe(() => {
            // Gauge is set on EVERY session, including 0 — that is the
            // whole point: a flatline at 0 is the silent-block signal.
            this.jobsLastScraped.labels(platform).set(n);
            if (n > 0) {
                this.jobsScrapedTotal.labels(platform).inc(n);
                this.lastNonzeroScrapeTimestamp
                    .labels(platform)
                    .set(Math.floor(Date.now() / 1000));
            }
        });
    }

    // Called by BaseScraper when a scrape returned 0 jobs WITHOUT a
    // positive confirmed-empty signal (the Plan 1A `noteZeroJobs?.()`
    // seam). This is the metric an operator alerts on for silent blocks.
    noteZeroJobs(platform) {
        this.#safe(() => this.zeroResultSessionsTotal.labels(platform).inc());
    }

    // Called (in Plan 1B-pipeline) when an entire assignment had zero
    // successful platforms. Defined here so the metric exists and is
    // testable now; the call site lands with the orchestrator work.
    recordSessionAllFailed() {
        this.#safe(() => this.sessionsAllFailedTotal.inc());
    }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/metrics/registry.test.js`
Expected: 6 tests pass, 0 fail.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/metrics/registry.js test/metrics/registry.test.js
git commit -m "feat(metrics): per-platform zero/last-scraped + all-failed signals; honest scraper_up (O1,O3,O10)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: BaseScraper ↔ registry integration (verify O1 wiring, test-only)

**Files:**
- Create: `test/core/base-scraper-metrics.test.js`

(BaseScraper already calls `recordJobsScraped(platform, jobCount)` on every success path and `metrics.noteZeroJobs?.(platform)` on the unconfirmed-empty path — both added in Plan 1A. Task 2 implemented the methods those calls hit. This task proves the end-to-end wiring against the REAL registry and locks it; no production code changes expected. If a test fails, the wiring is broken — STOP and escalate, do not weaken the test or hand-patch base-scraper.)

- [ ] **Step 1: Write the test**

Create `test/core/base-scraper-metrics.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';
import { getMetrics, resetMetricsForTest } from '../../src/metrics/registry.js';
import { resetConfigForTest } from '../../src/config/env.js';

function freshRealRegistry() {
    resetConfigForTest();
    resetMetricsForTest();
    return getMetrics();
}

test('a >0 scrape sets gauge + last-nonzero via the real registry', async () => {
    const m = freshRealRegistry();
    const s = new BaseScraper('indeed', async () => [{ id: 1 }, { id: 2 }], { metrics: m });
    await s.execute('node', 'remote', 'sX');
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="indeed"[^}]*\}\s+2\b/);
    assert.match(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="indeed"/);
});

test('an unconfirmed-empty scrape (default) sets gauge 0 + zero-result counter, NOT last-nonzero', async () => {
    const m = freshRealRegistry();
    const s = new BaseScraper('glassdoor', async () => [], { metrics: m });
    const out = await s.execute('node', 'remote', 'sY');
    assert.deepEqual(out, []); // production behavior preserved
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="glassdoor"[^}]*\}\s+0\b/);
    assert.match(text, /scraper_zero_result_sessions_total\{[^}]*platform="glassdoor"[^}]*\}\s+1\b/);
    assert.doesNotMatch(text, /scraper_last_nonzero_scrape_timestamp_seconds\{[^}]*platform="glassdoor"/);
});

test('a confirmed-empty scrape sets gauge 0 but does NOT increment the zero-result counter', async () => {
    const m = freshRealRegistry();
    const s = new BaseScraper('dice', async () => ({ jobs: [], emptyConfirmed: true }), { metrics: m });
    await s.execute('node', 'remote', 'sZ');
    const text = await m.snapshot();
    assert.match(text, /scraper_jobs_last_scraped\{[^}]*platform="dice"[^}]*\}\s+0\b/);
    assert.doesNotMatch(text, /scraper_zero_result_sessions_total\{[^}]*platform="dice"/);
});
```

- [ ] **Step 2: Run test to verify it passes (wiring already exists end-to-end)**

Run: `node --test test/core/base-scraper-metrics.test.js`
Expected: 3 tests pass, 0 fail. (If any fail, the Plan 1A seam or Task 2 method is mis-wired — STOP, report BLOCKED with the diff between expected and actual snapshot; do not edit base-scraper.js or weaken the test.)

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add test/core/base-scraper-metrics.test.js
git commit -m "test(metrics): lock BaseScraper->registry zero/nonzero wiring (O1 end-to-end)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Committed alert rules + dashboard + observability README (O4, O3-doc)

**Files:**
- Create: `observability/alerts.yml`
- Create: `observability/dashboard.json`
- Create: `observability/README.md`
- Create: `test/observability/artifacts.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/observability/artifacts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('alerts.yml declares the silent-block alert set and references real metrics', () => {
    const y = readFileSync(join(root, 'observability', 'alerts.yml'), 'utf8');
    for (const name of [
        'ScraperZeroResultRatioHigh',
        'ScraperNoNonzeroScrape',
        'ScraperBlockedFailures',
        'ScraperAllFailedSessions',
    ]) {
        assert.ok(y.includes(name), `missing alert: ${name}`);
    }
    for (const metric of [
        'scraper_zero_result_sessions_total',
        'scraper_sessions_total',
        'scraper_last_nonzero_scrape_timestamp_seconds',
        'scraper_failures_total',
        'scraper_sessions_all_failed_total',
    ]) {
        assert.ok(y.includes(metric), `alert rules never reference ${metric}`);
    }
});

test('dashboard.json is valid JSON and targets the new metrics', () => {
    const raw = readFileSync(join(root, 'observability', 'dashboard.json'), 'utf8');
    const dash = JSON.parse(raw); // throws if invalid
    assert.ok(Array.isArray(dash.panels) && dash.panels.length >= 3);
    const blob = JSON.stringify(dash);
    for (const metric of [
        'scraper_jobs_last_scraped',
        'scraper_last_nonzero_scrape_timestamp_seconds',
        'scraper_zero_result_sessions_total',
    ]) {
        assert.ok(blob.includes(metric), `dashboard never references ${metric}`);
    }
});

test('observability README states heartbeat is not scrape health', () => {
    const r = readFileSync(join(root, 'observability', 'README.md'), 'utf8');
    assert.match(r, /heartbeat/i);
    assert.match(r, /not.*scrape health|scrape health.*not/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/observability/artifacts.test.js`
Expected: FAIL — the three `observability/` files do not exist (`ENOENT`).

- [ ] **Step 3: Create `observability/alerts.yml`**

```yaml
# Prometheus alerting rules — committed so the metric↔alert contract is
# code-reviewable and versioned (audit finding O4). Load into the
# Prometheus/Alertmanager that scrapes this fleet's Pushgateway.
#
# These fire on the SILENT failure modes Plan 1A/1B make observable: a
# scraper that returns 0 jobs without throwing, or has not produced a
# job in hours, while scraper_up is still 1.
groups:
  - name: scraper-anti-bot-durability
    rules:
      - alert: ScraperZeroResultRatioHigh
        expr: |
          (
            sum by (platform) (rate(scraper_zero_result_sessions_total[1h]))
            /
            clamp_min(sum by (platform) (rate(scraper_sessions_total{result="success"}[1h])), 0.0001)
          ) > 0.8
        for: 30m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.platform }} is mostly returning 0 jobs (suspected silent block / DOM change)"
          description: "Over 80% of {{ $labels.platform }} successful sessions in the last hour yielded 0 jobs. This is the audit's dominant silent-failure signature."

      - alert: ScraperNoNonzeroScrape
        expr: time() - max by (platform) (scraper_last_nonzero_scrape_timestamp_seconds) > 21600
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.platform }} has produced no jobs for > 6h while up"
          description: "scraper_last_nonzero_scrape_timestamp_seconds for {{ $labels.platform }} is stale by >6h though the process is alive — blocked or broken."

      - alert: ScraperBlockedFailures
        expr: sum by (platform) (rate(scraper_failures_total{reason=~"blocked|captcha|dom_changed|auth_required|rate_limited"}[1h])) > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.platform }} is reporting block/challenge failures"
          description: "scraper_failures_total for {{ $labels.platform }} shows reason in (blocked, captcha, dom_changed, auth_required, rate_limited) over the last hour."

      - alert: ScraperAllFailedSessions
        expr: rate(scraper_sessions_all_failed_total[1h]) > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Assignments are completing with zero successful platforms"
          description: "scraper_sessions_all_failed_total is increasing — at least one assignment had every platform fail/zero."
```

- [ ] **Step 4: Create `observability/dashboard.json`**

```json
{
  "title": "Blacklight Scraper — Anti-Bot Durability",
  "schemaVersion": 39,
  "version": 1,
  "editable": true,
  "time": { "from": "now-24h", "to": "now" },
  "templating": { "list": [] },
  "panels": [
    {
      "id": 1,
      "type": "timeseries",
      "title": "Jobs from last scrape (per platform) — flatline at 0 = silent block",
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 0 },
      "targets": [
        { "refId": "A", "expr": "scraper_jobs_last_scraped" }
      ]
    },
    {
      "id": 2,
      "type": "timeseries",
      "title": "Hours since last >0 scrape (per platform)",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "targets": [
        { "refId": "A", "expr": "(time() - max by (platform) (scraper_last_nonzero_scrape_timestamp_seconds)) / 3600" }
      ]
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Zero-result session rate (per platform)",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "targets": [
        { "refId": "A", "expr": "sum by (platform) (rate(scraper_zero_result_sessions_total[1h]))" }
      ]
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Categorized failures (per platform/reason)",
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 16 },
      "targets": [
        { "refId": "A", "expr": "sum by (platform, reason) (rate(scraper_failures_total[1h]))" }
      ]
    }
  ]
}
```

- [ ] **Step 5: Create `observability/README.md`**

```markdown
# Observability artifacts

Version-controlled so the metric↔alert contract is reviewable (audit O4).

- `alerts.yml` — Prometheus alerting rules. Load into the Prometheus that
  scrapes this fleet's Pushgateway (rule_files: in prometheus.yml, or an
  Alertmanager-managed rule group).
- `dashboard.json` — import into Grafana (Dashboards → Import → Upload JSON).

## Heartbeat is NOT scrape health

`scraper_up` and `scraper_last_heartbeat_timestamp_seconds` only prove the
Node process is alive and the push loop is running. A scraper that is
**100% blocked still reports `scraper_up = 1`** and a fresh heartbeat. Do
not build "is the scraper working?" alerts on those.

Scrape health is `scraper_last_nonzero_scrape_timestamp_seconds` (per
platform) and `scraper_zero_result_sessions_total`. The committed alerts
key off those. `SCRAPER_MODE=daemon` only adds a process-offline alert —
it is necessary but not sufficient; the residential hosts that get
blocked most must run daemon mode AND have these rules loaded.

## Status of detection

Until Plan 1C wires `assertNotBlocked()` into the scrapers, a block still
surfaces primarily as "0 jobs" (→ `scraper_zero_result_sessions_total` +
`scraper_jobs_last_scraped` flatline), not as a `blocked` failure. The
`ScraperZeroResultRatioHigh` / `ScraperNoNonzeroScrape` alerts are the
load-bearing ones in that interim; `ScraperBlockedFailures` becomes
primary once 1C lands.
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/observability/artifacts.test.js`
Expected: 3 tests pass, 0 fail.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add observability/alerts.yml observability/dashboard.json observability/README.md test/observability/artifacts.test.js
git commit -m "feat(observability): commit Prometheus alerts + Grafana dashboard + README (O4,O3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Ops docs — `.env.example` (M4) + daemon-mode runbooks (O5)

**Files:**
- Modify: `.env.example` (add a `SCRAPER_STRICT_EMPTY` block near `SCRAPER_MODE`)
- Modify: `docs/MAC_SETUP.md` (launchd plist `EnvironmentVariables`)
- Modify: `docs/WINDOWS_SETUP.md` (NSSM `AppEnvironmentExtra` line)
- Create: `test/observability/ops-docs.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/observability/ops-docs.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('.env.example documents SCRAPER_STRICT_EMPTY (default false)', () => {
    const e = read('.env.example');
    assert.match(e, /SCRAPER_STRICT_EMPTY\s*=\s*false/);
    assert.match(e, /strict/i);
});

test('MAC_SETUP launchd plist sets SCRAPER_MODE=daemon', () => {
    const m = read('docs/MAC_SETUP.md');
    assert.match(m, /<key>SCRAPER_MODE<\/key>\s*\n\s*<string>daemon<\/string>/);
});

test('WINDOWS_SETUP NSSM env sets SCRAPER_MODE=daemon', () => {
    const w = read('docs/WINDOWS_SETUP.md');
    assert.match(w, /AppEnvironmentExtra[^\n]*SCRAPER_MODE=daemon/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/observability/ops-docs.test.js`
Expected: all 3 FAIL — none of these strings exist yet.

- [ ] **Step 3: Add `SCRAPER_STRICT_EMPTY` to `.env.example`**

In `.env.example`, replace the `SCRAPER_MODE` block (currently lines 29–31):

Old:
```
# "daemon" for always-on machines (Pi, VPS) — alerts fire if silent > 5 min.
# "interactive" (default) for laptops — no offline alerts.
SCRAPER_MODE=interactive
```

New:
```
# "daemon" for always-on machines (Pi, VPS) — alerts fire if silent > 5 min.
# "interactive" (default) for laptops — no offline alerts.
SCRAPER_MODE=interactive

# Treat a scrape that returns 0 jobs WITHOUT a positively-confirmed
# empty result as a failure (throws, cooldown, failed metric) instead of
# a silent success. Default false (Plan 1A/1B are observe-only). Flip to
# true per-host ONLY after Plan 1C wires assertNotBlocked() + confirmed-
# empty into every scraper, or legitimate "no jobs" runs will fail.
SCRAPER_STRICT_EMPTY=false
```

- [ ] **Step 4: Add `SCRAPER_MODE=daemon` to the launchd plist (MAC_SETUP.md)**

In `docs/MAC_SETUP.md`, replace the `EnvironmentVariables` dict (currently lines 233–239) — insert the `SCRAPER_MODE` key/value before the existing `NODE_ENV` pair:

Old:
```
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
```

New:
```
    <key>EnvironmentVariables</key>
    <dict>
        <key>SCRAPER_MODE</key>
        <string>daemon</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
```

- [ ] **Step 5: Add `SCRAPER_MODE=daemon` to the NSSM env (WINDOWS_SETUP.md)**

In `docs/WINDOWS_SETUP.md`, replace the NSSM `AppEnvironmentExtra` line (currently line 211):

Old:
```
C:\Tools\nssm\nssm.exe set qp-scraper AppEnvironmentExtra NODE_ENV=production
```

New:
```
C:\Tools\nssm\nssm.exe set qp-scraper AppEnvironmentExtra NODE_ENV=production SCRAPER_MODE=daemon
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/observability/ops-docs.test.js`
Expected: 3 tests pass, 0 fail.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: whole suite green, `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add .env.example docs/MAC_SETUP.md docs/WINDOWS_SETUP.md test/observability/ops-docs.test.js
git commit -m "docs(ops): SCRAPER_STRICT_EMPTY in .env.example; SCRAPER_MODE=daemon in runbooks (M4,O5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verification + handoff notes

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-phase1b-NOTES.md`

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: every test file green; final summary `fail 0`. Record the pass count.

- [ ] **Step 2: Confirm no scraper/orchestrator behavior changed (1B is observe-only)**

Run: `git diff main -- src/scrapers/ src/queue/ src/api/ scrapers/`
Expected: **no output** (Plan 1B touches only `src/core/block-detection.js` constants, `src/metrics/`, `src/metrics/classify.js` comment, observability/, docs/, .env.example, test/ — no scraper/orchestrator/api source).

- [ ] **Step 3: Confirm `recordJobsScraped` still no-ops the counter for 0 (no false job inflation)**

Run: `node -e "import('./src/metrics/registry.js').then(async ({getMetrics,resetMetricsForTest})=>{const {resetConfigForTest}=await import('./src/config/env.js');resetConfigForTest();resetMetricsForTest();const m=getMetrics();m.recordJobsScraped('x',0);const t=await m.snapshot();console.log(/scraper_jobs_scraped_total\{[^}]*platform=\"x\"/.test(t)?'FAIL: counter bumped on 0':'OK: counter untouched on 0');})"`
Expected: prints `OK: counter untouched on 0`.

- [ ] **Step 4: Write the handoff note**

Create `docs/superpowers/plans/2026-05-18-phase1b-NOTES.md`:

```markdown
# Phase 1B (observability core) — completion notes

Status: COMPLETE. All tests green (`npm test`, fail 0).

Delivered:
- M1 host-qualified the authwall block fragment; M2 401 test; M3 reworded
  classify.js header comment.
- registry.js: scraper_jobs_last_scraped (gauge, every session incl 0),
  scraper_last_nonzero_scrape_timestamp_seconds (gauge, >0 only),
  scraper_zero_result_sessions_total (counter, via noteZeroJobs()),
  scraper_sessions_all_failed_total (counter, via recordSessionAllFailed()
  — metric defined now, call site lands with 1B-pipeline). scraper_up help
  reworded to stop claiming health (O10).
- BaseScraper->registry zero/nonzero wiring locked by integration tests
  (the Plan 1A noteZeroJobs?.() seam now hits a real method).
- observability/alerts.yml + dashboard.json + README committed (O4); README
  documents heartbeat != scrape health (O3).
- .env.example documents SCRAPER_STRICT_EMPTY=false (M4); MAC/WINDOWS
  runbooks set SCRAPER_MODE=daemon (O5).

Production impact: observe-only. No scraper/orchestrator/api source changed
(verified by `git diff main -- src/scrapers src/queue src/api scrapers`).
New metric series are emitted by code paths that already ran.

NOT done — required follow-ups:
- Plan 1B-pipeline: orchestrator C1/C3/O9 — submit a distinguishable
  signal for 0-job/blocked platforms and call recordSessionAllFailed()
  when summary.successful===0; needs a client/metrics injection seam on
  QueueOrchestrator to be TDD-able without live HTTP. Do NOT change the
  on-the-wire submit `status` to an unknown value without backend
  coordination (risk: backend rejects); the safe slice is metric + loud
  log now, wire-status change only with backend sign-off.
- Plan 1C: per-scraper assertNotBlocked() at nav/pre-parse points +
  return {jobs,emptyConfirmed:true} only on positively-confirmed empty;
  fix Indeed loginSuccess timing (I13), Indeed page-1 pagination (I2),
  Glassdoor early-abort (I14), LinkedIn mid-scrape detection (L2). THEN
  flip SCRAPER_STRICT_EMPTY=true per host. M5 contract: 1C must only
  pass detectBlock a block-page title, never a scraped job title.
- Pre-existing, still out of scope: .gitignore + pnpm-lock.yaml drift
  (pnpm-lock drift is audit O7 → Phase 5).
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-18-phase1b-NOTES.md
git commit -m "docs(plan): Phase 1B completion + 1B-pipeline/1C handoff notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Phase 1B subset this plan owns):**
- O1 (per-platform zero/last-scraped signal) → Task 2 (`jobsLastScraped`, `zeroResultSessionsTotal`) + Task 3 (wiring proof) ✓
- O3 (last-nonzero gauge + heartbeat≠health doc) → Task 2 (`lastNonzeroScrapeTimestamp`) + Task 4 (README) ✓
- O4 (committed alert rules + dashboard) → Task 4 ✓
- O5 (daemon-mode runbooks) → Task 5 ✓
- O10 (deceptive `scraper_up`) → Task 2 Step 4 (help reword; full removal deliberately deferred to avoid breaking external scrapers/alerts — documented) ✓
- M1/M2/M3 → Task 1 ✓; M4 → Task 5 ✓; M5 → recorded as a 1C contract in Task 6 NOTES (no code in 1B) ✓
- O2 — classifier half done in Plan 1A; 1B's part is the committed alerts referencing `blocked|dom_changed|captcha` (Task 4 `ScraperBlockedFailures`) ✓
- **Deferred, not gaps (documented in header + Task 6):** C1/C3/O9 → Plan 1B-pipeline; per-scraper detection wiring → Plan 1C. C3's metric (`recordSessionAllFailed`) is defined+tested here so 1B-pipeline only adds the call site.

**2. Placeholder scan:** No TBD/TODO/"handle appropriately". Every code step has complete content; every run step has an exact command + expected result. The `recordSessionAllFailed` "call site lands later" is an intentional, documented seam (method defined+tested now), not a placeholder.

**3. Type/name consistency:** Metric field names (`jobsLastScraped`, `lastNonzeroScrapeTimestamp`, `zeroResultSessionsTotal`, `sessionsAllFailedTotal`) and method names (`recordJobsScraped`, `noteZeroJobs`, `recordSessionAllFailed`) are identical across Tasks 2/3/6 and match the metric names asserted in Task 4 alerts/dashboard (`scraper_jobs_last_scraped`, `scraper_last_nonzero_scrape_timestamp_seconds`, `scraper_zero_result_sessions_total`, `scraper_sessions_all_failed_total`) and the Plan 1A seam name `noteZeroJobs`. Block fragment `linkedin.com/authwall` is consistent between Task 1 code and its tests.

**4. Scope:** One cohesive, independently-shippable subsystem (make blocking observable). Fully unit/integration-tested with zero new deps. Pipeline-truthfulness and per-scraper detection are correctly carved into sibling plans. No issues requiring rework.
