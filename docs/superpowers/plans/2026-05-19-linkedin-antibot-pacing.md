# LinkedIn Anti-Bot Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a LinkedIn scrape run exactly one randomly-chosen query variant per browser session with human-like, jittered, env-tunable scroll pacing, so LinkedIn stops killing the session after ~1 query.

**Architecture:** Three pure, exported, unit-tested helpers (`readPacingConfig`, `pickSessionQuery`, `nextScrollDelay`) added to `scrapers/linkedin.js` (mirroring the existing `canPasswordLogin`/`linkedinPageState` pure-export pattern), plus thin wiring at exact call sites in `scrapeLinkedIn`/`extractPosts` and seven env knobs folded into the `CONFIG` block. Scraper-only — no orchestrator/backend/proxy changes.

**Tech Stack:** Node 20+ ESM (host Node v24.14.0), `node:test` + `node:assert/strict`. Zero new dependencies.

> **Source of truth:** `docs/superpowers/specs/2026-05-19-linkedin-antibot-pacing-design.md`.
> **Node 24:** single file `node --test test/scrapers/<file>.test.js`; full suite `npm test` (= `node --test 'test/**/*.test.js'`). Success = the task's tests pass AND `fail 0`.
> **Never stage** `.gitignore` or `pnpm-lock.yaml` (pre-existing unrelated dirty).
> All tasks modify the single file `scrapers/linkedin.js` → execute **sequentially** (no parallel batch; same-file conflicts).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `scrapers/linkedin.js` | LinkedIn scraper | Modify: add 3 pure exports; fold env knobs into `CONFIG`; wire one-variant + pacing at exact call sites |
| `test/scrapers/linkedin-pacing-config.test.js` | `readPacingConfig` unit tests | Create |
| `test/scrapers/linkedin-pick-session-query.test.js` | `pickSessionQuery` unit tests | Create |
| `test/scrapers/linkedin-scroll-delay.test.js` | `nextScrollDelay` unit tests | Create |
| `docs/superpowers/plans/2026-05-19-linkedin-antibot-pacing-NOTES.md` | Completion notes | Create (Task 6) |

> Importing from `scrapers/linkedin.js` in a test is already proven safe — `test/scrapers/linkedin-can-password-login.test.js` and `linkedin-page-state.test.js` do exactly this; module-load side-effects (cloakbrowser import etc.) are tolerated by the test runner.

---

## Task 1: `readPacingConfig` + fold env knobs into `CONFIG`

**Files:** Modify `scrapers/linkedin.js`; Create `test/scrapers/linkedin-pacing-config.test.js`

- [ ] **Step 1: Write the failing test** — create `test/scrapers/linkedin-pacing-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPacingConfig } from '../../scrapers/linkedin.js';

test('readPacingConfig: all-absent → documented defaults', () => {
    assert.deepEqual(readPacingConfig({}), {
        maxScrolls: 60,
        noProgressStop: 4,
        scrollPacing: { min: 2500, max: 5000, pauseEvery: 6, pauseMin: 8000, pauseMax: 15000 },
    });
});

test('readPacingConfig: valid overrides parsed to ints', () => {
    const c = readPacingConfig({
        LINKEDIN_MAX_SCROLLS: '90', LINKEDIN_NOPROGRESS_STOP: '3',
        LINKEDIN_SCROLL_MIN_MS: '3000', LINKEDIN_SCROLL_MAX_MS: '7000',
        LINKEDIN_SCROLL_PAUSE_EVERY: '5', LINKEDIN_SCROLL_PAUSE_MIN_MS: '9000',
        LINKEDIN_SCROLL_PAUSE_MAX_MS: '20000',
    });
    assert.deepEqual(c, {
        maxScrolls: 90, noProgressStop: 3,
        scrollPacing: { min: 3000, max: 7000, pauseEvery: 5, pauseMin: 9000, pauseMax: 20000 },
    });
});

test('readPacingConfig: garbage/empty → default, never throws', () => {
    const c = readPacingConfig({ LINKEDIN_MAX_SCROLLS: 'abc', LINKEDIN_SCROLL_MIN_MS: '' });
    assert.equal(c.maxScrolls, 60);
    assert.equal(c.scrollPacing.min, 2500);
});

test('readPacingConfig: defaults to process.env when no arg (smoke, no throw)', () => {
    assert.doesNotThrow(() => readPacingConfig());
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/scrapers/linkedin-pacing-config.test.js` (export missing).

- [ ] **Step 3: Implement.** In `scrapers/linkedin.js`, the `CONFIG` block is currently (lines ~40-54):

```js
// Configuration
const CONFIG = {
    searchQuery: '',   // Will be built as a boolean query dynamically
    jobTitle: '',      // Will be set dynamically
    maxPosts: 100,
    scrollDelay: 2000,
    // LinkedIn credentials (fetched from API)
    email: null,
    password: null,
    credentialId: null,
    // Use search instead of feed for better job targeting
    useFeedInsteadOfSearch: false  // Set to true to use feed (has URLs but less relevant)
};
```

Immediately BEFORE `// Configuration` / `const CONFIG = {`, insert the pure helper:

```js
// Anti-bot pacing knobs (env-tunable, read once at module load). Mirrors
// env.js::toInt discipline — absent/garbage → default; never throws.
export function readPacingConfig(env = process.env) {
    const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
    return {
        maxScrolls: int(env.LINKEDIN_MAX_SCROLLS, 60),
        noProgressStop: int(env.LINKEDIN_NOPROGRESS_STOP, 4),
        scrollPacing: {
            min: int(env.LINKEDIN_SCROLL_MIN_MS, 2500),
            max: int(env.LINKEDIN_SCROLL_MAX_MS, 5000),
            pauseEvery: int(env.LINKEDIN_SCROLL_PAUSE_EVERY, 6),
            pauseMin: int(env.LINKEDIN_SCROLL_PAUSE_MIN_MS, 8000),
            pauseMax: int(env.LINKEDIN_SCROLL_PAUSE_MAX_MS, 15000),
        },
    };
}
```

Then fold its result into the `CONFIG` literal by adding a spread as the LAST property (leave every existing property unchanged, including the now-legacy `scrollDelay: 2000`):

```js
    // Use search instead of feed for better job targeting
    useFeedInsteadOfSearch: false,  // Set to true to use feed (has URLs but less relevant)
    ...readPacingConfig(),
};
```

(Note: a comma is added after `false` and the trailing-comment is preserved; `...readPacingConfig()` adds `maxScrolls`, `noProgressStop`, `scrollPacing` to `CONFIG`.)

- [ ] **Step 4: Run → PASS** — `node --test test/scrapers/linkedin-pacing-config.test.js` (4 pass, 0 fail).

- [ ] **Step 5: Syntax + full suite** — `node --check scrapers/linkedin.js` (clean) then `npm test` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add scrapers/linkedin.js test/scrapers/linkedin-pacing-config.test.js
git commit -m "feat(linkedin): env-tunable pacing config (readPacingConfig → CONFIG)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `pickSessionQuery` pure helper

**Files:** Modify `scrapers/linkedin.js`; Create `test/scrapers/linkedin-pick-session-query.test.js`

- [ ] **Step 1: Write the failing test** — create `test/scrapers/linkedin-pick-session-query.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSessionQuery } from '../../scrapers/linkedin.js';

test('pickSessionQuery: null / non-array / empty → null', () => {
    assert.equal(pickSessionQuery(null), null);
    assert.equal(pickSessionQuery(undefined), null);
    assert.equal(pickSessionQuery('nope'), null);
    assert.equal(pickSessionQuery([]), null);
});

test('pickSessionQuery: single element → that element', () => {
    assert.equal(pickSessionQuery(['only']), 'only');
});

test('pickSessionQuery: uniform pick via injected rng (no out-of-bounds)', () => {
    const q = ['a', 'b', 'c'];
    assert.equal(pickSessionQuery(q, () => 0), 'a');        // floor(0*3)=0
    assert.equal(pickSessionQuery(q, () => 0.5), 'b');      // floor(1.5)=1
    assert.equal(pickSessionQuery(q, () => 0.999), 'c');    // floor(2.997)=2
    assert.equal(pickSessionQuery(q, () => 1), 'c');        // clamped, never undefined
});

test('pickSessionQuery: does not mutate the input array', () => {
    const q = ['a', 'b'];
    pickSessionQuery(q, () => 0.7);
    assert.deepEqual(q, ['a', 'b']);
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/scrapers/linkedin-pick-session-query.test.js`.

- [ ] **Step 3: Implement.** In `scrapers/linkedin.js`, immediately AFTER the `readPacingConfig` function (added in Task 1) and before `// Configuration`, insert:

```js
// Anti-bot: choose exactly ONE query variant per browser session.
// Uniformly random so repeated orchestrator cycles cover all variants
// and the query pattern is less predictable. Pure (rng injectable).
export function pickSessionQuery(queries, rng = Math.random) {
    if (!Array.isArray(queries) || queries.length === 0) return null;
    const i = Math.min(queries.length - 1, Math.max(0, Math.floor(rng() * queries.length)));
    return queries[i];
}
```

- [ ] **Step 4: Run → PASS** — `node --test test/scrapers/linkedin-pick-session-query.test.js` (4 pass, 0 fail).

- [ ] **Step 5: Syntax** — `node --check scrapers/linkedin.js` (clean).

- [ ] **Step 6: Commit**

```bash
git add scrapers/linkedin.js test/scrapers/linkedin-pick-session-query.test.js
git commit -m "feat(linkedin): pure pickSessionQuery (one random variant/session)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `nextScrollDelay` pure helper

**Files:** Modify `scrapers/linkedin.js`; Create `test/scrapers/linkedin-scroll-delay.test.js`

- [ ] **Step 1: Write the failing test** — create `test/scrapers/linkedin-scroll-delay.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextScrollDelay } from '../../scrapers/linkedin.js';

const CFG = { min: 2500, max: 5000, pauseEvery: 6, pauseMin: 8000, pauseMax: 15000 };

test('nextScrollDelay: base delay within [min,max] for non-pause indices', () => {
    assert.equal(nextScrollDelay(1, () => 0, CFG), 2500);
    assert.equal(nextScrollDelay(1, () => 1, CFG), 5000);
    assert.equal(nextScrollDelay(5, () => 0.5, CFG), 3750);
});

test('nextScrollDelay: index 0 is a base delay (never a pause)', () => {
    assert.equal(nextScrollDelay(0, () => 0, CFG), 2500);
});

test('nextScrollDelay: pause at index>0 && index%pauseEvery===0, within [pauseMin,pauseMax]', () => {
    assert.equal(nextScrollDelay(6, () => 0, CFG), 8000);
    assert.equal(nextScrollDelay(12, () => 1, CFG), 15000);
    assert.equal(nextScrollDelay(6, () => 0.5, CFG), 11500);
});

test('nextScrollDelay: pauseEvery<=0 disables pauses; rng default tolerated', () => {
    const c = { ...CFG, pauseEvery: 0 };
    const v = nextScrollDelay(6, undefined, c);   // rng undefined → Math.random fallback
    assert.ok(v >= 2500 && v <= 5000);
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/scrapers/linkedin-scroll-delay.test.js`.

- [ ] **Step 3: Implement.** In `scrapers/linkedin.js`, immediately AFTER the `pickSessionQuery` function (added in Task 2) and before `// Configuration`, insert:

```js
// Human-like scroll pacing: a jittered base delay, plus a longer
// "reading pause" every `pauseEvery` scrolls. Pure (rng injectable).
export function nextScrollDelay(scrollIndex, rng, cfg) {
    const r = typeof rng === 'function' ? rng : Math.random;
    const { min, max, pauseEvery, pauseMin, pauseMax } = cfg;
    if (scrollIndex > 0 && pauseEvery > 0 && scrollIndex % pauseEvery === 0) {
        return Math.round(pauseMin + r() * (pauseMax - pauseMin));
    }
    return Math.round(min + r() * (max - min));
}
```

- [ ] **Step 4: Run → PASS** — `node --test test/scrapers/linkedin-scroll-delay.test.js` (4 pass, 0 fail).

- [ ] **Step 5: Syntax + full suite** — `node --check scrapers/linkedin.js` then `npm test` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add scrapers/linkedin.js test/scrapers/linkedin-scroll-delay.test.js
git commit -m "feat(linkedin): pure nextScrollDelay (jittered base + periodic reading pause)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire one-variant-per-session

**Files:** Modify `scrapers/linkedin.js`

> No unit test: `scrapeLinkedIn` drives a real browser (consistent with `test/scrapers/` testing only pure helpers). The pure `pickSessionQuery` is already covered (Task 2). Verified by `node --check` + full suite + the Task 6 empirical run. The loop-iterates-once consequence (per-query re-auth + 8–12 s inter-query delay no longer execute) is structural, not a separate edit.

- [ ] **Step 1: Implement — variant selection.** In `scrapers/linkedin.js`, lines ~1176-1180 are currently:

```js
    const aiQueries = Array.isArray(options.searchQueries) && options.searchQueries.length > 0
        ? options.searchQueries
        : null;
    const queriesToRun = aiQueries || [buildBooleanSearchQuery(jobTitle)];
    CONFIG.searchQuery = queriesToRun[0]; // for downstream compatibility (logs, dumpDebugSnapshot)
```

Replace with:

```js
    const aiQueries = Array.isArray(options.searchQueries) && options.searchQueries.length > 0
        ? options.searchQueries
        : null;
    // Anti-bot: run exactly ONE query per browser session — LinkedIn
    // invalidates the automated session after ~1 query. A uniformly-
    // random variant gives all variants coverage across repeated cycles.
    const chosen = pickSessionQuery(aiQueries) ?? buildBooleanSearchQuery(jobTitle);
    const chosenIdx = aiQueries ? aiQueries.indexOf(chosen) : -1;
    const queriesToRun = [chosen];
    CONFIG.searchQuery = queriesToRun[0]; // for downstream compatibility (logs, dumpDebugSnapshot)
```

- [ ] **Step 2: Implement — logging.** Lines ~1183-1189 are currently:

```js
    logProgress('LinkedIn', `   Job Title: "${jobTitle}"`);
    if (aiQueries) {
        logProgress('LinkedIn', `   Using ${queriesToRun.length} AI-generated query variant(s):`);
        queriesToRun.forEach((q, i) => logProgress('LinkedIn', `      [${i + 1}] ${q}`));
    } else {
        logProgress('LinkedIn', `   Boolean Query (legacy template): ${CONFIG.searchQuery}\n`);
    }
```

Replace with:

```js
    logProgress('LinkedIn', `   Job Title: "${jobTitle}"`);
    if (aiQueries) {
        logProgress('LinkedIn', `   🎲 Variant [${chosenIdx + 1}/${aiQueries.length}] selected for this session: ${chosen}`);
    } else {
        logProgress('LinkedIn', `   Boolean Query (legacy template): ${CONFIG.searchQuery}\n`);
    }
```

- [ ] **Step 3: Verify** — `node --check scrapers/linkedin.js` (clean); `npm test` → `fail 0` (report the pass/fail line). Confirm by reading lines ~1263-1277 that the `for (let qi = 0; qi < queriesToRun.length; qi++)` loop and the `if (qi > 0) { … await randomDelay(8000, 12000); }` block are unchanged in code (they now simply never iterate past qi=0 because `queriesToRun.length === 1`).

- [ ] **Step 4: Commit**

```bash
git add scrapers/linkedin.js
git commit -m "feat(linkedin): one random query variant per session (was: all ~3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire pacing into `extractPosts`

**Files:** Modify `scrapers/linkedin.js`

> No unit test (browser path). `nextScrollDelay`/`readPacingConfig` are already covered (Tasks 3/1). Verified by `node --check` + full suite + Task 6 empirical.

- [ ] **Step 1: maxScrolls from CONFIG.** Line ~677 is `const maxScrolls = 150;`. Replace with:

```js
    const maxScrolls = CONFIG.maxScrolls;
```

- [ ] **Step 2: No-progress threshold from CONFIG.** Lines ~1080-1083 are currently:

```js
        if (noNewPostsCount >= 5) {
            logProgress('LinkedIn', '   ℹ️  No new posts for 5 scrolls, stopping...');
            break;
        }
```

Replace with:

```js
        if (noNewPostsCount >= CONFIG.noProgressStop) {
            logProgress('LinkedIn', `   ℹ️  No new posts for ${CONFIG.noProgressStop} scrolls, stopping...`);
            break;
        }
```

- [ ] **Step 3: Jittered/paused scroll delay.** Line ~1102 is currently:

```js
        await randomDelay(CONFIG.scrollDelay, CONFIG.scrollDelay + 1000);
```

Replace with:

```js
        await wait(nextScrollDelay(scrollAttempts, Math.random, CONFIG.scrollPacing));
```

(`wait` is the module-level `const wait = (ms) => new Promise(...)`; `scrollAttempts` is the loop counter incremented at the top of the scroll loop; `nextScrollDelay` and `CONFIG.scrollPacing` exist from Tasks 3 and 1.)

- [ ] **Step 4: Verify** — `node --check scrapers/linkedin.js` (clean); `npm test` → `fail 0` (report pass/fail). Grep-confirm no remaining `const maxScrolls = 150` / `noNewPostsCount >= 5` / `randomDelay(CONFIG.scrollDelay` in `scrapers/linkedin.js`.

- [ ] **Step 5: Commit**

```bash
git add scrapers/linkedin.js
git commit -m "feat(linkedin): jittered+paused scroll, env-tunable maxScrolls/no-progress stop

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verification + NOTES

**Files:** Create `docs/superpowers/plans/2026-05-19-linkedin-antibot-pacing-NOTES.md`

- [ ] **Step 1: Full suite** — `npm test` → record `pass N / fail 0`. New: `readPacingConfig` (4), `pickSessionQuery` (4), `nextScrollDelay` (4).

- [ ] **Step 2: Static inertness/wiring probe**:

```bash
node --check scrapers/linkedin.js && echo "syntax OK"
grep -n "pickSessionQuery(aiQueries)\|nextScrollDelay(scrollAttempts\|CONFIG.maxScrolls\|CONFIG.noProgressStop\|...readPacingConfig()" scrapers/linkedin.js
grep -c "const maxScrolls = 150\|noNewPostsCount >= 5\|randomDelay(CONFIG.scrollDelay\|Using \${queriesToRun.length} AI-generated" scrapers/linkedin.js
```
Expected: the first grep shows the wired call sites; the second grep prints `0` (all old forms gone).

- [ ] **Step 3: Empirical local run (honest caveat).** With the operator's LinkedIn cookies in LOCAL mode, run the established headed scrape. Expected: logs show `🎲 Variant [k/N] selected`, exactly one query runs (no `Inter-query delay` line), scroll logs show longer/jittered gaps and a periodic longer pause, early-stop after `CONFIG.noProgressStop`, scrape completes, verdict unchanged, suite green. **HONEST CAVEAT — state, do not work around:** anti-bot *effectiveness* ("LinkedIn no longer kills the session after ~1 query") is **not testable here** — it is a property of LinkedIn's live anti-bot, observable only as production session-survival over time, and there is no valid prod credential this session. The wired path and pacing behaviour are verified; effectiveness is documented as *expected, to be confirmed by ops watching prod `last_success_at`/starvation after rollout* — not asserted as proven.

- [ ] **Step 4: Write NOTES** — create `docs/superpowers/plans/2026-05-19-linkedin-antibot-pacing-NOTES.md`:

```markdown
# LinkedIn anti-bot pacing — completion notes
Status: COMPLETE. `npm test` <N>/0.
Delivered (scraper-only, scrapers/linkedin.js): pure `readPacingConfig`
(7 env knobs → CONFIG), `pickSessionQuery` (one uniformly-random variant
per session), `nextScrollDelay` (jittered base + periodic reading pause)
— all unit-tested in test/scrapers/. Wiring: scrapeLinkedIn runs exactly
one variant/session (per-query /feed/ re-auth + 8-12s inter-query delay
structurally eliminated — loop iterates once); extractPosts uses
CONFIG.maxScrolls (def 60, was 150), CONFIG.noProgressStop (def 4, was
5), and nextScrollDelay (was randomDelay(2000,3000)).
Non-goals honoured: no orchestrator/backend/proxy changes; no persistent
profile; auth-detection + verdict taxonomy + {jobs,emptyConfirmed} +
maxPosts(100) unchanged.
Production impact: fewer queries + gentler scroll per session; defaults
slower but functional; all tunable via LINKEDIN_* env without code.
HONEST CAVEAT: anti-bot effectiveness is NOT unit-testable and was NOT
confirmed in prod (no valid credential this session). Verified: pure
logic exhaustively unit-tested; wired path + pacing behaviour by the
local empirical run. Effectiveness = expected; confirm via prod
last_success_at / starvation rate after rollout (ops).
Diagnosis context: this is action #4 of the 2026-05-19 diagnosis; #1/#2
are ops, #3 shipped (PR #7), #5 is a backend handoff.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-19-linkedin-antibot-pacing-NOTES.md
git commit -m "docs(plan): linkedin anti-bot pacing completion notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** §2 Component A (`pickSessionQuery` pure + one-variant wiring + log) → Tasks 2 & 4. Component B (`nextScrollDelay` pure + maxScrolls/noProgressStop/delay wiring) → Tasks 3 & 5. Component C (`readPacingConfig` + 7 env knobs folded into `CONFIG`) → Task 1. §3 data flow (one variant → single nav → bounded jittered scroll) → Tasks 4+5. §4 error handling unchanged → no task touches verdict/taxonomy (Tasks 4/5 only change selection/pacing). §5 testing (3 pure helpers unit-tested; honest effectiveness caveat) → Tasks 1-3 + Task 6 Step 3. §6 non-goals → nothing added beyond scope. §7 acceptance → Task 6. No gaps.

**2. Placeholder scan:** none — every code step shows complete code; every run step has an exact command + expected result. The "no unit test for the browser path" (Tasks 4/5) and the effectiveness caveat (Task 6) are explicit, justified strategy carried verbatim from spec §5 — not hidden TODOs.

**3. Type/name consistency:** `readPacingConfig(env) → { maxScrolls, noProgressStop, scrollPacing:{min,max,pauseEvery,pauseMin,pauseMax} }` defined Task 1, consumed Task 5 (`CONFIG.maxScrolls`, `CONFIG.noProgressStop`, `CONFIG.scrollPacing`) and Task 3's test `CFG` shape — identical. `pickSessionQuery(queries, rng) → string|null` defined Task 2, consumed Task 4 (`pickSessionQuery(aiQueries) ?? buildBooleanSearchQuery(...)`). `nextScrollDelay(scrollIndex, rng, cfg) → ms` defined Task 3, consumed Task 5 (`nextScrollDelay(scrollAttempts, Math.random, CONFIG.scrollPacing)`) — `cfg` shape matches `scrollPacing`. Insertion order is consistent: Task 1 adds `readPacingConfig` before `// Configuration`; Tasks 2 & 3 add their helpers "after the previous function, before `// Configuration`" → all three end up grouped just above `CONFIG`, and `...readPacingConfig()` (Task 1) resolves because `readPacingConfig` is declared above `CONFIG`. No mismatches.
