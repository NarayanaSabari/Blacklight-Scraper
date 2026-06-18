# Server-side Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the running scraper observable from outside the process (boot SHA log, `/healthz`, URL-quality metric), tighten the setup wizard, document the mandatory restart-after-pull rule, and give supervisors a structured exit-code signal — all without touching `scrapers/linkedin.js`.

**Architecture:** Five focused additive surfaces — a `resolveBootInfo()` helper feeding structured boot logs and `/healthz`, a `classifyUrl()` helper instrumented at the `BaseScraper.execute()` seam (so every platform participates without per-scraper edits), a wizard banner that demands `npm run linkedin:login` before claiming success, two doc callouts, and an `exitCodeFor()` map plumbed into `server.js` shutdown so supervisors can distinguish recoverable from fatal exits. All new code is pure-helper-with-thin-wiring so TDD is straightforward.

**Tech Stack:** Node 24, ESM, `node:test`, `node --test 'test/**/*.test.js'` (quoted glob — bare-dir broken on Node 24 per repo convention), `prom-client`, Express. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-03-server-robustness-design.md`

---

## Constraints (read before starting)

1. **`scrapers/linkedin.js` MUST NOT be modified.** Reading its exports is fine; editing it is out of scope. `linkedInProfileDir()` is imported from there in Task 1 — that's the only file-level coupling.
2. **No new dependencies.** Use `child_process.execSync`, `node:fs`, Express built-ins. Do not add `supertest` etc.
3. **Tests:** every new pure helper gets a dedicated `*.test.js` under `test/`. Route handlers are tested by calling the registered handler with stub `req`/`res` (no listening port). Wizard tests follow the existing injected-`out` pattern in `test/setup/wizard.test.js`.
4. **Run tests via the repo's existing script:** `npm test` → expands to `node --test 'test/**/*.test.js'`. Per `MEMORY.md`, the bare-dir form is broken on Node 24; always use the quoted glob.
5. **Pre-existing dirty files MUST stay unstaged in every commit:** `.gitignore`, `pnpm-lock.yaml`. Stage files by name; never `git add .` / `git add -A`.
6. **Co-author trailer on every commit:** `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` (preserve repo convention).
7. **Never echo secrets.** No API keys, no cookie values, no passwords in any new log line.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/config/boot-info.js` | **new** | Pure `resolveBootInfo({env, execSync, readFile, profileDir})` returning the boot identity object |
| `src/core/url-quality.js` | **new** | Pure `classifyUrl(url)` → `'permalink'` \| `'profile_in'` \| `'empty'` \| `'other'` |
| `src/metrics/registry.js` | **modify** | Add `scraper_url_quality_total` counter, `recordUrlQuality()` helper, extend `scraper_build_info` labels + new `recordBuildInfo()` helper |
| `src/core/base-scraper.js` | **modify** | After `normalizeResult`, iterate `jobs` and call `metrics.recordUrlQuality(platform, classifyUrl(job.url))` |
| `server.js` | **modify** | Resolve boot info once, structured boot logs, `recordBuildInfo`, wire `/healthz` deps, install `uncaughtException`/`unhandledRejection` handlers, exit-code-aware shutdown |
| `src/routes/health.js` | **modify** | Accept `{bootInfo, getLinkedInSession}` deps; add `GET /healthz` (cheap) + `GET /health/linkedin?probe=1` (real probe) |
| `src/setup/wizard.js` | **modify** | After successful write, print bolded `npm run linkedin:login` banner + profile-dir hint |
| `src/setup/verify.js` | **modify** | `verifyRemote` requires JSON content-type and at least one expected key |
| `src/server/exit-codes.js` | **new** | Pure `exitCodeFor(reason)` map: `signal→0`, `auth-dead→2`, `lease-starved→3`, `crash→42`, default→1 |
| `docs/MAC_SETUP.md` | **modify** | Bolded restart-after-pull callout above the update recipe; soften hot-reload paragraph |
| `docs/WINDOWS_SETUP.md` | **modify** | Same as Mac (per-platform commands) |
| `README.md` | **modify** | "After updating" subsection + exit-code table |
| `test/config/boot-info.test.js` | **new** | Unit tests for `resolveBootInfo` |
| `test/core/url-quality.test.js` | **new** | Unit tests for `classifyUrl` |
| `test/metrics/url-quality-metric.test.js` | **new** | Unit tests for `recordUrlQuality` / `recordBuildInfo` |
| `test/core/base-scraper-url-quality.test.js` | **new** | BaseScraper wiring test |
| `test/routes/healthz.test.js` | **new** | Handler-level test for `/healthz` |
| `test/routes/health-linkedin-probe.test.js` | **new** | Handler-level test for `/health/linkedin?probe=1` |
| `test/setup/wizard-linkedin-login-banner.test.js` | **new** | Asserts banner appears on the success path, not on cancel |
| `test/setup/verify-remote-strict.test.js` | **new** | `verifyRemote` rejects non-JSON / wrong schema |
| `test/server/exit-codes.test.js` | **new** | Unit tests for `exitCodeFor` |

---

## Task 1: Boot-info resolver helper

**Files:**
- Create: `src/config/boot-info.js`
- Test: `test/config/boot-info.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/config/boot-info.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBootInfo } from '../../src/config/boot-info.js';

const fixedDeps = (overrides = {}) => ({
    env: { LINKEDIN_HEADLESS: 'false', SCRAPER_STRICT_EMPTY: 'false' },
    execSync: () => Buffer.from('abc1234\n'),
    readPkg: () => ({ version: '2.0.0' }),
    profileDir: () => '/tmp/linkedin-profile',
    now: () => new Date('2026-06-03T12:34:56.000Z'),
    nodeVersion: 'v24.5.0',
    pid: 4242,
    ...overrides,
});

test('resolveBootInfo: returns the boot identity fields', () => {
    const info = resolveBootInfo(fixedDeps());
    assert.equal(info.pid, 4242);
    assert.equal(info.gitSha, 'abc1234');
    assert.equal(info.bootedAt, '2026-06-03T12:34:56.000Z');
    assert.equal(info.nodeVersion, 'v24.5.0');
    assert.equal(info.pkgVersion, '2.0.0');
    assert.equal(info.profileDir, '/tmp/linkedin-profile');
    assert.equal(info.headless, false);
    assert.equal(info.strict, false);
});

test('resolveBootInfo: GIT_SHA env wins over `git rev-parse`', () => {
    const info = resolveBootInfo(fixedDeps({
        env: { GIT_SHA: 'deadbeef', LINKEDIN_HEADLESS: 'true', SCRAPER_STRICT_EMPTY: 'true' },
        execSync: () => { throw new Error('must not be called'); },
    }));
    assert.equal(info.gitSha, 'deadbeef');
    assert.equal(info.headless, true);
    assert.equal(info.strict, true);
});

test('resolveBootInfo: missing git falls back to "unknown"', () => {
    const info = resolveBootInfo(fixedDeps({
        env: {},
        execSync: () => { throw new Error('git not found'); },
    }));
    assert.equal(info.gitSha, 'unknown');
});

test('resolveBootInfo: trims trailing whitespace from git output', () => {
    const info = resolveBootInfo(fixedDeps({ execSync: () => Buffer.from('   ff00aa1\n\n') }));
    assert.equal(info.gitSha, 'ff00aa1');
});

test('resolveBootInfo: headless/strict default false when env unset', () => {
    const info = resolveBootInfo(fixedDeps({ env: {} }));
    assert.equal(info.headless, false);
    assert.equal(info.strict, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/config/boot-info.test.js'`
Expected: FAIL with `Cannot find module 'src/config/boot-info.js'` (or "resolveBootInfo is not a function").

- [ ] **Step 3: Write minimal implementation**

Create `src/config/boot-info.js`:

```js
// Resolves the immutable boot identity for this process. Pure given its deps.
// Used by server.js to stamp every boot log, by /healthz to surface state,
// and by scraper_build_info to label metrics by SHA.

import { execSync as realExecSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function defaultReadPkg(cwd = process.cwd()) {
    return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
}

// NB: this module deliberately does NOT import from scrapers/linkedin.js.
// Callers (server.js) inject `profileDir: () => linkedInProfileDir()`.
// The default is a sentinel so unit tests don't need a real profile path.

export function resolveBootInfo(deps = {}) {
    const env = deps.env ?? process.env;
    const execSync = deps.execSync ?? realExecSync;
    const readPkg = deps.readPkg ?? defaultReadPkg;
    const profileDir = deps.profileDir ?? (() => 'unknown');
    const now = deps.now ?? (() => new Date());
    const nodeVersion = deps.nodeVersion ?? process.version;
    const pid = deps.pid ?? process.pid;

    let gitSha;
    if (env.GIT_SHA) {
        gitSha = String(env.GIT_SHA).trim();
    } else {
        try {
            const out = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] });
            gitSha = String(out).trim();
        } catch {
            gitSha = 'unknown';
        }
    }

    let pkgVersion = '0.0.0';
    try { pkgVersion = readPkg().version || pkgVersion; } catch { /* keep default */ }

    return {
        pid,
        gitSha,
        bootedAt: now().toISOString(),
        nodeVersion,
        pkgVersion,
        profileDir: profileDir(),
        headless: env.LINKEDIN_HEADLESS === 'true',
        strict: env.SCRAPER_STRICT_EMPTY === 'true',
    };
}
```

Note: `defaultProfileDir` is exported only via the `deps.profileDir` injection point. The default path is a sync `() => 'unknown'` so this module never reaches into `scrapers/linkedin.js` at import time. The caller in `server.js` will pass an injected `profileDir` that wraps `linkedInProfileDir()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/config/boot-info.test.js'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/boot-info.js test/config/boot-info.test.js
git commit -m "$(cat <<'EOF'
feat(config): add resolveBootInfo() helper

Pure dep-injected helper returning {pid, gitSha, bootedAt, nodeVersion,
pkgVersion, profileDir, headless, strict}. Used in subsequent tasks to
stamp boot logs, populate /healthz, and label scraper_build_info.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: URL-quality classifier helper

**Files:**
- Create: `src/core/url-quality.js`
- Test: `test/core/url-quality.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/core/url-quality.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from '../../src/core/url-quality.js';

test('classifyUrl: empty / null / undefined → "empty"', () => {
    assert.equal(classifyUrl(''), 'empty');
    assert.equal(classifyUrl(null), 'empty');
    assert.equal(classifyUrl(undefined), 'empty');
});

test('classifyUrl: LinkedIn profile /in/ → "profile_in"', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/in/john-doe'), 'profile_in');
    assert.equal(classifyUrl('https://linkedin.com/in/anyone/'), 'profile_in');
});

test('classifyUrl: LinkedIn feed/update permalink → "permalink"', () => {
    assert.equal(
        classifyUrl('https://www.linkedin.com/feed/update/urn:li:activity:7462490743035731968/'),
        'permalink',
    );
});

test('classifyUrl: LinkedIn /posts/ permalink → "permalink"', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/posts/abc-123/'), 'permalink');
});

test('classifyUrl: Indeed/Dice job pages → "permalink"', () => {
    assert.equal(classifyUrl('https://www.indeed.com/jobs/view/12345'), 'permalink');
});

test('classifyUrl: other valid URLs → "other"', () => {
    assert.equal(classifyUrl('https://example.com/foo'), 'other');
    assert.equal(classifyUrl('https://www.linkedin.com/company/acme'), 'other');
});

test('classifyUrl: non-string coerces safely', () => {
    assert.equal(classifyUrl(42), 'other');
    assert.equal(classifyUrl({}), 'other');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/core/url-quality.test.js'`
Expected: FAIL with "Cannot find module" or "classifyUrl is not a function".

- [ ] **Step 3: Write minimal implementation**

Create `src/core/url-quality.js`:

```js
// Classifies an outbound job URL at the BaseScraper output seam. Mirrors
// scrapers/linkedin.js::postSourceUrl's "/in/ is never a job URL" rule, with
// a generic permalink pattern that also matches Indeed/Dice job pages.

const PERMALINK_RE = /\/feed\/update\/|\/posts\/|\/jobs\/view\/|\/jobs?\/[a-z0-9-]+\/?$/i;

export function classifyUrl(url) {
    if (url === null || url === undefined || url === '') return 'empty';
    const s = String(url);
    if (!s) return 'empty';
    if (s.includes('/in/')) return 'profile_in';
    if (PERMALINK_RE.test(s)) return 'permalink';
    return 'other';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/core/url-quality.test.js'`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/url-quality.js test/core/url-quality.test.js
git commit -m "$(cat <<'EOF'
feat(core): add classifyUrl() — pure URL quality classifier

Returns 'permalink' | 'profile_in' | 'empty' | 'other' for any job URL.
Used at the BaseScraper output seam so every platform participates in
URL-quality metrics without per-scraper edits.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: URL-quality + build-info metrics

**Files:**
- Modify: `src/metrics/registry.js` (add counter inside `buildCollectors`, add helpers on the class)
- Test: `test/metrics/url-quality-metric.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/metrics/url-quality-metric.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMetrics, resetMetricsForTest } from '../../src/metrics/registry.js';

beforeEach(() => resetMetricsForTest());

test('recordUrlQuality: increments the counter with platform + quality labels', async () => {
    const m = getMetrics();
    m.recordUrlQuality('linkedin', 'permalink');
    m.recordUrlQuality('linkedin', 'permalink');
    m.recordUrlQuality('linkedin', 'empty');
    m.recordUrlQuality('indeed', 'permalink');
    const text = await m.snapshot();
    assert.match(text, /scraper_url_quality_total\{[^}]*platform="linkedin"[^}]*quality="permalink"[^}]*\} 2/);
    assert.match(text, /scraper_url_quality_total\{[^}]*platform="linkedin"[^}]*quality="empty"[^}]*\} 1/);
    assert.match(text, /scraper_url_quality_total\{[^}]*platform="indeed"[^}]*quality="permalink"[^}]*\} 1/);
});

test('recordUrlQuality: bad label values do not throw (safety wrap)', () => {
    const m = getMetrics();
    assert.doesNotThrow(() => m.recordUrlQuality(undefined, undefined));
});

test('recordBuildInfo: sets the gauge with all label tuple values', async () => {
    const m = getMetrics();
    m.recordBuildInfo({
        nodeVersion: 'v24.5.0', gitSha: 'abc1234', pkgVersion: '2.0.0',
        headless: false, strict: true,
    });
    const text = await m.snapshot();
    assert.match(
        text,
        /scraper_build_info\{[^}]*node_version="v24\.5\.0"[^}]*git_sha="abc1234"[^}]*pkg_version="2\.0\.0"[^}]*headless="false"[^}]*strict="true"[^}]*\} 1/,
    );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/metrics/url-quality-metric.test.js'`
Expected: FAIL with `m.recordUrlQuality is not a function` (and `m.recordBuildInfo is not a function`).

- [ ] **Step 3: Write minimal implementation**

In `src/metrics/registry.js`:

(a) Replace the existing `this.buildInfo` block (the gauge construction and the `.labels(process.version).set(1)` call near line 92–99) with:

```js
        this.buildInfo = new Gauge({
            name: 'scraper_build_info',
            help: 'Build info; always 1. Useful for joining by version/sha/headless/strict labels.',
            labelNames: ['node_version', 'git_sha', 'pkg_version', 'headless', 'strict'],
            registers: reg,
        });
        // Sentinel default so the gauge has a value before server.js calls
        // recordBuildInfo() with the real labels. Replaced at boot.
        this.buildInfo.labels(process.version, 'unknown', '0.0.0', 'false', 'false').set(1);
```

(b) Add the new counter inside `buildCollectors` (place near the existing `jobsScrapedTotal`):

```js
        this.urlQualityTotal = new Counter({
            name: 'scraper_url_quality_total',
            help: 'Job URLs emitted by scrapers, classified at the BaseScraper output seam (quality = permalink|profile_in|empty|other).',
            labelNames: ['platform', 'quality'],
            registers: reg,
        });
```

(c) Add the helpers on the class (place near `recordJobsSubmitted`):

```js
    recordUrlQuality(platform, quality) {
        this.#safe(() => this.urlQualityTotal.labels(platform ?? 'unknown', quality ?? 'unknown').inc());
    }

    recordBuildInfo(info) {
        this.#safe(() => {
            // Reset to drop the boot-time sentinel.
            this.buildInfo.reset();
            this.buildInfo.labels(
                String(info.nodeVersion ?? 'unknown'),
                String(info.gitSha ?? 'unknown'),
                String(info.pkgVersion ?? '0.0.0'),
                String(!!info.headless),
                String(!!info.strict),
            ).set(1);
        });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/metrics/url-quality-metric.test.js'`
Expected: PASS (3 tests). Also run the full suite to confirm no regressions:
`node --test 'test/**/*.test.js'`
Expected: all green (the existing `test/metrics/registry.test.js` continues to pass because the build-info label-name change is observable but the existing assertions don't pin the exact label tuple — verify this; if any assertion breaks, update it to match the new tuple in the same commit).

- [ ] **Step 5: Commit**

```bash
git add src/metrics/registry.js test/metrics/url-quality-metric.test.js
# If test/metrics/registry.test.js was touched to match the new build-info tuple, include it.
git commit -m "$(cat <<'EOF'
feat(metrics): add scraper_url_quality_total + extend scraper_build_info labels

- scraper_url_quality_total{platform,quality} surfaces URL-quality drift
  (empty/profile_in/other) without depending on per-scraper instrumentation.
- scraper_build_info now carries {node_version, git_sha, pkg_version,
  headless, strict} so dashboards can group by running SHA.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: BaseScraper wires URL-quality at the output seam

**Files:**
- Modify: `src/core/base-scraper.js` (inside `execute`, after `normalizeResult`)
- Test: `test/core/base-scraper-url-quality.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/core/base-scraper-url-quality.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';

function fakeMetrics() {
    const calls = [];
    return {
        recordSession() {},
        recordJobsScraped() {},
        recordFailure() {},
        noteZeroJobs() {},
        recordUrlQuality(platform, quality) { calls.push([platform, quality]); },
        _calls: calls,
    };
}

test('BaseScraper.execute: emits one url-quality sample per job', async () => {
    const metrics = fakeMetrics();
    const scraper = new BaseScraper('linkedin', async () => ([
        { url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' },
        { url: 'https://www.linkedin.com/in/someone' },
        { url: '' },
    ]), { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(metrics._calls, [
        ['linkedin', 'permalink'],
        ['linkedin', 'profile_in'],
        ['linkedin', 'empty'],
    ]);
});

test('BaseScraper.execute: emits nothing on a zero-jobs result', async () => {
    const metrics = fakeMetrics();
    const scraper = new BaseScraper('indeed', async () => ([]), { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(metrics._calls, []);
});

test('BaseScraper.execute: still emits when scraper returns {jobs} shape', async () => {
    const metrics = fakeMetrics();
    const scraper = new BaseScraper('linkedin', async () => ({
        jobs: [{ url: 'https://www.indeed.com/jobs/view/42' }],
        emptyConfirmed: false,
    }), { metrics });
    await scraper.execute('SRE', 'US', 'session-1');
    assert.deepEqual(metrics._calls, [['linkedin', 'permalink']]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/core/base-scraper-url-quality.test.js'`
Expected: FAIL — the existing `BaseScraper.execute` never calls `recordUrlQuality`, so `metrics._calls` stays `[]`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/base-scraper.js`:

(a) Add to the import block at the top:

```js
import { classifyUrl } from './url-quality.js';
```

(b) Inside `execute(...)` after the `const { jobs, emptyConfirmed } = normalizeResult(raw);` line and before the `jobCount === 0` branch, add:

```js
            try {
                for (const job of jobs) {
                    metrics.recordUrlQuality?.(this.platform, classifyUrl(job?.url));
                }
            } catch (_e) {
                // Observability must never crash the scraping path.
            }
```

(The optional-chained call defends against test stubs that supply a metrics object missing `recordUrlQuality`; the try/catch is the second belt.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/core/base-scraper-url-quality.test.js'`
Expected: PASS (3 tests). Also run `node --test 'test/core/base-scraper*.test.js'` and confirm the existing `base-scraper.test.js` and `base-scraper-metrics.test.js` still pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/base-scraper.js test/core/base-scraper-url-quality.test.js
git commit -m "$(cat <<'EOF'
feat(core): instrument URL-quality at the BaseScraper output seam

Every job emitted by any platform scraper now contributes one sample to
scraper_url_quality_total{platform, quality}. classifyUrl drives the
labels — empty/profile_in/permalink/other. No per-scraper edits needed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Exit-code helper

**Files:**
- Create: `src/server/exit-codes.js`
- Test: `test/server/exit-codes.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/server/exit-codes.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor, EXIT_REASONS } from '../../src/server/exit-codes.js';

test('exitCodeFor: signal → 0 (clean)', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.SIGNAL), 0);
    assert.equal(exitCodeFor('signal'), 0);
});

test('exitCodeFor: auth-dead → 2', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.AUTH_DEAD), 2);
});

test('exitCodeFor: lease-starved → 3', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.LEASE_STARVED), 3);
});

test('exitCodeFor: crash → 42', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.CRASH), 42);
});

test('exitCodeFor: unknown reason → 1', () => {
    assert.equal(exitCodeFor('nope'), 1);
    assert.equal(exitCodeFor(undefined), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/server/exit-codes.test.js'`
Expected: FAIL — `Cannot find module 'src/server/exit-codes.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/exit-codes.js`:

```js
// Process-exit codes. Wired into server.js shutdown so supervisors
// (launchctl, NSSM, pm2) can distinguish recoverable from fatal exits.
//   0  signal        clean SIGINT/SIGTERM; supervisors should restart per policy
//   2  auth-dead     LinkedIn session unrecoverable (cookies dead, no fallback) — page humans
//   3  lease-starved scraper credential pool empty for N consecutive polls — back off, retry later
//   42 crash         uncaught exception / unhandled rejection — supervisor restart
//   1  unknown       any other reason; treat as crash by default

export const EXIT_REASONS = Object.freeze({
    SIGNAL: 'signal',
    AUTH_DEAD: 'auth-dead',
    LEASE_STARVED: 'lease-starved',
    CRASH: 'crash',
});

const CODES = Object.freeze({
    [EXIT_REASONS.SIGNAL]: 0,
    [EXIT_REASONS.AUTH_DEAD]: 2,
    [EXIT_REASONS.LEASE_STARVED]: 3,
    [EXIT_REASONS.CRASH]: 42,
});

export function exitCodeFor(reason) {
    return Object.prototype.hasOwnProperty.call(CODES, reason) ? CODES[reason] : 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/server/exit-codes.test.js'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/exit-codes.js test/server/exit-codes.test.js
git commit -m "$(cat <<'EOF'
feat(server): add exitCodeFor() + EXIT_REASONS

Pure map letting supervisors distinguish clean exits, dead auth, starved
lease pool, and crashes via process exit code. Wired into server.js
shutdown in a later task.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `/healthz` route (cheap)

**Files:**
- Modify: `src/routes/health.js` (extend `registerHealthRoute` to accept deps and mount `/healthz`)
- Test: `test/routes/healthz.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/routes/healthz.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerHealthRoute } from '../../src/routes/health.js';

function inject(deps) {
    const app = express();
    registerHealthRoute(app, 3001, deps);
    return app;
}

function callHandler(app, method, urlPath) {
    return new Promise((resolve) => {
        const req = { method, url: urlPath, query: {}, headers: {} };
        // Express parses ?probe=1 into req.query; emulate that for /health/linkedin tests later.
        const url = new URL(urlPath, 'http://localhost');
        req.path = url.pathname;
        req.query = Object.fromEntries(url.searchParams);
        const chunks = [];
        const res = {
            statusCode: 200,
            _headers: {},
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(o) { chunks.push(JSON.stringify(o)); resolve({ status: this.statusCode, body: JSON.parse(chunks[0]) }); return this; },
            end() { resolve({ status: this.statusCode, body: null }); },
        };
        app.handle(req, res, () => resolve({ status: 404, body: null }));
    });
}

const bootInfo = {
    pid: 4242, gitSha: 'abc1234', bootedAt: '2026-06-03T00:00:00.000Z',
    nodeVersion: 'v24.5.0', pkgVersion: '2.0.0',
    profileDir: '/tmp/li-profile', headless: false, strict: false,
};

test('GET /healthz: returns bootInfo + session state + uptime', async () => {
    const session = { isAlive: () => true, lease: { credential: { id: 'cred-7' } } };
    const app = inject({ bootInfo, getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, 'GET', '/healthz');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.gitSha, 'abc1234');
    assert.equal(body.profileDir, '/tmp/li-profile');
    assert.equal(body.sessionAlive, true);
    assert.equal(body.leaseCredentialId, 'cred-7');
    assert.equal(body.headless, false);
    assert.equal(typeof body.uptimeSec, 'number');
});

test('GET /healthz: handles dead session + no lease', async () => {
    const session = { isAlive: () => false, lease: null };
    const app = inject({ bootInfo, getLinkedInSession: () => session });
    const { body } = await callHandler(app, 'GET', '/healthz');
    assert.equal(body.sessionAlive, false);
    assert.equal(body.leaseCredentialId, null);
});

test('GET /: legacy welcome route still works', async () => {
    const app = inject({ bootInfo, getLinkedInSession: () => ({ isAlive: () => true, lease: null }) });
    const { status, body } = await callHandler(app, 'GET', '/');
    assert.equal(status, 200);
    assert.equal(body.status, 'Unified Job Scraper API is running');
    // gitSha is now surfaced on / too:
    assert.equal(body.gitSha, 'abc1234');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/routes/healthz.test.js'`
Expected: FAIL — `registerHealthRoute` does not accept deps, no `/healthz`, no `gitSha` on `/`.

- [ ] **Step 3: Write minimal implementation**

In `src/routes/health.js`, replace the file with:

```js
// GET / (welcome), GET /healthz (cheap state), GET /health/linkedin?probe=1
// (real session probe — wired in a later task).

import { existsSync } from 'node:fs';
import { PLATFORM_NAMES } from '../scrapers/registry.js';

export function registerHealthRoute(app, port, deps = {}) {
    const bootInfo = deps.bootInfo ?? { gitSha: 'unknown', pkgVersion: '0.0.0' };
    const getLinkedInSession = deps.getLinkedInSession ?? (() => ({ isAlive: () => false, lease: null }));

    app.get('/', (_req, res) => {
        res.json({
            status: 'Unified Job Scraper API is running',
            version: bootInfo.pkgVersion ?? '2.0.0',
            gitSha: bootInfo.gitSha,
            availablePlatforms: PLATFORM_NAMES,
            endpoints: {
                scrape: { method: 'POST', path: '/scrape', description: 'Manual scraping. Platforms can be a comma-separated string, array, or "all".', body: { platform: 'string | string[]', jobTitle: 'string', location: 'string' } },
                scrapeQueue: { method: 'POST', path: '/scrape-queue', description: 'Blacklight queue — automatic role selection.' },
                metrics: { method: 'GET', path: '/metrics', description: 'Prometheus text format — current in-process counters and gauges.' },
                healthz: { method: 'GET', path: '/healthz', description: 'Cheap liveness + identity payload.' },
                healthLinkedin: { method: 'GET', path: '/health/linkedin?probe=1', description: 'Real in-session probe of the LinkedIn feed page.' },
            },
            examples: [
                { description: 'Single platform', curl: `curl -X POST http://localhost:${port}/scrape -H "Content-Type: application/json" -d '{"platform":"monster","jobTitle":"DevOps Engineer","location":"california"}'` },
                { description: 'Blacklight queue', curl: `curl -X POST http://localhost:${port}/scrape-queue` },
            ],
        });
    });

    app.get('/healthz', (_req, res) => {
        const session = getLinkedInSession();
        res.json({
            ok: true,
            pid: bootInfo.pid,
            gitSha: bootInfo.gitSha,
            bootedAt: bootInfo.bootedAt,
            nodeVersion: bootInfo.nodeVersion,
            pkgVersion: bootInfo.pkgVersion,
            profileDir: bootInfo.profileDir,
            profileDirExists: bootInfo.profileDir ? existsSync(bootInfo.profileDir) : false,
            sessionAlive: !!session?.isAlive?.(),
            leaseCredentialId: session?.lease?.credential?.id ?? null,
            headless: !!bootInfo.headless,
            strict: !!bootInfo.strict,
            uptimeSec: Math.round(process.uptime()),
        });
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/routes/healthz.test.js'`
Expected: PASS (3 tests).

Wire-up safety check: confirm `server.js` callers still compile by running `node --test 'test/**/*.test.js'` — the existing test suite should remain green because the new `deps` argument is optional (`deps = {}`).

- [ ] **Step 5: Commit**

```bash
git add src/routes/health.js test/routes/healthz.test.js
git commit -m "$(cat <<'EOF'
feat(routes): add GET /healthz + surface gitSha on the welcome route

/healthz returns {pid, gitSha, profileDir, profileDirExists, sessionAlive,
leaseCredentialId, headless, strict, uptimeSec} — cheap, no I/O, suitable
for k8s livenessProbes. The legacy GET / payload gains gitSha + version
from bootInfo. registerHealthRoute is backward-compatible: deps is
optional so callers that haven't been updated still work.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `/health/linkedin?probe=1` (real probe)

**Files:**
- Modify: `src/routes/health.js`
- Test: `test/routes/health-linkedin-probe.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/routes/health-linkedin-probe.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerHealthRoute } from '../../src/routes/health.js';

const bootInfo = {
    pid: 4242, gitSha: 'abc1234', bootedAt: '2026-06-03T00:00:00.000Z',
    nodeVersion: 'v24.5.0', pkgVersion: '2.0.0',
    profileDir: '/tmp/li-profile', headless: false, strict: false,
};

function inject(deps) {
    const app = express();
    registerHealthRoute(app, 3001, { bootInfo, ...deps });
    return app;
}

function callHandler(app, urlPath) {
    return new Promise((resolve) => {
        const url = new URL(urlPath, 'http://localhost');
        const req = { method: 'GET', url: urlPath, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: {} };
        const res = {
            statusCode: 200, _headers: {},
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(o) { resolve({ status: this.statusCode, body: o }); return this; },
            end() { resolve({ status: this.statusCode, body: null }); },
        };
        app.handle(req, res, () => resolve({ status: 404, body: null }));
    });
}

test('GET /health/linkedin (no probe flag): returns hint, no work', async () => {
    let called = false;
    const session = { isAlive: () => true, lease: null, withPage: async () => { called = true; return null; } };
    const app = inject({ getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, '/health/linkedin');
    assert.equal(status, 200);
    assert.equal(body.probe, false);
    assert.match(body.hint, /probe=1/);
    assert.equal(called, false);
});

test('GET /health/linkedin?probe=1: authed feed page → loggedIn:true', async () => {
    const session = {
        isAlive: () => true, lease: null,
        withPage: async (sid, fn) => fn({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }),
    };
    const app = inject({ getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, '/health/linkedin?probe=1');
    assert.equal(status, 200);
    assert.equal(body.probe, true);
    assert.equal(body.loggedIn, true);
    assert.equal(body.urlClass, 'authed');
});

test('GET /health/linkedin?probe=1: login redirect → loggedIn:false', async () => {
    const session = {
        isAlive: () => true, lease: null,
        withPage: async (sid, fn) => fn({ goto: async () => {}, url: () => 'https://www.linkedin.com/login?session_redirect=...' }),
    };
    const app = inject({ getLinkedInSession: () => session });
    const { body } = await callHandler(app, '/health/linkedin?probe=1');
    assert.equal(body.loggedIn, false);
    assert.equal(body.urlClass, 'login');
});

test('GET /health/linkedin?probe=1: withPage throws → 503', async () => {
    const session = {
        isAlive: () => false, lease: null,
        withPage: async () => { throw new Error('browser dead'); },
    };
    const app = inject({ getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, '/health/linkedin?probe=1');
    assert.equal(status, 503);
    assert.equal(body.loggedIn, false);
    assert.match(body.error, /browser dead/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/routes/health-linkedin-probe.test.js'`
Expected: FAIL — `/health/linkedin` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

In `src/routes/health.js`, append (inside `registerHealthRoute`, after the `/healthz` block):

```js
    app.get('/health/linkedin', async (req, res) => {
        if (req.query.probe !== '1') {
            return res.json({
                probe: false,
                hint: 'Add ?probe=1 to run an in-session feed check. Cheap state is on /healthz.',
            });
        }
        const session = getLinkedInSession();
        const sessionId = `healthcheck-${Date.now()}`;
        try {
            const { url, urlClass } = await session.withPage(sessionId, async (page) => {
                await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                const u = page.url();
                const { classifyLinkedinUrl } = await import('../setup/verify.js');
                return { url: u, urlClass: classifyLinkedinUrl(u) };
            });
            res.json({
                probe: true,
                checkedAt: new Date().toISOString(),
                url,
                urlClass,
                loggedIn: urlClass === 'authed',
            });
        } catch (e) {
            res.status(503).json({
                probe: true,
                checkedAt: new Date().toISOString(),
                loggedIn: false,
                error: e?.message ?? String(e),
            });
        }
    });
```

(Reusing `classifyLinkedinUrl` from `src/setup/verify.js` rather than re-implementing keeps the classification rule single-source.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/routes/health-linkedin-probe.test.js'`
Expected: PASS (4 tests). Also `node --test 'test/routes/*.test.js'` — `/healthz` test still passes.

- [ ] **Step 5: Commit**

```bash
git add src/routes/health.js test/routes/health-linkedin-probe.test.js
git commit -m "$(cat <<'EOF'
feat(routes): add GET /health/linkedin?probe=1

Borrows a page from the persistent LinkedIn session, navigates /feed/,
classifies the resulting URL via the existing classifyLinkedinUrl helper.
Without ?probe=1 it short-circuits with a hint — protects against flood-
probing the shared browser context.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wizard `linkedin:login` banner

**Files:**
- Modify: `src/setup/wizard.js` (after the final `out(result.message)` line, before the "Setup complete..." line)
- Test: `test/setup/wizard-linkedin-login-banner.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/setup/wizard-linkedin-login-banner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../../src/setup/wizard.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setupw-banner-')); }
function scripted(answers) { let i = 0; return async () => answers[i++]; }
const okBrowser = async () => ({
    newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }) }),
    close: async () => {},
});
const LI = JSON.stringify([{ name: 'li_at', value: 'V', domain: '.www.linkedin.com' }]);

test('LOCAL success path prints the linkedin:login banner', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        ask: scripted(['1', LI, 'done', 'no', 'no', 'interactive', '3001']),
        launchFn: okBrowser,
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    const joined = out.join('\n');
    assert.match(joined, /IMPORTANT.*next step/i);
    assert.match(joined, /npm run linkedin:login/);
});

test('REMOTE success path also prints the linkedin:login banner', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        ask: scripted(['2', 'https://blacklight.example.com', 'KEYB', 'https://creds.example.com', 'KEYC', 'daemon', 'no', 'no', '3001']),
        fetchFn: async () => ({ status: 200 }),
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    assert.match(out.join('\n'), /npm run linkedin:login/);
});

test('Cancel path does NOT print the linkedin:login banner', async () => {
    const cwd = tmp(); const out = [];
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{}');
    const code = await runSetupWizard({
        cwd,
        ask: scripted(['cancel']),
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 1);
    assert.doesNotMatch(out.join('\n'), /npm run linkedin:login/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/setup/wizard-linkedin-login-banner.test.js'`
Expected: FAIL — none of the assertions about `npm run linkedin:login` match.

- [ ] **Step 3: Write minimal implementation**

In `src/setup/wizard.js`, locate the success block near the end of `runSetupWizard`:

```js
        out(result.message);
        out(runMode === 'remote'
            ? 'Setup complete. Start with: npm start  — to run it as a managed service, see docs/MAC_SETUP.md or docs/WINDOWS_SETUP.md'
            : 'Setup complete. Start with: npm start');
        return 0;
```

Replace with:

```js
        out(result.message);
        out('─────────────────────────────────────────────────────────────────────');
        out('IMPORTANT — next step (do not skip):');
        out('');
        out('  The runtime uses an on-disk LinkedIn profile, NOT the cookies you');
        out('  just saved. To make scraping work you MUST log in once:');
        out('');
        out('      npm run linkedin:login');
        out('');
        out('  Sign in to LinkedIn in the window that opens, press Enter in this');
        out('  terminal when you see your feed, then start the server:');
        out('');
        out('      npm start');
        out('─────────────────────────────────────────────────────────────────────');
        out(runMode === 'remote'
            ? 'Setup complete. To run it as a managed service, see docs/MAC_SETUP.md or docs/WINDOWS_SETUP.md.'
            : 'Setup complete.');
        return 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/setup/wizard-linkedin-login-banner.test.js'`
Expected: PASS (3 tests). Also `node --test 'test/setup/wizard.test.js'` — existing wizard tests still pass; if any old assertion was sensitive to the exact "Setup complete..." line, update it in this commit to match the new wording.

- [ ] **Step 5: Commit**

```bash
git add src/setup/wizard.js test/setup/wizard-linkedin-login-banner.test.js
# Include test/setup/wizard.test.js if updated to match new "Setup complete" line.
git commit -m "$(cat <<'EOF'
feat(setup): wizard demands `npm run linkedin:login` before claiming success

Adds a bolded banner after the config write succeeds telling the operator
that the runtime uses an on-disk profile, not the saved cookies, and must
log in once via `npm run linkedin:login`. Prevents the green-setup +
forever-failing-scrape failure mode.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wizard `verifyRemote` strict response check

**Files:**
- Modify: `src/setup/verify.js` (`verifyRemote`)
- Test: `test/setup/verify-remote-strict.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/setup/verify-remote-strict.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRemote } from '../../src/setup/verify.js';

function fetchOk() {
    return async () => ({
        status: 200,
        headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
        json: async () => ({ ok: true }),
    });
}

test('verifyRemote: 200 + JSON + expected key → ok', async () => {
    const res = await verifyRemote({
        fetchFn: fetchOk(),
        blacklight: { apiUrl: 'https://b.example.com', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c.example.com', apiKey: 'K' },
    });
    assert.equal(res.status, 'ok');
});

test('verifyRemote: 401 → bad with explicit reason', async () => {
    let i = 0;
    const fetchFn = async () => ({
        status: i++ === 0 ? 200 : 401,
        headers: { get: () => 'application/json' },
        json: async () => ({ ok: true }),
    });
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'bad');
    assert.match(res.message, /rejected/i);
});

test('verifyRemote: 200 + text/html (captive portal) → bad', async () => {
    const fetchFn = async () => ({
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () => '<html>Sign in to Wi-Fi</html>',
    });
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'bad');
    assert.match(res.message, /JSON|captive/i);
});

test('verifyRemote: 200 + JSON missing expected keys → bad', async () => {
    const fetchFn = async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ surprising: true }),
    });
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'bad');
    assert.match(res.message, /unexpected/i);
});

test('verifyRemote: network throw → warn (unchanged)', async () => {
    const fetchFn = async () => { throw new Error('ENOTFOUND'); };
    const res = await verifyRemote({
        fetchFn,
        blacklight: { apiUrl: 'https://b', apiKey: 'K' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'K' },
    });
    assert.equal(res.status, 'warn');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/setup/verify-remote-strict.test.js'`
Expected: FAIL — current `verifyRemote` only checks `status === 401/403` and never inspects content-type or response body.

- [ ] **Step 3: Write minimal implementation**

In `src/setup/verify.js`, replace the entire `verifyRemote` function with:

```js
export async function verifyRemote({ fetchFn, blacklight, scraperCredentials }) {
    const EXPECTED_KEYS = ['ok', 'credentials', 'queue', 'status', 'session', 'available'];

    const hit = async (label, base, apiKey, p) => {
        const r = await fetchFn(`${String(base).replace(/\/$/, '')}${p}`, {
            headers: { 'X-Scraper-API-Key': apiKey },
        });
        const ct = (r.headers?.get?.('content-type') ?? '').toLowerCase();
        return { label, status: r.status, ct, response: r };
    };

    try {
        const a = await hit('credentials', scraperCredentials.apiUrl, scraperCredentials.apiKey, '/api/scraper-credentials/queue/availability');
        const b = await hit('blacklight', blacklight.apiUrl, blacklight.apiKey, '/api/scraper/queue/current-session');

        const denied = [a, b].find((x) => x.status === 401 || x.status === 403);
        if (denied) return { status: 'bad', message: `❌ ${denied.label} API rejected the key (${denied.status}) — check the apiKey.` };

        for (const x of [a, b]) {
            if (!x.ct.startsWith('application/json')) {
                return { status: 'bad', message: `❌ ${x.label} API returned non-JSON content-type (${x.ct || 'unknown'}) — captive portal or wrong URL? Expected application/json.` };
            }
            let body;
            try { body = await x.response.json(); }
            catch (_e) { return { status: 'bad', message: `❌ ${x.label} API response was not parseable JSON.` }; }
            const hasExpected = body && typeof body === 'object'
                && EXPECTED_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body, k));
            if (!hasExpected) {
                return { status: 'bad', message: `❌ ${x.label} API returned an unexpected schema (no ${EXPECTED_KEYS.join('/')}); check the URL points at the right service.` };
            }
        }

        return { status: 'ok', message: '✅ APIs reachable & key accepted — ready. Run: npm start' };
    } catch (e) {
        return { status: 'warn', message: `⚠️ Could not reach an API (${String(e.message).split('\n')[0]}); config written.` };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/setup/verify-remote-strict.test.js'`
Expected: PASS (5 tests). Also `node --test 'test/setup/verify.test.js'` and `node --test 'test/setup/wizard.test.js'` — existing tests still pass (the wizard test that uses `fetchFn: async () => ({ status: 200 })` may need a `headers.get` and `json()` stub added; update it in this commit if so).

- [ ] **Step 5: Commit**

```bash
git add src/setup/verify.js test/setup/verify-remote-strict.test.js
# Include test/setup/wizard.test.js if the REMOTE-path fetch stub was updated.
git commit -m "$(cat <<'EOF'
feat(setup): verifyRemote requires JSON content-type + expected schema key

Captive-portal interstitials that return HTTP 200 with HTML body now fail
the API liveness check explicitly instead of passing as green. Response
must be application/json AND carry one of the known top-level keys.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: server.js — boot info, structured logs, build-info metric, deps

**Files:**
- Modify: `server.js` (boot section + route wiring)

This task has no new unit test — it's pure integration wiring of helpers already covered by Tasks 1, 3, 6. Manual smoke verification is in Step 4.

- [ ] **Step 1: Read the current `main()` in `server.js`**

The relevant region is the body of `main()` from `if (process.argv.slice(2).includes('--setup'))` through the `process.on('unhandledRejection', ...)` line at the bottom.

- [ ] **Step 2: Apply the edits**

In `server.js`:

(a) Add an import near the existing imports:

```js
import { resolveBootInfo } from './src/config/boot-info.js';
import { linkedInProfileDir } from './scrapers/linkedin.js';
```

(b) Inside `main()`, replace the existing `log.info('Starting Unified Job Scraper API', { ... })` block plus the subsequent `bootTelemetry`/`initializeCredentialsClient`/`buildOrchestrator` calls with:

```js
    const config = getConfig();
    const bootInfo = resolveBootInfo({ profileDir: () => linkedInProfileDir() });

    log.info('boot', {
        ...bootInfo,
        nodeEnv: config.nodeEnv,
        port: config.port,
        logLevel: config.logLevel,
        instance: config.telemetry.instance,
        mode: config.telemetry.mode,
        telemetryEnabled: Boolean(config.telemetry.baseUrl && config.telemetry.apiKey),
    });

    const telemetry = bootTelemetry(config);
    telemetry.metrics.recordBuildInfo({
        nodeVersion: bootInfo.nodeVersion,
        gitSha: bootInfo.gitSha,
        pkgVersion: bootInfo.pkgVersion,
        headless: bootInfo.headless,
        strict: bootInfo.strict,
    });
    initializeCredentialsClient();
    const orchestrator = buildOrchestrator(config);
```

(c) Update the `registerHealthRoute` call to pass deps:

```js
    registerHealthRoute(app, config.port, { bootInfo, getLinkedInSession });
```

(d) Update the listen callback to include `bootInfo`:

```js
    const server = app.listen(config.port, () => {
        log.info('Server listening', { port: config.port, ...bootInfo });
        if (orchestrator && !config.isDevelopment) {
            orchestrator.startAutoChecker();
        } else if (config.isDevelopment) {
            log.info('Auto queue checker disabled in development mode');
        }
    });
```

- [ ] **Step 3: Smoke-verify boot log**

Run (in a separate terminal so it can be killed):

```bash
LINKEDIN_HEADLESS=false SCRAPER_STRICT_EMPTY=false node server.js 2>&1 | head -20
```

Expected: the first 5–10 lines include `"gitSha":"<7-char hash>"`, `"profileDir":"<absolute path>"`, `"headless":false`, `"strict":false`, `"pid":<number>`.

Kill with Ctrl-C. (If no LinkedIn config is present and the boot fails before that line, the failure must still log the `boot` line.)

- [ ] **Step 4: Run the full test suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all tests pass. The `healthz` and `health-linkedin-probe` tests already exercise the new deps shape; the unit suite does not boot the server.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
feat(server): stamp every boot log with structured identity

Resolve {pid, gitSha, bootedAt, nodeVersion, pkgVersion, profileDir,
headless, strict} once and attach it to the boot log, the "Server
listening" log, scraper_build_info labels, and the /healthz route.
Operators can answer "is the new code actually running" in one `grep`.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: server.js — uncaughtException + exit-code-aware shutdown

**Files:**
- Modify: `server.js`

Like Task 10, no new unit test — this wires the helper from Task 5. Existing exit-code tests already cover the pure helper.

- [ ] **Step 1: Add an import**

In `server.js`, add:

```js
import { exitCodeFor, EXIT_REASONS } from './src/server/exit-codes.js';
```

- [ ] **Step 2: Apply the shutdown edits**

Replace the `let shuttingDown = false;` block through the end of `main()` with:

```js
    let shuttingDown = false;
    let shutdownReason = EXIT_REASONS.SIGNAL;

    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;

        setTimeout(() => {
            log.warn('Hard-exit budget exhausted; forcing exit', { reason: shutdownReason });
            process.exit(exitCodeFor(shutdownReason));
        }, SHUTDOWN_BUDGET_MS).unref();

        log.info('Shutdown initiated', { signal, budgetMs: SHUTDOWN_BUDGET_MS, reason: shutdownReason, ...bootInfo });
        orchestrator?.stopAutoChecker();
        telemetry.heartbeat.stop();

        const steps = [
            ['pusher', telemetry.pusher.stop({ finalPush: true })],
            ['loki', telemetry.lokiTransport.stop({ finalFlush: true })],
            ['linkedin-session', getLinkedInSession().shutdown()],
            ['credentials', getCredentialsClient().releaseAll()],
        ];
        for (const [label, promise] of steps) {
            try { await withTimeout(label, promise); }
            catch (error) { log.error(`shutdown step '${label}' failed`, { err: error.message }); }
        }

        server.close(() => {
            log.info('Server closed', { reason: shutdownReason });
            process.exit(exitCodeFor(shutdownReason));
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        log.error('Unhandled promise rejection', { reason: String(reason) });
        shutdownReason = EXIT_REASONS.CRASH;
        shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
        log.error('Uncaught exception', { err: String(err?.stack || err) });
        shutdownReason = EXIT_REASONS.CRASH;
        shutdown('uncaughtException');
    });
}

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', error);
    process.exit(exitCodeFor(EXIT_REASONS.CRASH));
});
```

(The fatal-startup `process.exit(1)` is upgraded to the structured `crash` code so supervisors can distinguish startup crashes from clean exits.)

- [ ] **Step 3: Smoke-verify**

Run the server briefly and SIGINT it:

```bash
node server.js &
SERVER_PID=$!
sleep 2
kill -INT $SERVER_PID
wait $SERVER_PID
echo "exit code: $?"
```

Expected: clean shutdown logs and `exit code: 0`.

For the crash path (in a separate terminal, optional):

```bash
node -e "import('./server.js').then(()=>{setTimeout(()=>{throw new Error('test-crash')},500)})" 2>&1 | tail -10
echo "exit code: $?"
```

Expected: `Uncaught exception` log and `exit code: 42`.

- [ ] **Step 4: Run the full test suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
feat(server): exit-code-aware shutdown + uncaughtException handler

shutdownReason flows into process.exit via exitCodeFor():
  0  signal       clean SIGINT/SIGTERM
  2  auth-dead    reserved for orchestrator wiring (no flips here yet)
  3  lease-starved reserved for orchestrator wiring
  42 crash        uncaughtException / unhandledRejection / startup throw
  1  unknown
Lets supervisors distinguish "page humans" from "restart me" without
parsing logs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Docs — `docs/MAC_SETUP.md` restart-after-pull callout

**Files:**
- Modify: `docs/MAC_SETUP.md`

- [ ] **Step 1: Locate the "updating" section**

Run: `grep -n "git pull\|updating\|update\|hot.reload\|reload" docs/MAC_SETUP.md`
Expected: at minimum lines around 335 (the misleading hot-reload paragraph) and the `git pull` recipe section.

- [ ] **Step 2: Insert the bolded callout**

Immediately above the `git pull` recipe section (the heading that introduces the "updating after a release" workflow — typically `## Updating` or similar), insert this block verbatim:

```markdown
> **⚠ Node does NOT hot-reload imported source files. After `git pull` you MUST restart the service.**
>
> ```bash
> launchctl kickstart -k gui/$UID/com.qp.scraper
> ```
>
> If you're not running under launchd, kill the existing `node server.js`
> process and start a new one with `npm start`.
>
> **Skipping the restart is silent** — the in-memory copy of the scraper
> keeps executing the OLD code, while `git log` and the file system show
> the new commit. Symptoms include emitting `job_url=""` rows that backend
> tooling cannot fix without a re-scrape.
>
> Confirm the new code is live by checking `/healthz`:
>
> ```bash
> curl -s http://localhost:3001/healthz | jq '.gitSha'
> ```
>
> The `gitSha` returned must match `git rev-parse --short HEAD` in this
> directory. If they differ, the process is running stale code.
```

- [ ] **Step 3: Soften the hot-reload paragraph**

Find the existing line around `:335` that implies hot-reload of source files. Rewrite to clarify scope:

```markdown
Note: `config/credentials.json` is re-read on every scrape, so credential
rotations take effect without a restart. This does NOT apply to the
scraper source code — see the restart callout above.
```

- [ ] **Step 4: Verify**

Run: `grep -c "kickstart\|gitSha\|hot-reload\|hot reload" docs/MAC_SETUP.md`
Expected: at least one match for `kickstart`, one for `gitSha`, and the misleading "hot-reload" phrase no longer suggests the source reloads.

- [ ] **Step 5: Commit**

```bash
git add docs/MAC_SETUP.md
git commit -m "$(cat <<'EOF'
docs(mac): require restart after `git pull` + show /healthz gitSha check

Adds a bolded callout above the update recipe and softens the misleading
hot-reload paragraph. Prevents the aravind-mac-mini failure mode
(stale process emitting empty job_url) from recurring on Mac boxes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Docs — `docs/WINDOWS_SETUP.md` restart-after-pull callout

**Files:**
- Modify: `docs/WINDOWS_SETUP.md`

- [ ] **Step 1: Locate the "updating" section**

Run: `grep -n "git pull\|updating\|update\|hot.reload\|reload" docs/WINDOWS_SETUP.md`
Expected: a `git pull` workflow section and a paragraph around `:268` implying hot-reload.

- [ ] **Step 2: Insert the bolded callout**

Above the `git pull` recipe section, insert:

```markdown
> **⚠ Node does NOT hot-reload imported source files. After `git pull` you MUST restart the service.**
>
> ```powershell
> nssm restart qp-scraper
> ```
>
> If you're not running under NSSM, kill the existing `node server.js`
> process and start a new one with `npm start`.
>
> **Skipping the restart is silent** — the in-memory copy of the scraper
> keeps executing the OLD code, while `git log` and the file system show
> the new commit. Symptoms include emitting `job_url=""` rows that backend
> tooling cannot fix without a re-scrape.
>
> Confirm the new code is live by checking `/healthz`:
>
> ```powershell
> Invoke-RestMethod http://localhost:3001/healthz | Select-Object -Expand gitSha
> ```
>
> The `gitSha` returned must match `git rev-parse --short HEAD` in this
> directory. If they differ, the process is running stale code.
```

- [ ] **Step 3: Soften the hot-reload paragraph**

Find the line around `:268` and rewrite as in Task 12, Step 3 (`config/credentials.json` is re-read per scrape; scraper source is not).

- [ ] **Step 4: Verify**

Run: `grep -c "nssm\|gitSha\|hot-reload\|hot reload" docs/WINDOWS_SETUP.md`
Expected: at least one `nssm`, one `gitSha`, and no misleading hot-reload claim.

- [ ] **Step 5: Commit**

```bash
git add docs/WINDOWS_SETUP.md
git commit -m "$(cat <<'EOF'
docs(windows): require restart after `git pull` + show /healthz gitSha check

Mirrors the MAC_SETUP callout, with NSSM/PowerShell-flavored commands.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Docs — `README.md` exit-code table + "After updating" subsection

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Inspect the existing README**

Run: `grep -n "^##\|^#" README.md | head -20`
Expected: an existing `## Setup` (or similar) and a top-level `# ...` heading.

- [ ] **Step 2: Add the "After updating" subsection**

Below the `## Setup` section (after whatever existing setup-related content), insert:

```markdown
## After updating

Node does NOT hot-reload imported source files. After `git pull` you
MUST restart `node server.js` for the new code to take effect. Confirm
with `curl -s http://localhost:3001/healthz | jq .gitSha` — the value
must match `git rev-parse --short HEAD`.

Platform-specific recipes:

- macOS: see [docs/MAC_SETUP.md](docs/MAC_SETUP.md#updating)
- Windows: see [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md#updating)
```

- [ ] **Step 3: Add the exit-code reference**

Below "After updating", insert:

```markdown
## Exit codes

`node server.js` exits with a structured code so supervisors can pick a
restart policy:

| Code | Reason | Supervisor action |
|---|---|---|
| 0 | clean SIGINT/SIGTERM | per policy |
| 2 | `auth-dead` — LinkedIn session unrecoverable, no fallback | page humans, do NOT auto-restart |
| 3 | `lease-starved` — credential pool empty for N polls | back off, retry later |
| 42 | `crash` — uncaught exception / unhandled rejection | restart |
| 1 | unknown / startup failure | treat as crash |
```

- [ ] **Step 4: Verify**

Run: `grep -c "After updating\|Exit codes\|gitSha" README.md`
Expected: at least one match per entry.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): "After updating" subsection + exit-code reference table

Centralizes the restart-after-pull rule in the front-door README and
documents the structured exit codes supervisors should branch on.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

After all 14 tasks land, run the full test suite plus a manual server smoke:

- [ ] **Step 1: Full test suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all tests pass. New tests (5 created in this plan) plus the existing suite (147+ tests at start). New count should be at least 162.

- [ ] **Step 2: Manual `/healthz` smoke**

```bash
node server.js &
SERVER_PID=$!
sleep 2
curl -s http://localhost:3001/healthz | jq '.gitSha,.profileDir,.sessionAlive,.headless,.strict'
kill -INT $SERVER_PID
wait $SERVER_PID
```

Expected: `/healthz` returns the boot identity and `gitSha` matches `git rev-parse --short HEAD`.

- [ ] **Step 3: Boot log contains the structured identity**

```bash
node server.js 2>&1 | head -5
```

Expected: a line with `"boot"` containing `gitSha`, `profileDir`, `headless`, `strict`, `pid`.

- [ ] **Step 4: Hand off to `superpowers:finishing-a-development-branch`**

Once verification passes, follow that skill to choose between merge / PR / keep.

---

## Self-review notes (for the planner)

- **Spec coverage:** Sections A (boot stamp) → Tasks 1, 10. Section B (/healthz + /health/linkedin) → Tasks 6, 7. Section C (metrics) → Tasks 3, 4. Section D (wizard) → Tasks 8, 9. Section E (docs) → Tasks 12, 13, 14. Section F (lifecycle) → Tasks 5, 11. All six spec sections are covered.
- **Deferred from spec on purpose:** the Chromium SIGKILL backstop (Section F item 5 in the spec) is explicitly out of scope — it requires changes to `src/scrapers/linkedin-session.js` that are deferred to the session/lease slice.
- **No placeholders:** every code step shows the full code to write. No "TODO" / "add validation" / "similar to Task N" references.
- **Type consistency:** `bootInfo` is the same shape across Tasks 1, 6, 10, 11. `EXIT_REASONS` symbols match between Tasks 5 and 11. `classifyUrl` quality strings match between Tasks 2, 3, 4.
- **Test count delta:** +6 new test files (`boot-info`, `url-quality`, `url-quality-metric`, `base-scraper-url-quality`, `exit-codes`, `healthz`, `health-linkedin-probe`, `wizard-linkedin-login-banner`, `verify-remote-strict`) ≈ 30+ new test cases. Total suite should clear 175.
