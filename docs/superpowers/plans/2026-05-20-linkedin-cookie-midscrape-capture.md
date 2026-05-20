# LinkedIn cookie write-back — mid-scrape capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `skipped_no_li_at` from short-circuiting the cookie write-back in prod. Capture the cookie jar mid-scrape (right after each successful scroll batch, while still authenticated) and post **that** at session close, instead of re-capturing at close from a jar LinkedIn has already poisoned.

**Architecture:** One pure exported helper (`hasLiAt`) + an optional `onAuthenticatedBatch` callback into `extractPosts` + a `latestAuthenticatedJar` closure variable in `scrapeLinkedIn` + dropping the close-time `context.cookies()` recapture. No new files in `scrapers/`. Tests in `test/scrapers/`.

**Tech Stack:** Node 24 ESM, `node:test`, `node:assert/strict`, Playwright (untouched on this path).

**Source spec:** `docs/superpowers/specs/2026-05-20-linkedin-cookie-midscrape-capture-design.md` + the backend's 2026-05-20 timing-race diagnosis handoff (paraphrased in §1 of the spec).

---

### Task 1: Pure `hasLiAt` helper + unit tests

**Files:**
- Modify: `scrapers/linkedin.js` (add the helper near the other exported pure helpers around lines 45–78, e.g. just below `nextScrollDelay` — keep the existing top-of-file shape)
- Test: `test/scrapers/linkedin-has-li-at.test.js` (new)

- [ ] **Step 1: Write the failing tests**

```js
// test/scrapers/linkedin-has-li-at.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLiAt } from '../../scrapers/linkedin.js';

test('hasLiAt: null → false', () => {
    assert.equal(hasLiAt(null), false);
});

test('hasLiAt: undefined → false', () => {
    assert.equal(hasLiAt(undefined), false);
});

test('hasLiAt: non-array → false', () => {
    assert.equal(hasLiAt('not-an-array'), false);
    assert.equal(hasLiAt(42), false);
    assert.equal(hasLiAt({}), false);
});

test('hasLiAt: empty array → false', () => {
    assert.equal(hasLiAt([]), false);
});

test('hasLiAt: jar with no li_at entry → false', () => {
    assert.equal(hasLiAt([
        { name: 'lidc', value: 'b=VB10:s=V:...' },
        { name: 'bcookie', value: 'v=2&abc' },
    ]), false);
});

test('hasLiAt: li_at present but empty value → false', () => {
    assert.equal(hasLiAt([{ name: 'li_at', value: '' }]), false);
});

test('hasLiAt: li_at present but missing value → false', () => {
    assert.equal(hasLiAt([{ name: 'li_at' }]), false);
});

test('hasLiAt: li_at with non-empty value → true', () => {
    assert.equal(hasLiAt([{ name: 'li_at', value: 'AQEDATEAAA...' }]), true);
});

test('hasLiAt: li_at among other cookies → true', () => {
    assert.equal(hasLiAt([
        { name: 'bcookie', value: 'v=2&abc' },
        { name: 'li_at', value: 'AQEDATEAAA...' },
        { name: 'lidc', value: 'b=VB10:s=V:...' },
    ]), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
node --test 'test/scrapers/linkedin-has-li-at.test.js'
```
Expected: FAIL with `SyntaxError` or "hasLiAt is not exported from scrapers/linkedin.js".

- [ ] **Step 3: Implement `hasLiAt` (export from `scrapers/linkedin.js`)**

Add near the other exported pure helpers (`readPacingConfig`, `pickSessionQuery`, `nextScrollDelay`):

```js
export function hasLiAt(jar) {
    return Array.isArray(jar) && jar.some(
        c => c && c.name === 'li_at' && typeof c.value === 'string' && c.value.length > 0
    );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
node --test 'test/scrapers/linkedin-has-li-at.test.js'
```
Expected: PASS, 9/9.

- [ ] **Step 5: Run the full suite to confirm no regression**

```
npm test
```
Expected: green, prior count + 9.

- [ ] **Step 6: Commit**

```
git add scrapers/linkedin.js test/scrapers/linkedin-has-li-at.test.js
git commit -m "feat(linkedin): pure hasLiAt helper (jar still has live li_at?)"
```

---

### Task 2: Optional `onAuthenticatedBatch` callback in `extractPosts`

**Files:**
- Modify: `scrapers/linkedin.js:660` (the `extractPosts` signature) and `scrapers/linkedin.js:~1100-1113` (the `if (newPostsCount > 0)` block right after the dedup loop)

No unit test for this task in isolation — `extractPosts` is browser-driven and not unit-testable in the existing pattern. The wiring is verified by static probe in Task 3 and the full integration via `npm test` + `node --check`.

- [ ] **Step 1: Change the signature**

```js
// before:
async function extractPosts(page, maxPosts) {
// after:
async function extractPosts(page, maxPosts, opts = {}) {
```

- [ ] **Step 2: Add the capture site**

Inside the existing `if (newPostsCount > 0) { ... }` block (right after the `logProgress` for "✓ Found N new posts" and the `noNewPostsCount = 0` reset, BEFORE the closing brace of the if-block), append a best-effort capture:

```js
if (typeof opts.onAuthenticatedBatch === 'function') {
    try {
        const jar = await page.context().cookies();
        await opts.onAuthenticatedBatch(jar);
    } catch (_capErr) {
        // best-effort — never throws into the scroll loop, never affects
        // the scrape verdict; logged at DEBUG-level by the caller (or not at all).
    }
}
```

- [ ] **Step 3: Sanity-check syntax**

```
node --check scrapers/linkedin.js
```
Expected: no output (clean).

- [ ] **Step 4: Run the full suite — must remain green**

```
npm test
```
Expected: prior count + 9 (from Task 1). No regressions.

- [ ] **Step 5: Commit**

```
git add scrapers/linkedin.js
git commit -m "feat(linkedin): extractPosts onAuthenticatedBatch callback (capture mid-scrape)"
```

---

### Task 3: Wire `latestAuthenticatedJar` in `scrapeLinkedIn` + drop close-time recapture

**Files:**
- Modify: `scrapers/linkedin.js` (`scrapeLinkedIn` body around the `extractPosts` call site `:1328` and the close-time write-back `:1480-1481`)

- [ ] **Step 1: Declare the closure variable + callback**

In `scrapeLinkedIn`, **outside** the `for (let qi = …)` loop and **above** the `extractPosts` call (so it persists across query/scroll iterations even though we now run only one variant per session):

```js
let latestAuthenticatedJar = null;
const onAuthenticatedBatch = (jar) => {
    if (hasLiAt(jar)) latestAuthenticatedJar = jar;
};
```

- [ ] **Step 2: Pass the callback into `extractPosts`**

Locate `const queryPosts = await extractPosts(page, remainingBudget);` (~`:1328`) and change to:

```js
const queryPosts = await extractPosts(page, remainingBudget, { onAuthenticatedBatch });
```

- [ ] **Step 3: Replace the close-time capture**

Replace `:1480-1481`:

```js
// before:
const jar = await context.cookies().catch(() => null);
await lease.refreshCookies(jar);

// after:
// Cookie-jar write-back (handoff 2026-05-20 §4): post the freshest
// known-authenticated jar captured mid-scrape, NOT a close-time recapture
// — at close, LinkedIn may already have invalidated li_at server-side.
// refreshCookies is null-safe (planCookieRefresh returns
// {action:'skip', reason:'skipped_no_li_at'} for null / no-li_at jars).
await lease.refreshCookies(latestAuthenticatedJar);
```

- [ ] **Step 4: Sanity-check syntax + look for orphan references**

```
node --check scrapers/linkedin.js
grep -n "context.cookies" scrapers/linkedin.js   # expect: 0 hits
grep -n "latestAuthenticatedJar" scrapers/linkedin.js   # expect: ≥3 hits (decl, callback, refreshCookies)
```
Expected: clean check, 0 stale close-time captures, 3+ references to `latestAuthenticatedJar`.

- [ ] **Step 5: Run the full suite**

```
npm test
```
Expected: green, no regression. The never-`#forgetLease` test in `test/credentials/refresh-never-forgets-lease.test.js` still passes (the lease lifecycle path is unchanged; only the *input jar* to `refreshCookies` changes).

- [ ] **Step 6: Commit**

```
git add scrapers/linkedin.js
git commit -m "feat(linkedin): post mid-scrape captured jar, drop close-time recapture"
```

---

### Task 4: Verify wiring statically + run the suite + completion notes

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-linkedin-cookie-midscrape-capture-NOTES.md`

- [ ] **Step 1: Static probe**

```
grep -n "onAuthenticatedBatch\|latestAuthenticatedJar\|hasLiAt\|refreshCookies" scrapers/linkedin.js
grep -n "context\.cookies" scrapers/linkedin.js
node --check scrapers/linkedin.js
```
Expected:
- `onAuthenticatedBatch`: ≥3 hits (param destructure / call site / wiring)
- `latestAuthenticatedJar`: ≥3 hits
- `hasLiAt`: ≥2 hits (export, callback)
- `refreshCookies`: 1 hit (close-time write-back)
- `context\.cookies`: **0 hits** (the close-time capture is gone)
- `node --check`: clean

- [ ] **Step 2: Full test suite**

```
npm test
```
Expected: green; total = prior + 9 (Task 1 only adds tests).

- [ ] **Step 3: Write completion notes**

Save `docs/superpowers/plans/2026-05-20-linkedin-cookie-midscrape-capture-NOTES.md` covering:
- What shipped (1 helper, 1 callback hook, 1 closure variable, 1 close-time line replaced, 1 close-time call dropped)
- Test results (`npm test` final count)
- Verification: static probe outputs + node --check status
- **Honest caveat:** real validation is `rotation_count` on credential 12 incrementing above 0 after the next successful prod scrape — not provable here.

- [ ] **Step 4: Commit**

```
git add docs/superpowers/plans/2026-05-20-linkedin-cookie-midscrape-capture-NOTES.md
git commit -m "docs(plan): mid-scrape cookie capture completion notes"
```

---

## Self-review

- ✅ Spec coverage: Task 1 covers §2-A (hasLiAt) + §5 unit tests. Task 2 covers §2-B (extractPosts callback). Task 3 covers §2-C/D (scrapeLinkedIn wiring + drop close-time). Task 4 covers §7 verification + §5 honest caveat documentation.
- ✅ No placeholders: every step has concrete code or a concrete command.
- ✅ Type consistency: `hasLiAt(jar)` signature matches across spec/tests/usage. `onAuthenticatedBatch(jar)` matches across spec/wiring/callback.
- ✅ TDD: Task 1 is RED→GREEN. Tasks 2-3 have no unit test (browser-driven) but are pinned by static probes + the existing regression suite.
