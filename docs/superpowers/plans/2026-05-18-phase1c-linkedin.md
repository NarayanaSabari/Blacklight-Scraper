# Phase 1C-LinkedIn — Block/No-Results Detection (flag-gated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop `scrapers/linkedin.js` from reporting **success on a silent block / DOM change** (audit L1/L2, *proven live*: a healthy run logs "No recognizable container — likely challenge/login" because the page-state check uses dead pre-May-2026 selectors, so it cannot tell a good page from a real block). Wire the proven `assertNotBlocked()` + a pure LinkedIn page-state detector so a genuine block/checkpoint **throws loudly** instead of returning `[]` as success. Also fix D4 (10/24 cookies silently dropped) and L5 (stale "(CDP Method)" banner). **All behavior change gated behind `SCRAPER_STRICT_EMPTY`** — OFF (shipped default) = byte-identical to today (verified live: 100 posts in ~193s with valid cookies); flipping the env var per-host activates the fix.

**Architecture:** Pure exported helper `linkedinPageState(html, url, title)` → `'results' | 'no_results' | 'auth_wall' | 'challenge' | 'unknown'` (uses the live `componentkey` post signal + LinkedIn no-results text + `isLoginPage` + challenge markers). `const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true'`. STRICT-gated calls to `assertNotBlocked()` (Plan 1A) and the helper at the post-navigation point and at the 0-posts decision; `{ jobs, emptyConfirmed }` BaseScraper return (Plan 1A contract — harmless when OFF). The helper is unit-tested; `assertNotBlocked` is already unit-tested (Plan 1A). The full CloakBrowser flow is verified by an **empirical re-run with real cookies** (Task 3) — OFF must still scrape ~100 posts byte-identically; ON must still scrape AND no longer false-alarm.

**Tech Stack:** Node 20+ ESM (host Node v24.14.0), `node:test`. No new deps. Empirical run uses the local `config/credentials.json` (git-ignored).

> **Node 24:** `node --test 'test/**/*.test.js'`. Success = task's new tests pass AND `fail 0` (suite carries 58 from prior phases; cumulative counts illustrative).

**Source spec:** audit `docs/superpowers/specs/2026-05-18-blacklight-scraper-anti-bot-audit-design.md` — **L1** (0 posts / both-extractors-empty → still reportSuccess), **L2** (no in-loop block detection), **D1** (live: page-state validator uses dead selectors, false-alarms every run, can't distinguish block), **D4** (`sameSite:'unspecified'`→ literal string → Playwright drops the cookie), **L5** (stale banner). **Deferred to NOTES (enhancements, not safety):** D2 post-permalink recovery, D3 scroll-volume reduction, L10 module-global CONFIG, locale/timezone hardcoding.

**Production-safety contract:** With `SCRAPER_STRICT_EMPTY` !== 'true' (default): no `assertNotBlocked` call, no new throw, the legacy `navigateToSearch` snapshot behavior and the `loginSuccess=true; reportSuccess` 0-posts path are byte-identical; the only always-on changes are observability-safe (the `{jobs,emptyConfirmed}` return shape — BaseScraper handles it identically — and the cosmetic banner text). Verified by Task 3's inertness probe **and an empirical OFF re-run** that must still return ~100 posts.

---

## File Structure

| File | Action |
|---|---|
| `scrapers/linkedin.js` | Modify (export `linkedinPageState`; import `assertNotBlocked`+`DomChangedError`; `STRICT`; gated detection in `navigateToSearch` + 0-posts; D4 sameSite; L5 banner; `{jobs,emptyConfirmed}` return) |
| `test/scrapers/linkedin-page-state.test.js` | **Create** (pure helper unit tests + static gating guards) |

---

## Task 1: Pure `linkedinPageState` helper

**Files:** Modify `scrapers/linkedin.js` (add exported pure helper near `isLoginPage`); Create `test/scrapers/linkedin-page-state.test.js`.

- [ ] **Step 1: Failing test** — create `test/scrapers/linkedin-page-state.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedinPageState } from '../../scrapers/linkedin.js';

const J = (s) => s; // readability

test('results: componentkey post containers present', () => {
    assert.equal(linkedinPageState(
        '<main><div componentkey="expandedXYFeedType_FLAGSHIP_SEARCH"></div></main>',
        'https://www.linkedin.com/search/results/content/?keywords=x', 'Search | LinkedIn'), 'results');
});
test('results: legacy feed-shared container present', () => {
    assert.equal(linkedinPageState(
        '<div class="feed-shared-update-v2">post</div>', 'https://www.linkedin.com/feed/', 'Feed | LinkedIn'), 'results');
});
test('no_results: LinkedIn empty-state text, no containers', () => {
    assert.equal(linkedinPageState(
        '<div>No results found</div><div>Try searching for something else</div>',
        'https://www.linkedin.com/search/results/content/?keywords=zzz', 'Search | LinkedIn'), 'no_results');
});
test('auth_wall: login/authwall URL', () => {
    assert.equal(linkedinPageState('<html></html>',
        'https://www.linkedin.com/authwall?trk=x', 'Sign In | LinkedIn'), 'auth_wall');
});
test('auth_wall: checkpoint URL', () => {
    assert.equal(linkedinPageState('<html></html>',
        'https://www.linkedin.com/checkpoint/lg/login-submit', 'Security Verification'), 'auth_wall');
});
test('challenge: cloudflare/datadome marker (defensive)', () => {
    assert.equal(linkedinPageState('<div id="challenge-platform"></div>',
        'https://www.linkedin.com/feed/', 'Just a moment...'), 'challenge');
});
test('unknown: nothing recognizable (not falsely "results")', () => {
    assert.equal(linkedinPageState('<div>weird partial</div>',
        'https://www.linkedin.com/feed/', 'LinkedIn'), 'unknown');
});
test('safe on junk input', () => {
    assert.equal(linkedinPageState(null, null, null), 'unknown');
    assert.equal(linkedinPageState(42, {}, []), 'unknown');
});
```

- [ ] **Step 2: Run → FAIL** (`linkedinPageState` not exported): `node --test test/scrapers/linkedin-page-state.test.js`

- [ ] **Step 3: Implement** — in `scrapers/linkedin.js`, immediately ABOVE `function isLoginPage(url) {`, insert:

```js
// Pure page-state classifier — distinguishes a real results page from a
// genuine empty search vs an auth-wall / challenge, so a block can be
// made loud instead of silently reported as a successful 0-post scrape.
// Uses the LIVE May-2026 componentkey signal (the old container check
// in navigateToSearch keyed off pre-2026 selectors and false-alarmed on
// every healthy run). Pure + junk-safe. Order: challenge → auth_wall →
// results → no_results → unknown.
export function linkedinPageState(html, url, title) {
    const h = typeof html === 'string' ? html : '';
    const u = typeof url === 'string' ? url : '';
    const t = typeof title === 'string' ? title : '';
    const hay = (h + ' ' + t).toLowerCase();
    if (h.includes('challenge-platform') || h.includes('cf-chl-')
        || /just a moment|attention required/i.test(t)) return 'challenge';
    if (/\/login|\/uas\/login|\/checkpoint|\/authwall|session_redirect/.test(u)) return 'auth_wall';
    if (h.includes('componentkey="expanded')
        || h.includes('feed-shared-update-v2')
        || h.includes('reusable-search__result-container')
        || h.includes('scaffold-finite-scroll')) return 'results';
    if (/no results found|try searching for|we couldn.t find|no results for/i.test(hay)) return 'no_results';
    return 'unknown';
}
```

- [ ] **Step 4: Run → PASS** (8 tests). Then `npm test` → `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scrapers/linkedin.js test/scrapers/linkedin-page-state.test.js
git commit -m "feat(linkedin): pure linkedinPageState() classifier (L1/L2/D1 prep)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Flag-gated detection wiring + D4 + L5 (OFF = byte-identical)

**Files:** Modify `scrapers/linkedin.js`; Modify `test/scrapers/linkedin-page-state.test.js` (append static guards).

- [ ] **Step 1: Failing guard tests** — append to `test/scrapers/linkedin-page-state.test.js`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scrapers', 'linkedin.js'), 'utf8');

test('imports assertNotBlocked from the proven module', () => {
    assert.match(SRC, /import\s*\{\s*assertNotBlocked\s*\}\s*from\s*['"]\.\.\/src\/core\/block-detection\.js['"]/);
});
test('STRICT const present and every assertNotBlocked() is STRICT-gated', () => {
    assert.match(SRC, /const\s+STRICT\s*=\s*process\.env\.SCRAPER_STRICT_EMPTY\s*===\s*['"]true['"]/);
    const calls = [...SRC.matchAll(/assertNotBlocked\s*\(/g)];
    assert.ok(calls.length >= 1);
    for (const m of calls) {
        assert.ok(/if\s*\(\s*STRICT\s*\)/.test(SRC.slice(Math.max(0, m.index - 500), m.index)),
            'assertNotBlocked call not within an if (STRICT) guard');
    }
});
test('the new 0-posts throw is STRICT-gated', () => {
    assert.match(SRC, /if\s*\(\s*STRICT\b[^)]*\)\s*\{[^}]*throw new DomChangedError/s);
});
test('scrapeLinkedIn returns the {jobs, emptyConfirmed} contract', () => {
    assert.match(SRC, /return\s*\{\s*jobs:\s*normalizedPosts\s*,\s*emptyConfirmed/);
});
test('D4: sameSite never resolves to the literal "unspecified"', () => {
    // The mapping must fall back to 'Lax', not pass `c.sameSite` through.
    assert.doesNotMatch(SRC, /:\s*c\.sameSite\s*\|\|\s*'Lax'/);
    assert.match(SRC, /sameSiteMap|=== 'lax'\s*\?\s*'Lax'\s*:\s*'Lax'/);
});
test('L5: stale "(CDP Method)" banner removed', () => {
    assert.doesNotMatch(SRC, /CDP Method/);
});
```

- [ ] **Step 2: Run → FAIL** (no import/STRICT/throw/return-shape; sameSite still `c.sameSite || 'Lax'`; banner still "(CDP Method)").

- [ ] **Step 3: Add import + STRICT** — after `import { getMetrics } from '../src/metrics/registry.js';` add:

```js
import { assertNotBlocked } from '../src/core/block-detection.js';
import { DomChangedError } from '../src/core/errors.js';

// Flag-gated hardening (audit L1/L2/D1). OFF (default/shipped) = byte-
// identical to today's LinkedIn scraper (empirically: 100 posts/~193s
// with valid cookies). SCRAPER_STRICT_EMPTY=true per-host activates:
// a block/checkpoint throws (→ cooldown + 'blocked'/'dom_changed'
// metric) instead of a silent successful 0-post scrape.
const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true';
```

- [ ] **Step 4: D4 — fix the sameSite mapping** in `loadCookies`. Replace exactly:

```js
            sameSite: c.sameSite === 'no_restriction' ? 'None'
                : c.sameSite === 'strict' ? 'Strict'
                : c.sameSite === 'lax' ? 'Lax'
                : c.sameSite || 'Lax',
```

with:

```js
            // Playwright only accepts Strict|Lax|None. 'unspecified' (and
            // any other value) MUST fall back to 'Lax' — passing the raw
            // string through made addCookies reject it, silently dropping
            // ~40% of the cookie jar (live: 14/24 injected). Safe-by-default.
            sameSite: c.sameSite === 'no_restriction' ? 'None'
                : c.sameSite === 'strict' ? 'Strict'
                : c.sameSite === 'lax' ? 'Lax'
                : 'Lax',
```

- [ ] **Step 5: L5 — fix the stale banner.** Replace exactly:

```js
    logProgress('LinkedIn', '🚀 LinkedIn Post Scraper (CDP Method)\n');
```

with:

```js
    logProgress('LinkedIn', '🚀 LinkedIn Post Scraper (CloakBrowser + cookie auth)\n');
```

- [ ] **Step 6: D1/L2 — gated detection in `navigateToSearch`.** That function ends with the `pageInfo` evaluate + the `if (!pageInfo.hasResults && !pageInfo.hasFeed) { ... dumpDebugSnapshot(page, 'no-container'); }` block. Immediately AFTER that `if` block (before the function's closing `}`), insert:

```js
    // D1/L2: the hasResults/hasFeed check above keys off pre-May-2026
    // selectors and false-positives on every healthy run — it cannot
    // tell a real block from a good page. In STRICT mode, classify the
    // page off the LIVE signal and throw on a genuine block/auth-wall so
    // it is loud (cooldown + classified metric) instead of flowing to a
    // silent successful 0-post scrape. OFF = legacy behavior untouched.
    if (STRICT) {
        const html = await page.content().catch(() => '');
        const state = linkedinPageState(html, page.url(), pageInfo.title);
        if (state === 'challenge') {
            assertNotBlocked({ status: null, finalUrl: page.url(), title: pageInfo.title, html, platform: 'linkedin' });
        }
        if (state === 'auth_wall') {
            throw new Error('LinkedIn auth-wall / checkpoint after search navigation (cookies likely expired)');
        }
    }
```

- [ ] **Step 7: L1 — gated loud 0-posts + `{jobs,emptyConfirmed}` return.** The success tail of `scrapeLinkedIn` reads:

```js
        // Report success against THIS lease (not the platform name).
        loginSuccess = true;
        await lease.reportSuccess(`Scraped ${normalizedPosts.length} posts successfully`);

        return normalizedPosts;
```

Replace with:

```js
        // L1: 0 posts is NOT automatically success. In STRICT mode, if
        // nothing was extracted and the page didn't positively show a
        // LinkedIn "no results" state, treat it as a suspected silent
        // block / DOM change and fail loudly (classified metric +
        // cooldown via the catch below) rather than reportSuccess([]).
        let emptyConfirmed = false;
        if (normalizedPosts.length === 0) {
            const html = await page.content().catch(() => '');
            const state = linkedinPageState(html, page.url(), '');
            emptyConfirmed = state === 'no_results';
            if (STRICT && !emptyConfirmed) {
                throw new DomChangedError(
                    `LinkedIn returned 0 posts and no "no results" marker (page state: ${state}) — suspected silent block / DOM change`,
                    { platform: 'linkedin' },
                );
            }
        }

        // Report success against THIS lease (not the platform name).
        loginSuccess = true;
        await lease.reportSuccess(`Scraped ${normalizedPosts.length} posts successfully`);

        // BaseScraper (Plan 1A) accepts Array OR { jobs, emptyConfirmed }.
        // emptyConfirmed only when LinkedIn positively showed no-results;
        // behavior-neutral for the jobs payload when OFF.
        return { jobs: normalizedPosts, emptyConfirmed: emptyConfirmed && normalizedPosts.length === 0 };
```

- [ ] **Step 8: Run** `node --test test/scrapers/linkedin-page-state.test.js` → all pass (8 helper + 6 guards). `npm test` → `fail 0`.

- [ ] **Step 9: Inertness probe** — run exactly:

`node -e "const s=require('node:fs').readFileSync('scrapers/linkedin.js','utf8'); const m=[...s.matchAll(/assertNotBlocked\s*\(/g)]; console.log(m.length>0 && m.every(x=>/if\s*\(\s*STRICT\s*\)/.test(s.slice(x.index-500,x.index)))?'OK gated':'FAIL'); console.log(/process\.env\.SCRAPER_STRICT_EMPTY/.test(s)?'OK strict':'FAIL'); console.log(!/CDP Method/.test(s)?'OK banner':'FAIL'); console.log(!/:\s*c\.sameSite\s*\|\|\s*'Lax'/.test(s)?'OK samesite':'FAIL');"`

Expected: `OK gated` / `OK strict` / `OK banner` / `OK samesite`. If any FAIL, fix.

- [ ] **Step 10: Commit**

```bash
git add scrapers/linkedin.js test/scrapers/linkedin-page-state.test.js
git commit -m "feat(linkedin): flag-gated block/no-results detection + D4 cookie fix + L5 (strict OFF = inert)

assertNotBlocked + linkedinPageState wired STRICT-gated (L1/L2/D1);
sameSite always Strict|Lax|None (D4, was dropping ~40% of cookies);
banner fixed (L5). Returns {jobs,emptyConfirmed}. OFF = byte-identical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Verification — static + EMPIRICAL double re-run

**Files:** Create `docs/superpowers/plans/2026-05-18-phase1c-linkedin-NOTES.md`

- [ ] **Step 1:** `npm test` → `fail 0`. Record pass count.

- [ ] **Step 2:** `git diff origin/main -- scrapers/ ':!scrapers/linkedin.js'` and `-- src/` → BOTH empty (only linkedin.js + its test changed). If not, BLOCKED.

- [ ] **Step 3:** Inertness probe (Task 2 Step 9 command) → `OK gated`/`OK strict`/`OK banner`/`OK samesite`.

- [ ] **Step 4: EMPIRICAL OFF re-run (byte-identical guarantee).** Create temp `_li_v.mjs`:

```js
const { scrapeLinkedIn } = await import('./scrapers/linkedin.js');
const t=Date.now();
try { const r = await scrapeLinkedIn('DevOps Engineer','United States','verify-off',{});
  console.log(`OFF: outcome=array len=${Array.isArray(r)?r.length:(r&&r.jobs?r.jobs.length:'?')} secs=${((Date.now()-t)/1000)|0}`); }
catch(e){ console.log(`OFF: THREW ${e.name}: ${e.message}`); }
process.exit(0);
```

Run: `node _li_v.mjs 2>&1 | grep -E 'cookies injected|Already logged|OFF:'` (timeout 600s). EXPECTED: `SCRAPER_STRICT_EMPTY` unset → **~24/24 cookies injected** (D4 fixed, was 14/24), "Already logged in", `OFF: outcome=array len≈100` (still scrapes, byte-identical jobs payload). The earlier false "no container" log line still appears when OFF (legacy path intentionally untouched) — acceptable.

- [ ] **Step 5: EMPIRICAL ON re-run (fix active, still scrapes).** Run: `SCRAPER_STRICT_EMPTY=true node _li_v.mjs 2>&1 | grep -E 'cookies injected|Already logged|No recognizable|OFF:'`. EXPECTED: still "Already logged in", `OFF: outcome=array len≈100` (valid cookies → still scrapes with detection ON), and it does NOT throw (healthy page classified `results`, not a false block). Then `rm -f _li_v.mjs` (must NOT be committed).

- [ ] **Step 6: Notes** — create `docs/superpowers/plans/2026-05-18-phase1c-linkedin-NOTES.md`:

```markdown
# Phase 1C-LinkedIn — completion notes
Status: COMPLETE. npm test fail 0. Empirically re-verified with real cookies:
OFF → ~24/24 cookies (D4 fixed), logged in, ~100 posts (byte-identical jobs).
ON  → still ~100 posts, healthy page classified 'results' (no false block);
a real block/auth-wall now throws (cooldown + classified metric) instead
of silent reportSuccess([]) (L1/L2/D1 fixed).
Delivered: linkedinPageState helper; STRICT-gated assertNotBlocked + 0-posts
DomChangedError throw; D4 sameSite always Strict|Lax|None; L5 banner;
{jobs,emptyConfirmed} return. OFF byte-identical (inertness probe OK).
Deferred follow-ups (enhancements, not safety): D2 post-permalink recovery
(NEW search DOM has none — url falls back to author profile), D3 scroll-
volume/incremental-scroll (currently ~60 scrolls/193s), L10 module-global
CONFIG race, locale/timezone hardcoding vs cookie tz.
config/credentials.json holds the user's LinkedIn cookies LOCALLY only
(git-ignored, never committed, untracked — verify `git check-ignore`).
```

- [ ] **Step 7: Commit** (NOTES only):

```bash
git add docs/superpowers/plans/2026-05-18-phase1c-linkedin-NOTES.md
git commit -m "docs(plan): Phase 1C-LinkedIn completion + empirical re-verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review
- **Spec:** L1 (0-posts loud, STRICT) Task2 S7 ✓; L2/D1 (live-signal classify + assertNotBlocked, STRICT) Task1+Task2 S6 ✓; D4 (sameSite) S4 ✓; L5 (banner) S5 ✓; `{jobs,emptyConfirmed}` S7 ✓; empirical OFF+ON re-run Task3 ✓. D2/D3/L10/locale explicitly deferred in NOTES (enhancements) — not gaps.
- **Placeholders:** none — exact before/after for every code step; exact commands+expected; the browser flow is covered by pure-helper unit tests + static gating guards + the empirical double re-run (the highest-fidelity check, which the user specifically wants).
- **Names:** `STRICT`, `linkedinPageState`, `assertNotBlocked`, `DomChangedError`, `emptyConfirmed`, `return { jobs: normalizedPosts, emptyConfirmed` — consistent across tasks and match Plan 1A exports.
- **Scope:** one scraper file + its test; OFF provably byte-identical (static probe + empirical OFF run both required to pass). Safe to ship with the flag off; user flips one env var to activate.
