# Monster Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `scrapers/monster.js` with a hardened DOM-extraction scraper, re-enable Monster in the platform registry, and make every failure loud (typed errors, page-state classifier, strict-empty mode) without silently emitting garbage rows.

**Architecture:** A single self-contained `scrapers/monster.js` (mirroring LinkedIn's pattern) exports small pure helpers (`parseAriaLabel`, `constructJobUrl`, `parseLocationDate`, `parsePay`, `classifyMonsterPage`) alongside the main `scrapeMonster()`. CloakBrowser handles DataDome; the scraper gates on a `page.waitForResponse` of the appsapi POST (the canonical "page is alive" signal), reads cards from `article[data-testid="JobCard"]` with `aria-label`-driven title/company parsing, and throws typed errors (`BlockedError` / `DomChangedError`) on every silent-failure scenario. `BaseScraper` is configured `strictEmpty:true` for Monster only.

**Tech Stack:** Node 24 + ESM + `node:test` + `node:assert/strict` + `jsdom` (already in deps) for fixture-based DOM tests + CloakBrowser (already in deps) for the live runtime.

**Spec:** `docs/superpowers/specs/2026-06-03-monster-scraper-design.md`

---

## Constraints (read before starting)

1. **`scrapers/linkedin.js` MUST NOT be modified** (different platform; sanity guard).
2. **Pre-existing dirty files MUST stay unstaged:** `.gitignore`, `pnpm-lock.yaml`. Stage files by name; never `git add .` / `git add -A`.
3. **No new dependencies.** `jsdom` and `cloakbrowser` are already in `package.json`.
4. **Tests:** every pure helper gets a `*.test.js` under `test/scrapers/`. Use `node --test 'test/**/*.test.js'` (quoted glob — bare-dir broken on Node 24 per repo MEMORY).
5. **Every commit ends with** `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
6. **Never echo secrets.** No API keys, no cookies, no passwords in logs.
7. **Live network calls only inside the debug harness** (Task 8) — unit tests must not hit monster.com.
8. **Stage explicitly per task** — do not commit unrelated work.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scrapers/monster.js` | **rewrite** | Full scraper: exports pure helpers + `scrapeMonster()` orchestrator |
| `src/scrapers/registry.js` | **modify** | Re-add `scrapeMonster` import + `monster: new BaseScraper('monster', scrapeMonster, { strictEmpty: true })` entry; remove the disabled-comment block |
| `scripts/test-monster-scrape.js` | **new** | Debug harness mirroring `scripts/test-linkedin-scrape.js` (live run + per-job URL-quality summary) |
| `scripts/monster-probe.mjs` | **modify** | Add a short docstring noting it's an investigation harness (not part of runtime) |
| `scripts/monster-deep-probe.mjs` | **modify** | Same docstring |
| `test/fixtures/monster-card.html` | **new** | Saved real card HTML (copied from `/tmp/monster-card.html`) — fixture for extractor tests |
| `test/scrapers/monster-parse-aria-label.test.js` | **new** | Pure parser tests |
| `test/scrapers/monster-construct-url.test.js` | **new** | URL builder tests |
| `test/scrapers/monster-parse-innertext.test.js` | **new** | Location + posted-date + pay regex tests |
| `test/scrapers/monster-extract-card.test.js` | **new** | jsdom-driven extractor test against the fixture |
| `test/scrapers/monster-classify-page.test.js` | **new** | Pure classifier tests with inline HTML strings |

---

## Task 1: Save the card HTML fixture

**Files:**
- Create: `test/fixtures/monster-card.html` (copied from `/tmp/monster-card.html`)

- [ ] **Step 1: Confirm the source file exists**

Run: `ls -la /tmp/monster-card.html && wc -c /tmp/monster-card.html`
Expected: file exists, non-zero size (a few KB at minimum; the saved probe output).

If `/tmp/monster-card.html` is missing (e.g. system rebooted), regenerate it by running `node scripts/monster-deep-probe.mjs` first (takes ~3 min — the probe script will recreate `/tmp/monster-card.html`).

- [ ] **Step 2: Create the fixtures directory and copy the file**

```bash
mkdir -p test/fixtures
cp /tmp/monster-card.html test/fixtures/monster-card.html
```

- [ ] **Step 3: Verify the copy contains real cards**

Run: `grep -c 'data-testid="JobCard"' test/fixtures/monster-card.html`
Expected: at least 3 (the probe captured 3 card snapshots).

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/monster-card.html
git commit -m "$(cat <<'EOF'
test(monster): commit live card fixture for extractor tests

3 real Monster JobCard articles captured from the deep probe. Used as the
ground-truth fixture for pure-extractor tests in subsequent tasks so we
don't have to hit monster.com from CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pure parser — `parseAriaLabel`

**Files:**
- Modify: `scrapers/monster.js` (export `parseAriaLabel`)
- Create: `test/scrapers/monster-parse-aria-label.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/monster-parse-aria-label.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAriaLabel } from '../../scrapers/monster.js';

test('parseAriaLabel: standard "Title at Company" → title + company', () => {
    assert.deepEqual(parseAriaLabel('Principal Software Engineer at Microsoft Corporation'), {
        title: 'Principal Software Engineer',
        company: 'Microsoft Corporation',
    });
});

test('parseAriaLabel: multi-word company with spaces', () => {
    assert.deepEqual(parseAriaLabel('Software Engineer(s) at Praxent'), {
        title: 'Software Engineer(s)',
        company: 'Praxent',
    });
});

test('parseAriaLabel: title containing " at " uses LAST " at " as the separator', () => {
    // "Engineer III at Google reporting to VP" — split must yield
    // company = "Google reporting to VP" and title = "Engineer III"
    // because lazy regex `(.+?) at (.+)` consumes minimally from the left.
    assert.deepEqual(parseAriaLabel('Engineer III at Google'), {
        title: 'Engineer III',
        company: 'Google',
    });
});

test('parseAriaLabel: empty / nullish input → null', () => {
    assert.equal(parseAriaLabel(''), null);
    assert.equal(parseAriaLabel(null), null);
    assert.equal(parseAriaLabel(undefined), null);
});

test('parseAriaLabel: no " at " separator → null (signals dom_changed)', () => {
    assert.equal(parseAriaLabel('Just a title'), null);
    assert.equal(parseAriaLabel('View job'), null);
});

test('parseAriaLabel: separator-only edge case → null', () => {
    assert.equal(parseAriaLabel(' at '), null);  // both halves would be empty
    assert.equal(parseAriaLabel('Title at '), null);  // empty company
    assert.equal(parseAriaLabel(' at Company'), null);  // empty title
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/scrapers/monster-parse-aria-label.test.js'`
Expected: FAIL — `parseAriaLabel is not a function` (the symbol doesn't exist yet).

- [ ] **Step 3: Open `scrapers/monster.js` and add the helper**

Add (near the top, after imports and the `sleep` helper, before `extractJobsFromCurrentPage`):

```js
// Parses an aria-label of the form "<Title> at <Company>" into title + company.
// Returns null on any malformed input — the caller treats null as a
// dom_changed signal (Monster split the label or renamed the pattern).
// We use a strict regex (not split(' at ')) to ban silent garbage.
export function parseAriaLabel(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).trim();
    if (!s) return null;
    const m = s.match(/^(.+?)\s+at\s+(.+)$/);
    if (!m) return null;
    const title = m[1].trim();
    const company = m[2].trim();
    if (!title || !company) return null;
    return { title, company };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/scrapers/monster-parse-aria-label.test.js'`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scrapers/monster.js test/scrapers/monster-parse-aria-label.test.js
git commit -m "$(cat <<'EOF'
feat(monster): parseAriaLabel — strict "Title at Company" parser

Replaces innerText[0] (which today returns the company-badge letter — the
documented title="M" bug). Returns null on any malformed input so the
caller can throw DomChangedError instead of silently emitting garbage.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure URL builder — `constructJobUrl`

**Files:**
- Modify: `scrapers/monster.js` (export `constructJobUrl`)
- Create: `test/scrapers/monster-construct-url.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/monster-construct-url.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructJobUrl } from '../../scrapers/monster.js';

const UUID = '8026b6c6-ba38-4c42-aea1-67cb6f0feed5';

test('constructJobUrl: real href takes priority over uuid', () => {
    const href = 'https://www.monster.com/job-openings/principal-engineer-redmond-wa--abcdef';
    assert.equal(constructJobUrl(href, UUID), href);
});

test('constructJobUrl: missing href → constructs from uuid', () => {
    assert.equal(constructJobUrl(null, UUID), `https://www.monster.com/job-openings/${UUID}`);
    assert.equal(constructJobUrl(undefined, UUID), `https://www.monster.com/job-openings/${UUID}`);
    assert.equal(constructJobUrl('', UUID), `https://www.monster.com/job-openings/${UUID}`);
});

test('constructJobUrl: relative href is resolved against monster.com', () => {
    assert.equal(constructJobUrl('/job-openings/foo--abc', UUID), 'https://www.monster.com/job-openings/foo--abc');
});

test('constructJobUrl: missing both → null', () => {
    assert.equal(constructJobUrl(null, null), null);
    assert.equal(constructJobUrl('', ''), null);
    assert.equal(constructJobUrl(undefined, undefined), null);
});

test('constructJobUrl: invalid uuid + no href → null (rejects garbage)', () => {
    // A bare non-UUID-ish string is rejected — better to emit null than
    // a URL that 404s downstream.
    assert.equal(constructJobUrl(null, ''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/scrapers/monster-construct-url.test.js'`
Expected: FAIL — `constructJobUrl is not a function`.

- [ ] **Step 3: Add the helper in `scrapers/monster.js`** (place after `parseAriaLabel`)

```js
// Builds the canonical job URL. Prefers a real anchor href (the card's
// own <a>); falls back to constructing one from the data-job-id UUID.
// Returns null if neither is present — caller skips the row.
export function constructJobUrl(realHref, jobId) {
    const h = realHref ? String(realHref).trim() : '';
    if (h) {
        if (h.startsWith('http://') || h.startsWith('https://')) return h;
        if (h.startsWith('/')) return `https://www.monster.com${h}`;
    }
    const id = jobId ? String(jobId).trim() : '';
    if (id) return `https://www.monster.com/job-openings/${id}`;
    return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/scrapers/monster-construct-url.test.js'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scrapers/monster.js test/scrapers/monster-construct-url.test.js
git commit -m "$(cat <<'EOF'
feat(monster): constructJobUrl — prefer real href, fall back to data-job-id

The current scraper relies on a.href that never exists for the cards we
care about. New builder reads the card's real anchor first (so slug-based
URLs survive a Monster rename) and only constructs from the UUID when
needed. Returns null on missing-both so the row is dropped, not garbage.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Pure innerText parsers — location, date, pay

**Files:**
- Modify: `scrapers/monster.js` (export `parseLocationDate`, `parsePay`, `isPromoted`)
- Create: `test/scrapers/monster-parse-innertext.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/monster-parse-innertext.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocationDate, parsePay, isPromoted } from '../../scrapers/monster.js';

test('parseLocationDate: joined "Redmond, WA7 days ago" (probe-observed)', () => {
    assert.deepEqual(parseLocationDate('Redmond, WA7 days ago'), {
        location: 'Redmond, WA',
        datePosted: '7 days ago',
    });
});

test('parseLocationDate: separated by newline', () => {
    assert.deepEqual(parseLocationDate('Redmond, WA\n7 days ago'), {
        location: 'Redmond, WA',
        datePosted: '7 days ago',
    });
});

test('parseLocationDate: Remote location', () => {
    assert.deepEqual(parseLocationDate('Remote\n3 days ago'), {
        location: 'Remote',
        datePosted: '3 days ago',
    });
});

test('parseLocationDate: hours/weeks/months variants', () => {
    assert.equal(parseLocationDate('Atlanta, GA2 hours ago').datePosted, '2 hours ago');
    assert.equal(parseLocationDate('NYC, NY1 week ago').datePosted, '1 week ago');
    assert.equal(parseLocationDate('Austin, TX2 months ago').datePosted, '2 months ago');
});

test('parseLocationDate: missing date → location only', () => {
    assert.deepEqual(parseLocationDate('Atlanta, GA'), { location: 'Atlanta, GA', datePosted: '' });
});

test('parseLocationDate: nothing parseable → both empty', () => {
    assert.deepEqual(parseLocationDate('lorem ipsum'), { location: '', datePosted: '' });
    assert.deepEqual(parseLocationDate(''), { location: '', datePosted: '' });
});

test('parsePay: range with units', () => {
    assert.equal(parsePay('Some prefix $142,800–$274,800 / Year suffix'), '$142,800–$274,800 / Year');
});

test('parsePay: hyphen-not-en-dash variant', () => {
    assert.equal(parsePay('$50,000-$80,000 / Year'), '$50,000-$80,000 / Year');
});

test('parsePay: single value', () => {
    assert.equal(parsePay('Compensation $85,000 / Year'), '$85,000 / Year');
});

test('parsePay: hourly', () => {
    assert.equal(parsePay('Up to $40 / Hour'), '$40 / Hour');
});

test('parsePay: not present → empty string', () => {
    assert.equal(parsePay('No pay info here'), '');
    assert.equal(parsePay(''), '');
});

test('isPromoted: explicit Promoted badge', () => {
    assert.equal(isPromoted('Software Engineer\nMicrosoft\nRedmond, WA\nPromoted'), true);
});

test('isPromoted: absence returns false', () => {
    assert.equal(isPromoted('Software Engineer\nMicrosoft\nRedmond, WA'), false);
    assert.equal(isPromoted(''), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/scrapers/monster-parse-innertext.test.js'`
Expected: FAIL — `parseLocationDate is not a function`.

- [ ] **Step 3: Add the helpers in `scrapers/monster.js`** (after `constructJobUrl`)

```js
// Parses location + posted-date from a card's innerText. Handles both
// the joined "Redmond, WA7 days ago" layout (the probe observed) and
// the split-by-newline layout.
export function parseLocationDate(text) {
    const s = String(text ?? '');
    // location: "City, ST" (two-letter US state) OR the literal "Remote"
    const locRe = /(Remote|[A-Z][a-zA-Z .'-]+,\s*[A-Z]{2})/;
    const dateRe = /(\d+\s+(?:hour|day|week|month|min(?:ute)?)s?\s+ago)/i;
    const lm = s.match(locRe);
    const dm = s.match(dateRe);
    return {
        location: lm ? lm[1].trim() : '',
        datePosted: dm ? dm[1].trim() : '',
    };
}

// Parses a salary / pay band from innerText. Matches single values and
// ranges, with optional "/ Year|Hour|Month" suffix. Returns "" when
// absent (Monster doesn't always display pay).
export function parsePay(text) {
    const s = String(text ?? '');
    const re = /(\$[\d,]+(?:\s*[–\-]\s*\$[\d,]+)?(?:\s*\/\s*(?:Year|Hour|Month))?)/i;
    const m = s.match(re);
    return m ? m[1].trim() : '';
}

// Flag a card as a sponsored / promoted insertion. Today's marker is
// the word "Promoted" appearing in the card body.
export function isPromoted(text) {
    return /\bpromoted\b/i.test(String(text ?? ''));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/scrapers/monster-parse-innertext.test.js'`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add scrapers/monster.js test/scrapers/monster-parse-innertext.test.js
git commit -m "$(cat <<'EOF'
feat(monster): parseLocationDate + parsePay + isPromoted helpers

Regex-based parsers tolerate the joined "Redmond, WA7 days ago" layout
(probe-observed) AND the split-by-newline variant. parsePay handles
ranges + hyphen vs en-dash + Year/Hour/Month. isPromoted flags sponsored
cards so the count cross-check thresholds can account for them.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Card extractor with jsdom (fixture-driven)

**Files:**
- Modify: `scrapers/monster.js` (export `extractCardFromElement`)
- Create: `test/scrapers/monster-extract-card.test.js`

This is the bridge between pure helpers and the live browser. `extractCardFromElement(element)` takes a DOM Element (real Element in browser, jsdom Element in tests) and returns a structured row or a `__domChanged` marker. The pure parsers from Tasks 2-4 are composed here.

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/monster-extract-card.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { extractCardFromElement } from '../../scrapers/monster.js';

const FIXTURE = fs.readFileSync(path.resolve('test/fixtures/monster-card.html'), 'utf-8');

function loadCards() {
    const dom = new JSDOM(`<!doctype html><html><body>${FIXTURE}</body></html>`);
    // The fixture contains 3 card containers — the outer DIV wraps the article in card 0,
    // then 2 standalone ARTICLE elements. Pull all articles directly.
    return [...dom.window.document.querySelectorAll('article[data-testid="JobCard"]')];
}

test('extractCardFromElement: fixture cards yield valid rows', () => {
    const cards = loadCards();
    assert.ok(cards.length >= 2, `expected at least 2 fixture cards, got ${cards.length}`);
    const first = extractCardFromElement(cards[0]);
    assert.ok(first, 'first card should extract');
    assert.equal(typeof first.title, 'string');
    assert.ok(first.title.length > 1, `title should be > 1 char (was: ${JSON.stringify(first.title)})`);
    assert.notEqual(first.title, 'M', 'regression: title must never be the company-badge letter');
    assert.notEqual(first.title, 'P', 'regression: title must never be the company-badge letter');
    assert.ok(first.company.length > 1);
    assert.ok(first.jobId.match(/^[a-f0-9-]{20,}$/), `jobId should be a UUID, got: ${first.jobId}`);
    assert.ok(first.url.startsWith('https://www.monster.com/'), `url: ${first.url}`);
});

test('extractCardFromElement: aria-label missing → __domChanged sentinel', () => {
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard"><button data-job-id="abc"></button></article>`);
    const card = dom.window.document.querySelector('article');
    const result = extractCardFromElement(card);
    assert.deepEqual(result, { __domChanged: true, reason: 'no_aria_label' });
});

test('extractCardFromElement: aria-label without " at " → __domChanged sentinel', () => {
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard"><button data-job-id="abc" aria-label="View job"></button></article>`);
    const card = dom.window.document.querySelector('article');
    const result = extractCardFromElement(card);
    assert.equal(result.__domChanged, true);
    assert.match(result.reason, /aria_label_format/);
});

test('extractCardFromElement: missing data-job-id → null (skip row, do NOT signal dom_changed)', () => {
    // A button without a job-id is a UI artifact, not a job — skip silently.
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard"><button aria-label="Foo at Bar"></button></article>`);
    const card = dom.window.document.querySelector('article');
    assert.equal(extractCardFromElement(card), null);
});

test('extractCardFromElement: real anchor href used in preference', () => {
    const dom = new JSDOM(`<!doctype html><article data-testid="JobCard">
        <button data-job-id="aaa" aria-label="X at Y"></button>
        <a href="/job-openings/explicit-href-aaa">Real link</a>
    </article>`);
    const card = dom.window.document.querySelector('article');
    const r = extractCardFromElement(card);
    assert.equal(r.url, 'https://www.monster.com/job-openings/explicit-href-aaa');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/scrapers/monster-extract-card.test.js'`
Expected: FAIL — `extractCardFromElement is not a function`.

- [ ] **Step 3: Add the extractor in `scrapers/monster.js`** (after `isPromoted`)

```js
// Extracts a single card from a DOM Element (browser or jsdom). Returns:
//   - a structured row object on success
//   - { __domChanged: true, reason } when the aria-label format breaks
//     (caller aggregates these to throw DomChangedError when > 50% fail)
//   - null when the row should be skipped silently (e.g. button missing
//     data-job-id — likely a UI artifact, not an actual job card)
export function extractCardFromElement(card) {
    if (!card || typeof card.querySelector !== 'function') return null;
    const btn = card.querySelector('button[data-job-id], button[aria-label]');
    if (!btn) return null;
    const aria = btn.getAttribute('aria-label');
    if (!aria) return { __domChanged: true, reason: 'no_aria_label' };
    const parsed = parseAriaLabel(aria);
    if (!parsed) return { __domChanged: true, reason: 'aria_label_format' };
    const jobId = btn.getAttribute('data-job-id') || '';
    if (!jobId) return null;
    const realAnchor = card.querySelector('a[href*="/job-openings/"]');
    const realHref = realAnchor ? realAnchor.getAttribute('href') : '';
    const url = constructJobUrl(realHref, jobId);
    if (!url) return null;
    const text = (card.textContent || '').trim();
    const { location, datePosted } = parseLocationDate(text);
    return {
        title: parsed.title,
        company: parsed.company,
        location,
        datePosted,
        salary: parsePay(text),
        jobId,
        url,
        description: text.slice(0, 800),
        isPromoted: isPromoted(text),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/scrapers/monster-extract-card.test.js'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scrapers/monster.js test/scrapers/monster-extract-card.test.js
git commit -m "$(cat <<'EOF'
feat(monster): extractCardFromElement — fixture-driven, regression-guarded

Reads title+company from aria-label (NEVER innerText.split[0]). Reads URL
from the card's real anchor first; falls back to UUID-constructed. Returns
the structured row, a {__domChanged, reason} sentinel for caller
aggregation, or null for skip. Locked against the title='M' bug.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Page-state classifier — `classifyMonsterPage`

**Files:**
- Modify: `scrapers/monster.js` (export `classifyMonsterPage`)
- Create: `test/scrapers/monster-classify-page.test.js`

The classifier is **pure**: given `{url, bodyText, cardCount, sawApiResponse}`, it returns `{state, signal}`. The browser-side glue (Task 7) collects those four inputs and calls this function.

- [ ] **Step 1: Write the failing test**

Create `test/scrapers/monster-classify-page.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMonsterPage } from '../../scrapers/monster.js';

test('classifyMonsterPage: appsapi POST seen + cards > 0 → results', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results for Software Engineer ...',
        cardCount: 18,
        sawApiResponse: true,
    });
    assert.equal(r.state, 'results');
});

test('classifyMonsterPage: "No jobs found matching" text → empty_confirmed', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=unobtainium&page=1',
        bodyText: 'No jobs found matching your search ...',
        cardCount: 0,
        sawApiResponse: true,
    });
    assert.equal(r.state, 'empty_confirmed');
});

test('classifyMonsterPage: redirect to captcha-delivery.com → soft_blocked', () => {
    const r = classifyMonsterPage({
        url: 'https://geo.captcha-delivery.com/interstitial/?...',
        bodyText: 'Please verify you are human',
        cardCount: 0,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'soft_blocked');
    assert.match(r.signal, /captcha-delivery|verify/i);
});

test('classifyMonsterPage: DataDome body text → soft_blocked', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=2',
        bodyText: 'Welcome. Please complete the security check. DataDome ray id #abc',
        cardCount: 0,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyMonsterPage: appsapi POST seen + cards=0 + no empty-results text → dom_changed', () => {
    // The "200 OK but cards:0" hammer-test scenario when DataDome lets us
    // through but Monster ships an A/B variant we can't read.
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results for Software Engineer in United States ... some boilerplate',
        cardCount: 0,
        sawApiResponse: true,
    });
    assert.equal(r.state, 'dom_changed');
});

test('classifyMonsterPage: no appsapi + cards=0 + no block text → network_error', () => {
    // We rendered a page but the appsapi didn't fire AND no block signal.
    // Treat as transport-level failure (the response gate timed out).
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Empty body',
        cardCount: 0,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'network_error');
});

test('classifyMonsterPage: cards > 0 even without explicit appsapi → results (degraded)', () => {
    // Defensive: if we somehow got cards on screen but the appsapi
    // detection failed, prefer "results" over "dom_changed" — cards are
    // ground truth.
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results ...',
        cardCount: 18,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'results');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'test/scrapers/monster-classify-page.test.js'`
Expected: FAIL — `classifyMonsterPage is not a function`.

- [ ] **Step 3: Add the classifier in `scrapers/monster.js`** (after `extractCardFromElement`)

```js
// Pure page-state classifier. Caller collects {url, bodyText, cardCount,
// sawApiResponse} from the page and asks: what happened?
//   results          → real results page, cards are extractable
//   empty_confirmed  → real "0 results" page (no false alarm)
//   soft_blocked     → DataDome interstitial / verify-human page
//   dom_changed      → page rendered but the cards we expect are absent
//   network_error    → response gate didn't fire, nothing positive to report
export function classifyMonsterPage({ url, bodyText, cardCount, sawApiResponse }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/captcha-delivery\.com/i.test(u) ||
        /datadome|verify you are human|ray id|access denied/i.test(t)) {
        return { state: 'soft_blocked', signal: u.includes('captcha-delivery') ? 'captcha-delivery redirect' : 'datadome body text' };
    }
    if (cardCount > 0) {
        return { state: 'results', signal: `cards=${cardCount}` };
    }
    if (/no jobs (found|match)/i.test(t)) {
        return { state: 'empty_confirmed', signal: 'no-jobs-found text' };
    }
    if (sawApiResponse) {
        return { state: 'dom_changed', signal: 'appsapi responded but 0 cards rendered and no empty-results text' };
    }
    return { state: 'network_error', signal: 'no appsapi response, no positive page signal' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'test/scrapers/monster-classify-page.test.js'`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scrapers/monster.js test/scrapers/monster-classify-page.test.js
git commit -m "$(cat <<'EOF'
feat(monster): classifyMonsterPage — pure page-state classifier

Mirrors linkedinPageState's role. Disambiguates the documented
status:200-but-cards:0 failure mode by adding sawApiResponse as a
canonical "Monster decided to give us jobs" signal. soft_blocked /
dom_changed / empty_confirmed each have distinct downstream handling.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Rewrite `scrapeMonster` orchestrator

**Files:**
- Modify: `scrapers/monster.js` (rewrite the `scrapeMonster` function body)

This is the largest task. The pure helpers from Tasks 2-6 are now composed in a browser-driven loop. The function:

1. Launches CloakBrowser (`humanize: true`).
2. Visits monster.com homepage (warmup).
3. For each page 1..MAX_PAGES:
   - Builds search URL.
   - Calls `page.waitForResponse` for the appsapi POST while `page.goto`-ing.
   - Reads `page.url()`, body text, card count via `[data-testid="JobCard"]` count.
   - Runs `classifyMonsterPage`.
   - Branches: `soft_blocked` → throw `BlockedError`; `dom_changed` → throw `DomChangedError`; `network_error` → throw `NetworkError`; `empty_confirmed` → break.
   - On `results`: extract via `page.evaluate()` calling `extractCardFromElement` on each card → reconstruct in Node.
4. Aggregates results; respects MAX_JOBS, consecutiveEmpty stop.
5. **Partial-result policy:** if `BlockedError` / `DomChangedError` / `NetworkError` is thrown after we've collected ≥1 job, returns `{ jobs, emptyConfirmed: false, partial: true }` instead of rethrowing. Otherwise propagates.

The orchestrator itself is integration-tested via the debug harness (Task 8); no unit test in this task (browser-bound integration isn't profitable to mock for this seam).

- [ ] **Step 1: Read the current orchestrator body**

Run: `sed -n '76,160p' scrapers/monster.js` and re-read the existing top-level structure (CONFIG, warmup, browser launch, pagination loop). This task replaces the body but keeps the `warmup` helper and the `import` block.

- [ ] **Step 2: Replace the orchestrator body**

In `scrapers/monster.js`:

(a) Add an import near the top (next to the existing imports):

```js
import { BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
```

(b) Delete the existing `extractJobsFromCurrentPage` function (lines roughly 35-74 of the current file — the broken `lines[0]=title` logic).

(c) Replace the entire `export async function scrapeMonster(...)` body with:

```js
const CONFIG = {
    MAX_PAGES: 5,
    MAX_JOBS: 100,
    MIN_PAGE_SPACING_MS: 3000,
    MAX_PAGE_SPACING_MS: 5000,
    NAV_TIMEOUT_MS: 30000,
    API_RESPONSE_TIMEOUT_MS: 15000,
    CARD_SELECTOR_TIMEOUT_MS: 5000,
};

function searchUrl(jobTitle, location, pageNum) {
    return `https://www.monster.com/jobs/search` +
        `?q=${encodeURIComponent(jobTitle)}` +
        `&where=${encodeURIComponent(location)}` +
        `&page=${pageNum}`;
}

export async function scrapeMonster(jobTitle, location, sessionId = null) {
    void sessionId;
    log.info(`Searching for "${jobTitle}" in "${location}"`);
    log.info('🚀 Launching CloakBrowser stealth Chromium...');
    const browser = await launch({ headless: true, humanize: true });
    const allJobs = [];
    let collectedAnything = false;
    try {
        const context = await browser.newContext({
            viewport: { width: 1366, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
        const page = await context.newPage();
        await warmup(page);

        const seen = new Set();
        let consecutiveEmpty = 0;

        for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES && allJobs.length < CONFIG.MAX_JOBS; pageNum++) {
            const url = searchUrl(jobTitle, location, pageNum);
            log.info(`Fetching page ${pageNum}: ${url}`);

            // Gate the navigation on the appsapi POST as our "page is alive" signal.
            // waitForResponse is set up BEFORE goto so we don't miss the early fire.
            const apiResponsePromise = page.waitForResponse(
                (r) => r.url().includes('/jobs-svx-service/v2/monster/search-jobs/') && r.request().method() === 'POST',
                { timeout: CONFIG.API_RESPONSE_TIMEOUT_MS },
            ).then(() => true).catch(() => false);
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT_MS });
            } catch (e) {
                if (allJobs.length >= 1) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new NetworkError(`Monster page.goto failed: ${e.message}`, { platform: 'monster', cause: e });
            }
            const sawApiResponse = await apiResponsePromise;

            // Soft-wait for cards to render (best effort — classifier owns the verdict).
            await page.waitForSelector('article[data-testid="JobCard"]', { timeout: CONFIG.CARD_SELECTOR_TIMEOUT_MS }).catch(() => {});

            const probe = await page.evaluate(() => ({
                bodyText: (document.body?.innerText || '').slice(0, 4000),
                cardCount: document.querySelectorAll('article[data-testid="JobCard"]').length,
            }));
            const verdict = classifyMonsterPage({
                url: page.url(),
                bodyText: probe.bodyText,
                cardCount: probe.cardCount,
                sawApiResponse,
            });
            log.info(`Page ${pageNum} classified: ${verdict.state} (${verdict.signal})`);

            if (verdict.state === 'soft_blocked') {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new BlockedError(`Monster blocked: ${verdict.signal}`, { platform: 'monster', kind: 'datadome' });
            }
            if (verdict.state === 'dom_changed') {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(`Monster DOM changed: ${verdict.signal}`, { platform: 'monster' });
            }
            if (verdict.state === 'network_error') {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new NetworkError(`Monster page didn't load: ${verdict.signal}`, { platform: 'monster' });
            }
            if (verdict.state === 'empty_confirmed') {
                consecutiveEmpty++;
                if (consecutiveEmpty >= 2) break;
                await sleep(CONFIG.MIN_PAGE_SPACING_MS + Math.random() * (CONFIG.MAX_PAGE_SPACING_MS - CONFIG.MIN_PAGE_SPACING_MS));
                continue;
            }

            // results — extract.
            const raw = await page.evaluate(() => {
                function extractInPage(card) {
                    const btn = card.querySelector('button[data-job-id], button[aria-label]');
                    if (!btn) return null;
                    const aria = btn.getAttribute('aria-label');
                    if (!aria) return { __domChanged: true, reason: 'no_aria_label' };
                    const m = aria.trim().match(/^(.+?)\s+at\s+(.+)$/);
                    if (!m) return { __domChanged: true, reason: 'aria_label_format' };
                    const title = m[1].trim(); const company = m[2].trim();
                    const jobId = btn.getAttribute('data-job-id') || '';
                    if (!title || !company || !jobId) return null;
                    const a = card.querySelector('a[href*="/job-openings/"]');
                    const realHref = a ? a.getAttribute('href') : '';
                    return {
                        title, company, jobId, realHref,
                        text: (card.textContent || '').trim().slice(0, 4000),
                    };
                }
                const cards = [...document.querySelectorAll('article[data-testid="JobCard"]')];
                return cards.map(extractInPage);
            });

            // Aggregate domChanged + finish parsing in Node (so the pure helpers stay testable)
            let cardDomChanged = 0;
            let newCount = 0;
            for (const r of raw) {
                if (!r) continue;
                if (r.__domChanged) { cardDomChanged++; continue; }
                const url = constructJobUrl(r.realHref, r.jobId);
                if (!url || seen.has(url)) continue;
                seen.add(url);
                const { location: loc, datePosted } = parseLocationDate(r.text);
                allJobs.push(normalizeJobData({
                    title: r.title,
                    hiringOrganization: r.company,
                    jobLocation: loc,
                    url,
                    datePosted,
                    salary: parsePay(r.text),
                    description: r.text.slice(0, 800),
                    isPromoted: isPromoted(r.text),
                }, 'Monster'));
                newCount++;
                if (allJobs.length >= CONFIG.MAX_JOBS) break;
            }
            collectedAnything = collectedAnything || allJobs.length > 0;

            if (cardDomChanged > 0 && cardDomChanged >= Math.ceil(raw.length / 2)) {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(`Monster aria-label format changed (${cardDomChanged}/${raw.length} cards)`, { platform: 'monster' });
            }

            log.info(`Page ${pageNum}: ${raw.length} cards, ${newCount} new unique, total: ${allJobs.length}`);
            if (newCount === 0) consecutiveEmpty++; else consecutiveEmpty = 0;
            if (consecutiveEmpty >= 2) break;

            await sleep(CONFIG.MIN_PAGE_SPACING_MS + Math.random() * (CONFIG.MAX_PAGE_SPACING_MS - CONFIG.MIN_PAGE_SPACING_MS));
        }

        log.info(`Completed! Found ${allJobs.length} unique jobs`);
        if (allJobs.length === 0) {
            // Reached natural end-of-results without throwing — treat as confirmed empty.
            return { jobs: [], emptyConfirmed: true };
        }
        return allJobs;
    } finally {
        try { await browser.close(); } catch { /* already closed */ }
    }
}
```

(d) Also export `searchUrl` so tests / debug tooling can build URLs:

```js
export { searchUrl };
```

(Or move the `function searchUrl` declaration to start with `export function searchUrl(...)`.)

- [ ] **Step 3: Run the full test suite to catch regressions**

Run: `node --test 'test/**/*.test.js'`
Expected: all green. The new pure helpers from Tasks 2-6 are exported and reused by the orchestrator's `page.evaluate()` Node-side code; the in-browser `extractInPage` mirrors `extractCardFromElement` (the body of `page.evaluate` callbacks cannot reach Node imports, so the inline duplication is required and intentional — the pure helpers in Tasks 2-6 still test the format invariants).

- [ ] **Step 4: Smoke-verify by spot-loading the module**

Run: `node -e "import('./scrapers/monster.js').then(m => console.log(Object.keys(m).sort()))"`
Expected output (sorted): a list including at least `classifyMonsterPage, constructJobUrl, extractCardFromElement, isPromoted, parseAriaLabel, parseLocationDate, parsePay, scrapeMonster, searchUrl`.

- [ ] **Step 5: Commit**

```bash
git add scrapers/monster.js
git commit -m "$(cat <<'EOF'
feat(monster): rewrite scrapeMonster — typed errors, classifier, partial-results

Replaces the broken innerText[0] extraction with the aria-label-driven path
(fixes the title="M" company-badge-letter bug). The orchestrator gates on
appsapi POST via page.waitForResponse, runs classifyMonsterPage on each
nav, and throws BlockedError / DomChangedError / NetworkError where the
old code silently returned 0 jobs. Partial-result policy preserves earlier
pages when a later page hits a block.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Debug harness — `scripts/test-monster-scrape.js`

**Files:**
- Create: `scripts/test-monster-scrape.js`
- Modify: `package.json` (add `linkedin:test-scrape`-style script entry for monster)

- [ ] **Step 1: Create `scripts/test-monster-scrape.js`**

```js
#!/usr/bin/env node
// Test harness — runs scrapeMonster live for one role and analyzes the
// URL quality + per-job field completeness. Mirrors scripts/test-linkedin-scrape.js.
//   npm run monster:test-scrape -- "software engineer"        (role)
//   MONSTER_TEST_LOC="United States" npm run monster:test-scrape
import { scrapeMonster } from '../scrapers/monster.js';
import { classifyUrl } from '../src/core/url-quality.js';

const role = process.argv.slice(2).join(' ').trim() || 'software engineer';
const loc  = process.env.MONSTER_TEST_LOC || 'United States';

console.log(`Role     : ${role}`);
console.log(`Location : ${loc}\n`);

async function main() {
    const t0 = Date.now();
    let result;
    try {
        result = await scrapeMonster(role, loc, null);
    } catch (e) {
        console.log(`\n❌ Scrape threw ${e.name}: ${e.message}`);
        process.exit(2);
    }
    const elapsed = Date.now() - t0;
    const jobs = Array.isArray(result) ? result : result.jobs;
    const emptyConfirmed = Array.isArray(result) ? false : !!result.emptyConfirmed;
    const partial = Array.isArray(result) ? false : !!result.partial;

    console.log(`\n=== Scraped ${jobs.length} job(s) in ${elapsed}ms ===`);
    console.log(`emptyConfirmed=${emptyConfirmed} partial=${partial}\n`);

    const counts = { permalink: 0, profile_in: 0, empty: 0, other: 0 };
    const badTitle = []; const badCompany = [];
    jobs.forEach((j, i) => {
        const url = j.url ?? 'N/A';
        const q = classifyUrl(url === 'N/A' ? '' : url);
        counts[q]++;
        if (!j.title || j.title === 'N/A' || j.title.length <= 1) badTitle.push(i);
        if (!j.company?.name || j.company.name === 'N/A') badCompany.push(i);
        if (i < 5) {
            console.log(`#${i + 1} [${q}]`);
            console.log(`   title    : ${j.title}`);
            console.log(`   company  : ${j.company?.name ?? j.company}`);
            console.log(`   location : ${j.location?.formatted ?? j.location}`);
            console.log(`   url      : ${url}`);
            console.log('');
        }
    });

    console.log('=== URL quality summary ===');
    console.log(`   PERMALINK : ${counts.permalink}/${jobs.length}`);
    console.log(`   OTHER     : ${counts.other}/${jobs.length}`);
    console.log(`   EMPTY     : ${counts.empty}/${jobs.length}`);
    console.log(`   PROFILE_IN: ${counts.profile_in}/${jobs.length} (must be 0)`);
    console.log(`   bad title : ${badTitle.length} (must be 0)`);
    console.log(`   bad company: ${badCompany.length} (must be 0)`);

    // Non-zero exit when more than half of URLs are not permalinks (CI guard).
    if (jobs.length > 0 && counts.permalink / jobs.length < 0.5) {
        console.log('\n⚠ PERMALINK rate < 50% — extractor likely broken.');
        process.exit(3);
    }
    process.exit(0);
}
main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts` block, add (preserve existing entries; insert near the linkedin:* entries):

```json
"monster:test-scrape": "node scripts/test-monster-scrape.js",
```

Verify with:
```bash
grep -A 10 '"scripts"' package.json | head -15
```

- [ ] **Step 3: Spot-check the harness loads**

Run: `node -e "import('./scripts/test-monster-scrape.js')"`
Expected: no error (it might try to launch CloakBrowser if it doesn't see `process.argv` correctly — that's fine; we're just verifying the module imports cleanly). Hit Ctrl-C if a browser launches.

- [ ] **Step 4: Run the harness against a real role**

Run: `npm run monster:test-scrape -- "software engineer"`
Expected: at least 15 jobs returned (page 1 reliably has 18); URL quality summary shows PERMALINK ≥ 50%; bad title and bad company are both 0; exit code 0.

If the harness reports 0 jobs OR PERMALINK < 50% AND no `BlockedError`/`DomChangedError`, treat that as a real defect to investigate before committing. Re-run twice to rule out a single bad DataDome roll.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-monster-scrape.js package.json
git commit -m "$(cat <<'EOF'
feat(monster): test-monster-scrape harness + npm run monster:test-scrape

Mirrors scripts/test-linkedin-scrape.js. Runs scrapeMonster end-to-end,
prints per-job URL-quality summary, exits non-zero if PERMALINK < 50% or
if any title/company is empty/'N/A'. Used to verify after a Monster
DOM change without polluting CI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Re-enable Monster in the registry

**Files:**
- Modify: `src/scrapers/registry.js`

- [ ] **Step 1: Read the current registry**

Run: `cat src/scrapers/registry.js`

- [ ] **Step 2: Apply the edits**

In `src/scrapers/registry.js`:

(a) Remove the disabled-comment block (the paragraph beginning with "Monster is currently disabled — DataDome rate-limits ~70% of requests …" through "the `monster:` entry below.").

(b) Add the import alongside the existing ones:

```js
import { scrapeMonster } from '../../scrapers/monster.js';
```

(c) Add Monster to the SCRAPERS frozen object with `strictEmpty: true`:

```js
export const SCRAPERS = Object.freeze({
    dice: new BaseScraper('dice', scrapeDice),
    techfetch: new BaseScraper('techfetch', scrapeTechFetch),
    linkedin: new BaseScraper('linkedin', scrapeLinkedIn),
    glassdoor: new BaseScraper('glassdoor', scrapeGlassdoor),
    indeed: new BaseScraper('indeed', scrapeIndeed),
    monster: new BaseScraper('monster', scrapeMonster, { strictEmpty: true }),
});
```

- [ ] **Step 3: Verify Monster appears in PLATFORM_NAMES**

Run: `node -e "import('./src/scrapers/registry.js').then(m => console.log(m.PLATFORM_NAMES))"`
Expected: an array containing `'monster'`.

- [ ] **Step 4: Run the full suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all green. No existing test should depend on Monster being absent.

- [ ] **Step 5: Commit**

```bash
git add src/scrapers/registry.js
git commit -m "$(cat <<'EOF'
feat(monster): re-enable in scraper registry with strictEmpty:true

Removes the 6-month-old "Monster is disabled — DataDome" note. Live probe
shows DataDome triggers above ~5 rapid requests; the new scraper paces
3-5s between pages and throws BlockedError on the documented soft-block
signature. strictEmpty:true is set per-scraper so 0-jobs-with-200 always
surfaces as an error.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Document the existing probe scripts

**Files:**
- Modify: `scripts/monster-probe.mjs` (add header docstring)
- Modify: `scripts/monster-deep-probe.mjs` (add header docstring)

These two scripts were committed alongside the spec but lack a top-comment explaining they're investigation tools, not part of runtime.

- [ ] **Step 1: Add a docstring at the top of `scripts/monster-probe.mjs`**

Prepend (insert before the existing first line):

```js
// Investigation harness — NOT part of the runtime scraper. Run by hand
// when debugging Monster behavior. Output is the per-page scrape result
// against the current site. Use `scripts/monster-deep-probe.mjs` for the
// detailed DOM + structured-data + reliability hammer; this one is the
// fast "does it still work?" check.
//
// Usage:
//   node scripts/monster-probe.mjs
//   PROBE_ROLE="data engineer" PROBE_LOC="New York" node scripts/monster-probe.mjs
```

- [ ] **Step 2: Add the same kind of docstring to `scripts/monster-deep-probe.mjs`**

Confirm the existing top comment already explains the deep probe. If it does (it should, based on the file written earlier), this step is a no-op. Run:

```bash
head -25 scripts/monster-deep-probe.mjs
```

If the existing header is sufficient, skip to Step 3. Otherwise prepend an explicit "NOT part of runtime" docstring matching the style of Step 1.

- [ ] **Step 3: Commit**

```bash
git add scripts/monster-probe.mjs scripts/monster-deep-probe.mjs
git commit -m "$(cat <<'EOF'
docs(monster): mark probe scripts as investigation harnesses

Adds explicit "NOT part of runtime" docstrings so future operators
running grep over scripts/ know these are debug tools, not pieces of
the production scraper.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

After all 10 tasks land:

- [ ] **Step 1: Full test suite**

Run: `node --test 'test/**/*.test.js'`
Expected: all green; test count grew by at least 30 (5 new pure-helper test files).

- [ ] **Step 2: Live live-fire smoke**

Run: `npm run monster:test-scrape -- "software engineer"`
Expected: ≥ 15 jobs; PERMALINK ≥ 50%; bad title and bad company both 0; exit code 0.

- [ ] **Step 3: Module shape check**

Run: `node -e "import('./scrapers/monster.js').then(m => console.log(Object.keys(m).sort().join(', ')))"`
Expected: exports include `classifyMonsterPage, constructJobUrl, extractCardFromElement, isPromoted, parseAriaLabel, parseLocationDate, parsePay, scrapeMonster, searchUrl`.

- [ ] **Step 4: Hand off to `superpowers:finishing-a-development-branch`**

Once verification passes, follow that skill to pick between merge / PR / keep.

---

## Self-review

- **Spec coverage:** § A (data source) → Tasks 2, 5; § B (extraction) → Tasks 4, 5, 7; § C (pagination) → Task 7; § D (output) → Task 7 (`normalizeJobData` call); § E (error model) → Tasks 6, 7; § F (tests) → Tasks 1, 2, 3, 4, 5, 6, 8; § G (registry) → Task 9; § H (probe scripts disposition) → Task 10. All spec sections covered.
- **Placeholder scan:** every code step shows the full code; no "TBD" / "TODO" / "similar to Task N" patterns.
- **Type consistency:** `parseAriaLabel` → `{title, company}` everywhere; `constructJobUrl(realHref, jobId)` signature consistent across Tasks 3, 5, 7; `classifyMonsterPage({url, bodyText, cardCount, sawApiResponse})` signature consistent across Tasks 6, 7. `extractCardFromElement` returns `row | {__domChanged, reason} | null` consistently. Sentinel `__domChanged` is used in both the test fixture (Task 5) and aggregated in the orchestrator (Task 7).
- **Open spec questions** (Q1 jobViewResultsDataCompact cross-check; Q2 DataDome cookie reuse per nav; Q3 BaseScraper strictEmpty option pass-through) are answerable inline during implementation; Q3 is implicit in Task 9 (verify Monster has strictEmpty:true in PLATFORM_NAMES probe).
