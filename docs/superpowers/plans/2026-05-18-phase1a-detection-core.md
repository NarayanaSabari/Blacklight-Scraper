# Phase 1A — Detection Core & Error Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared block-detection toolbox, the `BlockedError`/`DomChangedError` taxonomy, the classifier mapping, and a backward-compatible BaseScraper return contract — so later phases can make every silent scraper failure loud, with **zero default production behavior change** in this phase.

**Architecture:** Pure additive building blocks. New typed errors extend the existing `ScraperError`. A new side-effect-free `src/core/block-detection.js` decides "is this page a challenge?" from structural signals (HTTP status, final URL, `<title>`, vendor markers) — never fuzzy body-text substring matching. BaseScraper gains a normalized return contract (`Array` *or* `{ jobs, emptyConfirmed }`) and an **opt-in** `strictEmpty` mode; default behavior (return `[]`, record `success`) is unchanged so nothing breaks in production until per-scraper wiring (Plan 1C) and metrics/alerts (Plan 1B) land.

**Tech Stack:** Node.js 20+ ESM (the dev/CI host here runs **Node v24.14.0**), Node built-in test runner (`node:test` + `node:assert/strict`) — no new dependencies. prom-client (existing). No browser/network code in this plan.

> **Node 24 note:** `node --test <dir>` (bare directory arg) is **broken on Node 24** — it falls through to the module loader. The portable form, verified on Node 24, is `node --test 'test/**/*.test.js'` (single-quoted so the shell passes the literal glob; Node's built-in globber expands `**` recursively and never scans repo `scripts/*-test.mjs`). Explicit single-file paths (`node --test test/x.test.js`) work on all versions. Node 24's default reporter prints `ℹ pass N` / `ℹ fail N` (not TAP `# pass`); treat "pass N / fail 0 / exit 0" as the success criterion regardless of reporter wording. **Cumulative pass counts shown in later steps are illustrative** — Task 3 added 2 false-positive regression guards beyond the original 8, so whole-suite totals run +2 vs. the first-draft numbers; the real success criterion is always "the task's own new tests pass AND `fail 0`", never an exact cumulative integer.

**Source spec:** `docs/superpowers/specs/2026-05-18-blacklight-scraper-anti-bot-audit-design.md` — Phase 1 findings addressed here: **F8** (error taxonomy), **F3 / F11** (centralized structural block detection), **F12 / C1** (BaseScraper "0 jobs ≠ automatic success" seam), and the classifier half of **O2**. Per-scraper wiring (L1, L2, T1, T4, T9, T15, I1, I2, I3, I13, I14) is Plan 1C; metrics/alerts/orchestrator (O1, O3, O4, O5, O9, O10, C3) is Plan 1B.

**Production-safety contract for this plan:** every change is either (a) a new file nothing imports yet, or (b) a strictly backward-compatible addition. After Plan 1A, the live scrapers behave exactly as before (verified by Task 6). The only new runtime effect is one extra `log.warn` line when a scrape returns 0 jobs.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` | Add `test` script (Node built-in runner) | Modify (`scripts`) |
| `src/core/errors.js` | Typed error hierarchy | Modify (append 2 classes) |
| `src/metrics/classify.js` | Error → metric-reason classifier | Modify (2 reasons + 2 instanceof checks) |
| `src/core/block-detection.js` | Pure structural block/challenge detection + `assertNotBlocked` | **Create** |
| `src/core/base-scraper.js` | Lifecycle wrapper; normalized return contract + opt-in strict-empty | Modify (`execute`, constructor) |
| `test/core/errors.test.js` | Unit tests for new error classes | **Create** |
| `test/metrics/classify.test.js` | Unit tests for classifier mapping (new + unchanged) | **Create** |
| `test/core/block-detection.test.js` | Unit tests for `detectBlock`/`assertNotBlocked` | **Create** |
| `test/core/base-scraper.test.js` | Unit tests for return contract + strict-empty | **Create** |

Tests live under `test/` mirroring `src/`; Node's runner auto-discovers `test/**/*.test.js`.

---

## Task 0: Test harness (Node built-in runner, zero dependencies)

**Files:**
- Modify: `package.json:7-11` (the `scripts` block)
- Create: `test/smoke.test.js`

- [ ] **Step 1: Write the failing smoke test**

Create `test/smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node:test harness runs', () => {
    assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Run it to verify the runner works before wiring the script**

Run: `node --test test/smoke.test.js`
Expected: 1 test passes, 0 fail (summary shows `pass 1` / `fail 0`), exit code 0.

- [ ] **Step 3: Add the `test` script to package.json**

In `package.json`, replace the `scripts` object (currently lines 7–11):

```json
  "scripts": {
    "start": "node server.js",
    "dev": "NODE_ENV=development node --watch server.js",
    "chrome:login": "node scripts/chrome-debug.js",
    "test": "node --test 'test/**/*.test.js'"
  },
```

- [ ] **Step 4: Run via the npm script to verify wiring**

Run: `npm test`
Expected: Node recursively discovers `test/smoke.test.js` (and only `test/**` — never repo `scripts/`), summary `pass 1` / `fail 0`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add package.json test/smoke.test.js
git commit -m "test: add Node built-in test runner (no new deps)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: `BlockedError` + `DomChangedError` (spec F8)

**Files:**
- Test: `test/core/errors.test.js` (create)
- Modify: `src/core/errors.js` (append after line 55, after `ValidationError`)

- [ ] **Step 1: Write the failing test**

Create `test/core/errors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ScraperError,
    BlockedError,
    DomChangedError,
} from '../../src/core/errors.js';

test('BlockedError extends ScraperError with BLOCKED code and kind', () => {
    const err = new BlockedError('blocked on indeed', {
        kind: 'cloudflare',
        platform: 'indeed',
    });
    assert.ok(err instanceof ScraperError);
    assert.ok(err instanceof BlockedError);
    assert.equal(err.name, 'BlockedError');
    assert.equal(err.code, 'BLOCKED');
    assert.equal(err.kind, 'cloudflare');
    assert.equal(err.platform, 'indeed');
});

test('BlockedError defaults kind to null and preserves cause', () => {
    const cause = new Error('root');
    const err = new BlockedError('blocked', { cause });
    assert.equal(err.kind, null);
    assert.equal(err.cause, cause);
});

test('DomChangedError extends ScraperError with DOM_CHANGED code', () => {
    const err = new DomChangedError('selectors matched 0 of expected', {
        platform: 'linkedin',
    });
    assert.ok(err instanceof ScraperError);
    assert.ok(err instanceof DomChangedError);
    assert.equal(err.name, 'DomChangedError');
    assert.equal(err.code, 'DOM_CHANGED');
    assert.equal(err.platform, 'linkedin');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core/errors.test.js`
Expected: FAIL — `BlockedError`/`DomChangedError` are `undefined` (`The "BlockedError" is not exported` / `not a constructor`).

- [ ] **Step 3: Append the two classes to `src/core/errors.js`**

Add at the end of `src/core/errors.js` (after the closing `}` of `ValidationError` on line 55):

```js

export class BlockedError extends ScraperError {
    // Anti-bot block / challenge / interstitial (Cloudflare, DataDome,
    // auth-wall, 403/429). `kind` records which signal tripped, for
    // metrics + triage. Distinct from AuthError: the remediation is
    // IP/fingerprint/backoff, NOT credential rotation.
    constructor(message, { kind = null, ...rest } = {}) {
        super(message, { code: 'BLOCKED', ...rest });
        this.name = 'BlockedError';
        this.kind = kind;
    }
}

export class DomChangedError extends ScraperError {
    // Page loaded fine and was NOT blocked, but the expected result
    // containers/fields were absent — the site changed its DOM. Loud
    // by design: must never be reported as a successful empty scrape.
    constructor(message, opts = {}) {
        super(message, { code: 'DOM_CHANGED', ...opts });
        this.name = 'DomChangedError';
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/core/errors.test.js`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.js test/core/errors.test.js
git commit -m "feat(errors): add BlockedError and DomChangedError types (spec F8)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Classifier maps the new error types (spec O2, classifier half)

**Files:**
- Test: `test/metrics/classify.test.js` (create)
- Modify: `src/metrics/classify.js:10` (import), `:12-22` (REASONS), `:38` (add two instanceof checks before the `AuthError` check)

- [ ] **Step 1: Write the failing test**

Create `test/metrics/classify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../src/metrics/classify.js';
import {
    BlockedError,
    DomChangedError,
    AuthError,
    TimeoutError,
    NetworkError,
} from '../../src/core/errors.js';

test('BlockedError classifies as "blocked"', () => {
    assert.equal(classifyError(new BlockedError('cf', { kind: 'cloudflare' })), 'blocked');
});

test('DomChangedError classifies as "dom_changed"', () => {
    assert.equal(classifyError(new DomChangedError('no containers')), 'dom_changed');
});

test('existing mappings are unchanged', () => {
    assert.equal(classifyError(new AuthError('login failed')), 'auth_required');
    assert.equal(classifyError(new TimeoutError('timed out')), 'timeout');
    assert.equal(classifyError(new NetworkError('boom', { statusCode: 429 })), 'rate_limited');
    assert.equal(classifyError(new NetworkError('boom', { statusCode: 403 })), 'auth_required');
    assert.equal(classifyError(new Error('captcha challenge datadome')), 'captcha');
    assert.equal(classifyError(null), 'unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/metrics/classify.test.js`
Expected: FAIL — first test gets `'unknown'` (BlockedError matches no `instanceof`; its message "cf" matches no pattern) instead of `'blocked'`.

- [ ] **Step 3: Add reasons + import + instanceof checks in `src/metrics/classify.js`**

3a. Replace the import on line 10:

```js
import { AuthError, NetworkError, TimeoutError, ParseError, BrowserError, BlockedError, DomChangedError } from '../core/errors.js';
```

3b. In the `REASONS` object (lines 12–22), add two entries — replace the `REASONS` block with:

```js
const REASONS = Object.freeze({
    AUTH_REQUIRED: 'auth_required',
    CAPTCHA: 'captcha',
    BLOCKED: 'blocked',
    DOM_CHANGED: 'dom_changed',
    NETWORK: 'network',
    TIMEOUT: 'timeout',
    PARSE_ERROR: 'parse_error',
    RATE_LIMITED: 'rate_limited',
    BROWSER_CRASH: 'browser_crash',
    CREDENTIAL_MISSING: 'credential_missing',
    UNKNOWN: 'unknown',
});
```

3c. In `classifyError`, add the two checks immediately before the existing `if (error instanceof AuthError)` line (currently line 38). The block becomes:

```js
    if (error instanceof BlockedError) return REASONS.BLOCKED;
    if (error instanceof DomChangedError) return REASONS.DOM_CHANGED;
    if (error instanceof AuthError) return REASONS.AUTH_REQUIRED;
    if (error instanceof TimeoutError) return REASONS.TIMEOUT;
    if (error instanceof ParseError) return REASONS.PARSE_ERROR;
    if (error instanceof BrowserError) return REASONS.BROWSER_CRASH;
```

(Order matters: `BlockedError`/`DomChangedError` extend `ScraperError`, not `AuthError`, so they are independent — but checking them first keeps intent explicit and guarantees they never fall through to the regex tier.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/metrics/classify.test.js`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Run the full suite so far (no regressions)**

Run: `npm test`
Expected: all of `smoke`, `errors`, `classify` green; `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/metrics/classify.js test/metrics/classify.test.js
git commit -m "feat(classify): map BlockedError/DomChangedError to blocked/dom_changed (spec O2)

NOTE: src/metrics/registry.js scraper_failures_total label set and the
Grafana alert rules must learn 'blocked'/'dom_changed' in Plan 1B; this
commit is safe alone (prom-client does not restrict label values).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `detectBlock()` — pure structural detection (spec F3, F11)

**Files:**
- Test: `test/core/block-detection.test.js` (create)
- Create: `src/core/block-detection.js`

- [ ] **Step 1: Write the failing test**

Create `test/core/block-detection.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlock } from '../../src/core/block-detection.js';

test('clean results page is not blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.indeed.com/jobs?q=node&start=0',
        title: 'node jobs, Employment | Indeed.com',
        html: '<div class="job_seen_beacon">...</div>',
    });
    assert.equal(r.blocked, false);
    assert.equal(r.kind, null);
});

test('HTTP 403 is blocked (http_forbidden)', () => {
    const r = detectBlock({ status: 403, finalUrl: 'https://x', title: '' });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'http_forbidden');
});

test('HTTP 429 is blocked (rate_limited)', () => {
    const r = detectBlock({ status: 429, finalUrl: 'https://x', title: '' });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'rate_limited');
});

test('Cloudflare "Just a moment" interstitial is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.glassdoor.com/Job/jobs.htm',
        title: 'Just a moment...',
        html: '<div id="challenge-platform"></div>',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'cloudflare');
});

test('DataDome captcha marker is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.monster.com/jobs/search',
        title: 'monster',
        html: '<script src="https://geo.captcha-delivery.com/captcha/"></script>',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'datadome');
});

test('Indeed "Additional Verification Required" title is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.indeed.com/jobs?q=node',
        title: 'Additional Verification Required',
        html: '<body>Ray ID: 8a...</body>',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'challenge_page');
});

test('auth-wall URL fragment is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.linkedin.com/checkpoint/lg/login-submit',
        title: 'LinkedIn',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'auth_wall');
});

test('legit title containing the word "security" is NOT a false positive', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.dice.com/jobs?q=security+engineer',
        title: 'Security Engineer Jobs | Dice.com',
        html: '<div data-testid="job-search-results"></div>',
    });
    assert.equal(r.blocked, false);
});

test('legit job URL slug containing "challenge" is NOT blocked (segment-anchored fragment)', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.indeed.com/jobs/challenge-engineer-12345',
        title: 'Challenge Engineer Jobs | Indeed.com',
        html: '<div class="job_seen_beacon">role</div>',
    });
    assert.equal(r.blocked, false);
});

test('job page whose body merely mentions datadome/cloudflare is NOT blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.dice.com/job/12345',
        title: 'Security Engineer | Example',
        html: '<p>We use DataDome and Cloudflare to protect our API. Now hiring a security engineer.</p>',
    });
    assert.equal(r.blocked, false);
});
```

(The last two tests are false-positive regression guards: structural markers must not fire on legit job pages whose URL slug contains "challenge" or whose body merely mentions a vendor name. They drove tightening `'datadome'`→`'js.datadome.co'` and `/captcha|/challenge`→`/captcha/|/challenge/`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core/block-detection.test.js`
Expected: FAIL — cannot import `detectBlock` (module does not exist).

- [ ] **Step 3: Create `src/core/block-detection.js`**

```js
// Centralized block / challenge / interstitial detection.
//
// Spec F3 + F11: detection uses STRUCTURAL signals — HTTP status, final
// URL path, page <title>, and specific stable vendor markers — never
// fuzzy substring matching of arbitrary visible body text (the old
// probe's first-600-chars `.includes()` produced false pos/neg).
//
// Pure and side-effect free: callers collect page facts and pass them
// in, so this is trivially unit-testable and has no I/O.

import { BlockedError } from './errors.js';

// Vendor-specific tokens that only appear on challenge documents.
const CLOUDFLARE_MARKERS = [
    'cf-chl-', 'challenge-platform', 'cdn-cgi/challenge-platform',
    '__cf_chl', 'cf-browser-verification',
];
const DATADOME_MARKERS = [
    'captcha-delivery.com', 'geo.captcha-delivery', 'js.datadome.co', 'dd-captcha',
];

// URL path fragments meaning "not on a content page".
const BLOCK_URL_FRAGMENTS = [
    '/checkpoint/', '/authwall', '/uas/login', '/account/login',
    '/captcha/', '/challenge/',
];

// <title> phrases used by Cloudflare / DataDome / Indeed / generic WAFs.
const BLOCK_TITLE_RES = [
    /just a moment/i,
    /attention required/i,
    /access denied/i,
    /additional verification required/i,
    /verify you are (?:a )?human/i,
    /security check/i,
    /are you a robot/i,
];

function lowerHay(...parts) {
    return parts.filter(Boolean).join('  ').toLowerCase();
}

/**
 * @param {object} input
 * @param {number|null} [input.status]   main navigation HTTP status
 * @param {string|null} [input.finalUrl] URL after redirects
 * @param {string|null} [input.title]    document.title
 * @param {string|null} [input.bodyText] visible text (optional)
 * @param {string|null} [input.html]     raw HTML (optional)
 * @param {string|null} [input.platform] platform name (for thrown error)
 * @returns {{blocked: boolean, kind: string|null, signal: string|null}}
 */
export function detectBlock(input = {}) {
    const status = input.status ?? null;
    const finalUrl = input.finalUrl ?? '';
    const title = input.title ?? '';
    const markerHay = lowerHay(finalUrl, input.html, input.bodyText);

    if (status === 429) {
        return { blocked: true, kind: 'rate_limited', signal: `HTTP ${status}` };
    }
    if (status === 401 || status === 403) {
        return { blocked: true, kind: 'http_forbidden', signal: `HTTP ${status}` };
    }

    for (const m of DATADOME_MARKERS) {
        if (markerHay.includes(m)) {
            return { blocked: true, kind: 'datadome', signal: `datadome:${m}` };
        }
    }
    for (const m of CLOUDFLARE_MARKERS) {
        if (markerHay.includes(m)) {
            return { blocked: true, kind: 'cloudflare', signal: `cloudflare:${m}` };
        }
    }

    const urlLower = finalUrl.toLowerCase();
    for (const frag of BLOCK_URL_FRAGMENTS) {
        if (urlLower.includes(frag)) {
            return { blocked: true, kind: 'auth_wall', signal: `url:${frag}` };
        }
    }

    for (const re of BLOCK_TITLE_RES) {
        if (re.test(title)) {
            return {
                blocked: true,
                kind: 'challenge_page',
                signal: `title:${title.slice(0, 80)}`,
            };
        }
    }

    return { blocked: false, kind: null, signal: null };
}

/**
 * Throws BlockedError when detectBlock() reports a block; no-op otherwise.
 * @param {object} input same shape as detectBlock(input)
 */
export function assertNotBlocked(input = {}) {
    const r = detectBlock(input);
    if (r.blocked) {
        throw new BlockedError(
            `Blocked on ${input.platform ?? 'unknown'}: ${r.signal}`,
            { kind: r.kind, platform: input.platform ?? null },
        );
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/core/block-detection.test.js`
Expected: 10 tests pass (8 detection cases + 2 false-positive regression guards), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/core/block-detection.js test/core/block-detection.test.js
git commit -m "feat(core): add structural block/challenge detection (spec F3,F11)

Pure, side-effect-free; nothing imports it yet (wired per-scraper in
Plan 1C). Structural signals only — no fuzzy body-text matching.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `assertNotBlocked()` throws `BlockedError`

**Files:**
- Modify: `test/core/block-detection.test.js` (append)

(`assertNotBlocked` was implemented in Task 3; this task adds its tests so the throwing contract is locked.)

- [ ] **Step 1: Append failing tests**

Append to `test/core/block-detection.test.js`:

```js
import { assertNotBlocked } from '../../src/core/block-detection.js';
import { BlockedError } from '../../src/core/errors.js';

test('assertNotBlocked is a no-op on a clean page', () => {
    assert.doesNotThrow(() => assertNotBlocked({
        status: 200,
        finalUrl: 'https://www.indeed.com/jobs?q=node',
        title: 'node jobs | Indeed.com',
    }));
});

test('assertNotBlocked throws BlockedError with kind + platform', () => {
    try {
        assertNotBlocked({
            status: 403,
            finalUrl: 'https://www.indeed.com/jobs',
            title: '',
            platform: 'indeed',
        });
        assert.fail('expected assertNotBlocked to throw');
    } catch (err) {
        assert.ok(err instanceof BlockedError);
        assert.equal(err.code, 'BLOCKED');
        assert.equal(err.kind, 'http_forbidden');
        assert.equal(err.platform, 'indeed');
    }
});
```

- [ ] **Step 2: Run test to verify it passes (implementation already exists from Task 3)**

Run: `node --test test/core/block-detection.test.js`
Expected: `# pass 10`, `# fail 0`. (If the two new tests fail, fix `assertNotBlocked` in `src/core/block-detection.js` to match Task 3 Step 3 — do not weaken the tests.)

- [ ] **Step 3: Commit**

```bash
git add test/core/block-detection.test.js
git commit -m "test(core): lock assertNotBlocked throwing contract

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: BaseScraper normalized return contract + opt-in `strictEmpty` (spec F12 / C1 seam)

**Files:**
- Test: `test/core/base-scraper.test.js` (create)
- Modify: `src/core/base-scraper.js` — import (line 13), constructor (lines 18–26), `execute` (lines 38–67)

**Contract introduced (backward compatible):** a scraper function may return either
- an `Array` of jobs (today's behavior → treated as `emptyConfirmed: false`), or
- `{ jobs: Array, emptyConfirmed?: boolean }` (Plan 1C scrapers set `emptyConfirmed: true` only when they positively detect a real "no results" element).

Behavior when `jobs.length === 0`:
- `emptyConfirmed === true` → success, info log `confirmed empty` (legit no-results).
- `emptyConfirmed !== true` and **not** strict → **unchanged**: returns `[]`, records `success` (production behavior preserved), plus one `log.warn` with `scraper_alert: 'zero_jobs_unconfirmed'` and an optional `metrics.noteZeroJobs?.(platform)` (no-op until Plan 1B adds it).
- `emptyConfirmed !== true` and strict → throws `BlockedError` → existing catch path records `failed` + `recordFailure('blocked')`.

`strictEmpty` resolves from constructor option, else env `SCRAPER_STRICT_EMPTY === 'true'`, else `false`. `execute()` still returns the **array** (callers/orchestrator unchanged).

- [ ] **Step 1: Write the failing test**

Create `test/core/base-scraper.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';
import { BlockedError } from '../../src/core/errors.js';

function fakeMetrics() {
    const calls = { session: [], jobs: [], failure: [], zero: [] };
    return {
        calls,
        recordSession: (p, r, d) => calls.session.push([p, r, d]),
        recordJobsScraped: (p, n) => calls.jobs.push([p, n]),
        recordFailure: (p, reason) => calls.failure.push([p, reason]),
        noteZeroJobs: (p) => calls.zero.push([p]),
    };
}

test('non-empty array → success, returns the array', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('indeed', async () => [{ id: 1 }], { metrics: m });
    const out = await s.execute('node', 'remote', 'sess1');
    assert.deepEqual(out, [{ id: 1 }]);
    assert.equal(m.calls.session[0][1], 'success');
    assert.deepEqual(m.calls.jobs[0], ['indeed', 1]);
});

test('confirmed-empty object → success with 0, no zero-jobs alert', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('dice', async () => ({ jobs: [], emptyConfirmed: true }), { metrics: m });
    const out = await s.execute('node', 'remote', 'sess2');
    assert.deepEqual(out, []);
    assert.equal(m.calls.session[0][1], 'success');
    assert.equal(m.calls.zero.length, 0);
});

test('unconfirmed empty, non-strict → success preserved + zero-jobs noted', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('glassdoor', async () => [], { metrics: m, strictEmpty: false });
    const out = await s.execute('node', 'remote', 'sess3');
    assert.deepEqual(out, []);
    assert.equal(m.calls.session[0][1], 'success'); // production behavior unchanged
    assert.deepEqual(m.calls.zero[0], ['glassdoor']); // new observable seam
});

test('unconfirmed empty, strict → throws BlockedError, recorded failed/blocked', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('indeed', async () => [], { metrics: m, strictEmpty: true });
    await assert.rejects(() => s.execute('node', 'remote', 'sess4'), (err) => {
        assert.ok(err instanceof BlockedError);
        return true;
    });
    assert.equal(m.calls.session[0][1], 'failed');
    assert.deepEqual(m.calls.failure[0], ['indeed', 'blocked']);
});

test('thrown ScraperError still propagates and is recorded failed', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('techfetch', async () => { throw new BlockedError('cf', { kind: 'cloudflare' }); }, { metrics: m });
    await assert.rejects(() => s.execute('node', 'remote', 'sess5'), (err) => err instanceof BlockedError);
    assert.equal(m.calls.session[0][1], 'failed');
    assert.deepEqual(m.calls.failure[0], ['techfetch', 'blocked']);
});

test('legacy two-arg constructor still works (backward compat)', () => {
    const s = new BaseScraper('monster', async () => []);
    assert.equal(s.platform, 'monster');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/core/base-scraper.test.js`
Expected: FAIL — constructor ignores `options`, no `noteZeroJobs`/`strictEmpty` handling; `unconfirmed empty, strict` test does not throw.

- [ ] **Step 3: Rewrite `src/core/base-scraper.js`**

Replace the entire file with:

```js
// BaseScraper — thin lifecycle wrapper shared by every platform scraper.
//
// Wraps the platform scraper function with:
//   • scoped logging (start, finish, duration)
//   • structured error normalization (any throw becomes ScraperError)
//   • a normalized return contract so "0 jobs" is no longer silently
//     assumed to be success (spec F12 / C1 seam)
//
// Return contract (backward compatible): the scraper function may return
//   - an Array of jobs (legacy; treated as emptyConfirmed:false), or
//   - { jobs: Array, emptyConfirmed?: boolean }
// `emptyConfirmed` must be set true ONLY when the scraper positively
// confirmed a real empty result set (Plan 1C). Default production
// behavior is unchanged: unconfirmed-empty still returns [] and records
// success unless opt-in strict mode is enabled.

import { createLogger } from '../logger/index.js';
import { ScraperError, BlockedError } from './errors.js';
import { getMetrics } from '../metrics/registry.js';
import { classifyError } from '../metrics/classify.js';

function normalizeResult(result) {
    if (Array.isArray(result)) {
        return { jobs: result, emptyConfirmed: false };
    }
    if (result && Array.isArray(result.jobs)) {
        return { jobs: result.jobs, emptyConfirmed: result.emptyConfirmed === true };
    }
    return { jobs: [], emptyConfirmed: false };
}

export class BaseScraper {
    constructor(platform, scraperFn, options = {}) {
        if (!platform) throw new Error('BaseScraper requires a platform name');
        if (typeof scraperFn !== 'function') {
            throw new Error(`BaseScraper(${platform}) requires a scraper function`);
        }
        this.platform = platform;
        this.scraperFn = scraperFn;
        this.log = createLogger(platform);
        this._metrics = options.metrics ?? null;
        this.strictEmpty = options.strictEmpty
            ?? (process.env.SCRAPER_STRICT_EMPTY === 'true');
    }

    /**
     * @param {string} jobTitle
     * @param {string} location
     * @param {string|null} sessionId
     * @param {{searchQueries?: string[] | null}} [options]
     * @returns {Promise<Array<object>>}
     */
    async execute(jobTitle, location, sessionId = null, options = {}) {
        const start = Date.now();
        const metrics = this._metrics ?? getMetrics();
        this.log.info('Starting scrape', { jobTitle, location, sessionId });
        try {
            const raw = await this.scraperFn(jobTitle, location, sessionId, options);
            const { jobs, emptyConfirmed } = normalizeResult(raw);
            const durationMs = Date.now() - start;
            const jobCount = jobs.length;

            if (jobCount === 0 && !emptyConfirmed) {
                this.log.warn('Scrape returned 0 jobs (unconfirmed) — possible block / DOM change', {
                    durationMs,
                    scraper_alert: 'zero_jobs_unconfirmed',
                });
                metrics.noteZeroJobs?.(this.platform);
                if (this.strictEmpty) {
                    throw new BlockedError(
                        'Scrape returned 0 jobs with no confirmed-empty signal — suspected block / DOM change',
                        { platform: this.platform, kind: null },
                    );
                }
            } else if (jobCount === 0) {
                this.log.info('Scrape complete (confirmed empty)', { jobCount: 0, durationMs });
            } else {
                this.log.info('Scrape complete', { jobCount, durationMs });
            }

            metrics.recordSession(this.platform, 'success', durationMs);
            metrics.recordJobsScraped(this.platform, jobCount);
            return jobs;
        } catch (error) {
            const durationMs = Date.now() - start;
            const reason = classifyError(error);
            this.log.error('Scrape failed', {
                err: error?.message ?? 'unknown',
                reason,
                durationMs,
                scraper_alert:
                    reason === 'auth_required' ? 'auth_required'
                    : reason === 'blocked' ? 'blocked'
                    : undefined,
            });
            metrics.recordSession(this.platform, 'failed', durationMs);
            metrics.recordFailure(this.platform, reason);
            if (error instanceof ScraperError) throw error;
            throw new ScraperError(error?.message ?? 'Scraper failed', {
                platform: this.platform,
                cause: error,
            });
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/core/base-scraper.test.js`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/core/base-scraper.js test/core/base-scraper.test.js
git commit -m "feat(base-scraper): normalized return contract + opt-in strictEmpty (spec F12,C1 seam)

Default prod behavior unchanged (unconfirmed-empty still returns [] and
records success); adds a zero-jobs warn signal + noteZeroJobs?() seam.
Behavioral flip is opt-in via strictEmpty / SCRAPER_STRICT_EMPTY, wired
per-scraper in Plan 1C and surfaced as a metric in Plan 1B.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Production-safety verification + handoff note

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-phase1a-NOTES.md`

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: every test file green; final summary `fail 0` (Node 24 prints `ℹ fail 0`). Record the pass count.

- [ ] **Step 2: Verify zero default behavior change — static checks**

Run: `git grep -n "noteZeroJobs\|strictEmpty\|SCRAPER_STRICT_EMPTY\|assertNotBlocked\|detectBlock\|BlockedError\|DomChangedError" -- src/ ':!src/core/errors.js' ':!src/core/base-scraper.js' ':!src/core/block-detection.js' ':!src/metrics/classify.js'`
Expected: **no output** (no scraper or pipeline file references the new symbols yet — confirms Plan 1A is inert in production until 1B/1C).

- [ ] **Step 3: Verify the new error reasons are not yet referenced by metrics/alerts**

Run: `git grep -n "'blocked'\|'dom_changed'\|noteZeroJobs" -- src/metrics/registry.js`
Expected: **no output** (registry changes are Plan 1B; classifier returning these values is safe with prom-client, documented in Task 2 commit).

- [ ] **Step 4: Confirm `git status` is clean and the branch builds**

Run: `node -e "import('./src/core/base-scraper.js').then(()=>import('./src/core/block-detection.js')).then(()=>import('./src/metrics/classify.js')).then(()=>console.log('imports OK'))"`
Expected: prints `imports OK` (no import/syntax errors anywhere in the modified module graph).

- [ ] **Step 5: Write the handoff note**

Create `docs/superpowers/plans/2026-05-18-phase1a-NOTES.md`:

```markdown
# Phase 1A — completion notes

Status: COMPLETE. All tests green (`npm test`).

Delivered (pure additions / backward-compatible):
- BlockedError, DomChangedError (src/core/errors.js)
- classify.js maps them → 'blocked' / 'dom_changed'
- src/core/block-detection.js: detectBlock() + assertNotBlocked() (structural, pure, unit-tested)
- base-scraper.js: normalized return contract + opt-in strictEmpty + noteZeroJobs?() seam
- Node built-in test harness (npm test), no new deps

Production impact: NONE by default. Only new runtime effect is one
extra log.warn line on a 0-job scrape. Behavioral flip is gated behind
strictEmpty / SCRAPER_STRICT_EMPTY (default off).

Required next (do NOT enable strictEmpty in prod until both land):
- Plan 1B: src/metrics/registry.js — add noteZeroJobs(), the
  scraper_jobs_last_scraped gauge, scraper_zero_result_sessions_total,
  result="empty"/"blocked" labels, 'blocked'/'dom_changed' in the
  failures label set; orchestrator C1/C3/O9; commit alert rules +
  dashboard; SCRAPER_MODE=daemon in runbooks.
- Plan 1C: each scraper calls assertNotBlocked() at nav/pre-parse
  points and returns { jobs, emptyConfirmed:true } only on a positively
  confirmed empty result set; fix Indeed loginSuccess timing (I13),
  Indeed page-1 pagination (I2), Glassdoor early-abort (I14),
  LinkedIn mid-scrape detection (L2). THEN enable SCRAPER_STRICT_EMPTY.
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-05-18-phase1a-NOTES.md
git commit -m "docs(plan): Phase 1A completion + 1B/1C handoff notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Phase 1A subset):**
- F8 (BlockedError/DomChangedError) → Task 1 ✓
- O2 classifier half (map new errors → reasons) → Task 2 ✓
- F3 (centralized block detection) → Task 3 (`detectBlock`/`assertNotBlocked`) ✓
- F11 (structural, not fuzzy-substring) → Task 3 design + the "security" false-positive test ✓
- F12 / C1 seam (0 jobs ≠ automatic success) → Task 5 (normalized contract + strict mode) ✓
- Remaining Phase 1 findings (L1, L2, T1, T4, T9, T15, I1, I2, I3, I13, I14, O1, O3, O4, O5, O9, O10, C3) are explicitly **out of scope for 1A** and assigned to Plan 1B/1C in the header and Task 6 notes — not gaps, deferred by design.

**2. Placeholder scan:** No "TBD/TODO/handle appropriately". Every code step contains complete, runnable code; every run step has an exact command + expected output.

**3. Type/name consistency:** `BlockedError({kind})`, `DomChangedError`, `detectBlock(input){blocked,kind,signal}`, `assertNotBlocked(input)`, `normalizeResult`→`{jobs,emptyConfirmed}`, `metrics.noteZeroJobs?.(platform)`, constructor `options.metrics`/`options.strictEmpty`, env `SCRAPER_STRICT_EMPTY` — names are identical across Tasks 1–6 and match the test files. `classifyError` returns `'blocked'`/`'dom_changed'` consistently with the Task 5 `scraper_alert` mapping.

**4. Scope:** Single cohesive subsystem (detection toolbox + contract). Produces working, fully-tested software on its own. Inert in production until 1B/1C — consistent with the spec's "Phase 1 = detection-only, near-zero behavior change, cautious on a live system" constraint.

No issues found requiring rework.
