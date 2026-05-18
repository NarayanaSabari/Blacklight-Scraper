# Setup Wizard (`--setup`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency interactive `node server.js --setup` / `npm run setup` wizard that asks LOCAL-vs-REMOTE, writes `config/credentials.json` + `.env`, makes `npm start` auto-apply the `.env` via a new inert zero-dep loader, and ends with a quick auth check.

**Architecture:** Pure, independently-testable units under `src/setup/` (`cookie-input`, `config-writer`, `verify`) plus a thin orchestration shell `wizard.js` with all I/O (prompts, fs, browser, fetch) injectable so it is deterministically unit-testable without a TTY/browser/network. `server.js` detects `--setup` and delegates before booting anything. A ~zero-dep `.env` parser/loader is added to `src/config/env.js`, inert when no `.env` exists.

**Tech Stack:** Node 20+ ESM (host runs Node v24.14.0), `node:readline/promises`, `node:fs`, `node:path`, `node:test` + `node:assert/strict`, existing `cloakbrowser`. **No new npm dependency.**

**Source spec:** `docs/superpowers/specs/2026-05-18-setup-wizard-design.md` (authoritative; §-references below).

> **Node 24:** `npm test` = `node --test 'test/**/*.test.js'`; explicit single-file paths also work. Success = the task's new tests pass AND `fail 0` (suite carries 76 tests from prior phases; cumulative numbers illustrative). Reporter prints `ℹ pass/fail N`.

> **Production-safety:** The only change to existing runtime code is the `.env` loader in `env.js` (inert with no `.env`) and a `--setup` short-circuit at the very top of `server.js main()` (only active when the flag is passed). No scraper/orchestrator behavior changes. Pre-existing working-tree changes (`.gitignore`, `pnpm-lock.yaml`) must remain unstaged and untouched in every commit.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/config/env.js` | Config singleton | Modify: add `parseDotEnv`/`applyDotEnv`/`loadDotEnvFile`; call loader atop `buildConfig()` |
| `test/config/dotenv.test.js` | `.env` loader unit tests | Create |
| `src/setup/cookie-input.js` | Pure: parse/validate cookie input | Create |
| `test/setup/cookie-input.test.js` | tests | Create |
| `src/setup/config-writer.js` | Pure: answers → credentials.json/.env content; merges | Create |
| `test/setup/config-writer.test.js` | tests | Create |
| `src/setup/verify.js` | Quick auth check (deps injected) + URL/cookie helpers | Create |
| `test/setup/verify.test.js` | tests | Create |
| `src/setup/wizard.js` | Orchestration + prompt loop (all I/O injectable) | Create |
| `test/setup/wizard.test.js` | tests (injected fakes, temp cwd) | Create |
| `server.js` | `--setup` short-circuit at top of `main()` | Modify |
| `package.json` | add `"setup"` script | Modify |
| `docs/superpowers/plans/2026-05-18-setup-wizard-NOTES.md` | completion notes | Create (Task 6) |

---

## Task 1: Zero-dep `.env` loader in `src/config/env.js`

**Files:** Modify `src/config/env.js`; Create `test/config/dotenv.test.js`

- [ ] **Step 1: Write the failing test** — create `test/config/dotenv.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv, applyDotEnv } from '../../src/config/env.js';

test('parseDotEnv: skips blanks/comments, splits on first =, strips one quote layer', () => {
    const kv = parseDotEnv([
        '# a comment',
        '',
        '   ',
        'NODE_ENV=production',
        'PORT = 3001 ',
        'Q="has = and spaces"',
        "S='single'",
        'NOEQUALSLINE',
        '=novalue',
        'URL=https://x/y?a=b',
    ].join('\n'));
    assert.deepEqual(kv, {
        NODE_ENV: 'production',
        PORT: '3001',
        Q: 'has = and spaces',
        S: 'single',
        URL: 'https://x/y?a=b',
    });
});

test('applyDotEnv: only sets keys that are undefined (real env wins)', () => {
    const env = { EXISTING: 'keep' };
    applyDotEnv({ EXISTING: 'override', NEW: 'set' }, env);
    assert.equal(env.EXISTING, 'keep');
    assert.equal(env.NEW, 'set');
});

test('applyDotEnv: treats empty-string existing as set (does not override)', () => {
    const env = { E: '' };
    applyDotEnv({ E: 'x' }, env);
    assert.equal(env.E, '');
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/config/dotenv.test.js` (exports missing).

- [ ] **Step 3: Implement in `src/config/env.js`.** It already has `import fs from 'fs'; import os from 'os'; import path from 'path';`. Immediately AFTER the `DEFAULTS` `Object.freeze({...})` block and the `toInt` function (i.e. just before `function loadCredentialsFile() {`), insert:

```js
// ── .env support (zero-dependency) ──────────────────────────────────────
// No `dotenv` package. parseDotEnv is pure (unit-tested). applyDotEnv
// only sets keys that are currently undefined, so a real environment /
// launchd / NSSM value ALWAYS wins over the file. loadDotEnvFile is the
// thin fs wrapper; absent file → inert (no behavior change for anyone
// without a .env). Generated by `npm run setup`.
export function parseDotEnv(text) {
    const out = {};
    if (typeof text !== 'string') return out;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue; // no key, or `=value`
        const key = line.slice(0, eq).trim();
        if (!key) continue;
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2
            && ((value[0] === '"' && value[value.length - 1] === '"')
             || (value[0] === "'" && value[value.length - 1] === "'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

export function applyDotEnv(kv, env = process.env) {
    for (const [k, v] of Object.entries(kv)) {
        if (env[k] === undefined) env[k] = v;
    }
}

function loadDotEnvFile(envPath = path.join(process.cwd(), '.env')) {
    try {
        if (!fs.existsSync(envPath)) return;
        applyDotEnv(parseDotEnv(fs.readFileSync(envPath, 'utf-8')), process.env);
    } catch { /* best-effort: a broken .env must never crash startup */ }
}
```

Then, inside `buildConfig()`, make the FIRST line of the function body a call to the loader. The current start is:

```js
function buildConfig() {
    const nodeEnv = process.env.NODE_ENV || DEFAULTS.NODE_ENV;
```

Change to:

```js
function buildConfig() {
    loadDotEnvFile();
    const nodeEnv = process.env.NODE_ENV || DEFAULTS.NODE_ENV;
```

- [ ] **Step 4: Run → PASS** — `node --test test/config/dotenv.test.js` (3 pass, 0 fail).

- [ ] **Step 5: Full suite (no regression)** — `npm test` → `fail 0`. (The loader is inert: the repo has no `.env`; existing config/registry tests unaffected.)

- [ ] **Step 6: Commit**

```bash
git add src/config/env.js test/config/dotenv.test.js
git commit -m "feat(env): zero-dep .env loader (inert without a .env; real env wins)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `src/setup/cookie-input.js` (pure parse/validate)

**Files:** Create `src/setup/cookie-input.js`, `test/setup/cookie-input.test.js`

- [ ] **Step 1: Failing test** — create `test/setup/cookie-input.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookieInput, validateLinkedinCookies } from '../../src/setup/cookie-input.js';

const LI = [{ name: 'li_at', value: 'x', domain: '.www.linkedin.com' },
             { name: 'bcookie', value: 'y', domain: '.linkedin.com' }];

test('parseCookieInput: a pasted JSON array', () => {
    assert.deepEqual(parseCookieInput(JSON.stringify(LI)), LI);
});
test('parseCookieInput: a {cookies:[...]} object blob', () => {
    assert.deepEqual(parseCookieInput(JSON.stringify({ cookies: LI })), LI);
});
test('parseCookieInput: a file path (injected readFile)', () => {
    const got = parseCookieInput('/tmp/cookies.json', { readFile: () => JSON.stringify(LI) });
    assert.deepEqual(got, LI);
});
test('parseCookieInput: throws a clear message on non-JSON / unreadable path', () => {
    assert.throws(() => parseCookieInput('not json, no [', { readFile: () => { throw new Error('ENOENT'); } }),
        /could not read|not valid json/i);
});
test('validateLinkedinCookies: rejects non-array / empty / missing li_at; accepts with li_at', () => {
    assert.equal(validateLinkedinCookies(null).ok, false);
    assert.equal(validateLinkedinCookies([]).ok, false);
    assert.equal(validateLinkedinCookies([{ name: 'bcookie', value: 'y' }]).ok, false);
    assert.match(validateLinkedinCookies([{ name: 'bcookie' }]).reason, /li_at/);
    assert.equal(validateLinkedinCookies(LI).ok, true);
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/setup/cookie-input.test.js`.

- [ ] **Step 3: Implement** — create `src/setup/cookie-input.js`:

```js
// Pure cookie-input parsing/validation for the setup wizard.
// No I/O of its own: file reads go through an injected `readFile`.
import fs from 'node:fs';

const looksLikeJson = (s) => {
    const t = s.trimStart();
    return t.startsWith('[') || t.startsWith('{');
};

/**
 * @param {string} input  a pasted JSON blob OR a filesystem path
 * @param {{readFile?: (p:string)=>string}} [deps]
 * @returns {Array<object>} normalized cookie array
 * @throws {Error} with a user-facing message on failure
 */
export function parseCookieInput(input, { readFile = (p) => fs.readFileSync(p, 'utf-8') } = {}) {
    const raw = String(input ?? '').trim();
    let text;
    if (looksLikeJson(raw)) {
        text = raw;
    } else {
        try {
            text = readFile(raw);
        } catch (e) {
            throw new Error(`Could not read cookie file "${raw}": ${e.message}`);
        }
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Input is not valid JSON (paste the Chrome cookie-export array, or give a path to it).');
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.cookies)) return parsed.cookies;
    throw new Error('Cookie JSON must be an array, or an object with a "cookies" array.');
}

/** @returns {{ok: boolean, reason?: string}} */
export function validateLinkedinCookies(arr) {
    if (!Array.isArray(arr) || arr.length === 0) {
        return { ok: false, reason: 'Expected a non-empty JSON array of cookies.' };
    }
    if (!arr.some((c) => c && c.name === 'li_at')) {
        return { ok: false, reason: 'Missing the LinkedIn "li_at" auth cookie — export cookies while logged in to LinkedIn.' };
    }
    return { ok: true };
}
```

- [ ] **Step 4: Run → PASS** (5 pass). **Step 5:** `npm test` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/setup/cookie-input.js test/setup/cookie-input.test.js
git commit -m "feat(setup): pure cookie-input parse/validate

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `src/setup/config-writer.js` (pure builders + merge)

**Files:** Create `src/setup/config-writer.js`, `test/setup/config-writer.test.js`

- [ ] **Step 1: Failing test** — create `test/setup/config-writer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCredentialsJson, buildDotEnv, mergeCredentials, mergeDotEnv }
    from '../../src/setup/config-writer.js';

const LI = [{ name: 'li_at', value: 'x' }];

test('LOCAL: credentials.json has only the supplied platform sections', () => {
    const c = buildCredentialsJson({
        mode: 'local',
        platforms: { linkedin: { credentials: LI }, techfetch: { email: 'a@b.c', password: 'p' } },
    });
    assert.deepEqual(c, { linkedin: { credentials: LI }, techfetch: { email: 'a@b.c', password: 'p' } });
    assert.equal(c.blacklight, undefined);
});

test('REMOTE: credentials.json has blacklight + scraperCredentials, no cookies', () => {
    const c = buildCredentialsJson({
        mode: 'remote',
        blacklight: { apiUrl: 'https://b', apiKey: 'bk' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'ck' },
    });
    assert.deepEqual(c, {
        blacklight: { apiUrl: 'https://b', apiKey: 'bk' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'ck' },
    });
});

test('buildDotEnv LOCAL: NODE_ENV=development; only chosen flags; omits unset', () => {
    const env = buildDotEnv({ mode: 'local', headless: false, strictEmpty: false, scraperMode: 'interactive', port: 3001 });
    assert.match(env, /^NODE_ENV=development$/m);
    assert.doesNotMatch(env, /LINKEDIN_HEADLESS/);
    assert.doesNotMatch(env, /SCRAPER_STRICT_EMPTY/);
    assert.doesNotMatch(env, /^PORT=/m);            // default 3001 omitted
    assert.match(env, /^SCRAPER_MODE=interactive$/m);
});

test('buildDotEnv: sets flags when chosen', () => {
    const env = buildDotEnv({ mode: 'remote', headless: true, strictEmpty: true, scraperMode: 'daemon', port: 8080 });
    assert.match(env, /^NODE_ENV=production$/m);
    assert.match(env, /^LINKEDIN_HEADLESS=true$/m);
    assert.match(env, /^SCRAPER_STRICT_EMPTY=true$/m);
    assert.match(env, /^SCRAPER_MODE=daemon$/m);
    assert.match(env, /^PORT=8080$/m);
});

test('mergeCredentials: shallow top-level — next replaces matching key, others preserved', () => {
    const merged = mergeCredentials(
        { blacklight: { apiUrl: 'old' }, linkedin: { credentials: ['old'] } },
        { linkedin: { credentials: LI } });
    assert.deepEqual(merged, { blacklight: { apiUrl: 'old' }, linkedin: { credentials: LI } });
});

test('mergeDotEnv: next keys overwrite their lines; unrelated existing lines/comments kept', () => {
    const out = mergeDotEnv('# hdr\nNODE_ENV=production\nKEEP=1\n', 'NODE_ENV=development\nPORT=8080\n');
    assert.match(out, /# hdr/);
    assert.match(out, /^KEEP=1$/m);
    assert.match(out, /^NODE_ENV=development$/m);
    assert.doesNotMatch(out, /^NODE_ENV=production$/m);
    assert.match(out, /^PORT=8080$/m);
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/setup/config-writer.test.js`.

- [ ] **Step 3: Implement** — create `src/setup/config-writer.js`:

```js
// Pure builders/mergers for the setup wizard. No I/O. Deterministic.
import { parseDotEnv } from '../config/env.js';

/** answers → config/credentials.json object */
export function buildCredentialsJson(answers) {
    if (answers.mode === 'remote') {
        return {
            blacklight: { ...answers.blacklight },
            scraperCredentials: { ...answers.scraperCredentials },
        };
    }
    // local: only the platform sections the user actually supplied
    const out = {};
    for (const [platform, section] of Object.entries(answers.platforms ?? {})) {
        if (section) out[platform] = section;
    }
    return out;
}

/** answers → .env file text (trailing newline; deterministic order; unset flags omitted) */
export function buildDotEnv(answers) {
    const lines = ['# Generated by `npm run setup` — do not commit (git-ignored).'];
    lines.push(`NODE_ENV=${answers.mode === 'remote' ? 'production' : 'development'}`);
    if (answers.headless === true) lines.push('LINKEDIN_HEADLESS=true');
    if (answers.strictEmpty === true) lines.push('SCRAPER_STRICT_EMPTY=true');
    // SCRAPER_MODE always written (explicit is clearer than relying on the default)
    lines.push(`SCRAPER_MODE=${answers.scraperMode || 'interactive'}`);
    if (answers.port && Number(answers.port) !== 3001) lines.push(`PORT=${answers.port}`);
    return lines.join('\n') + '\n';
}

/** shallow top-level: next's keys replace existing's matching key; others preserved */
export function mergeCredentials(existing, next) {
    return { ...(existing ?? {}), ...(next ?? {}) };
}

/** keep existing lines/comments; override keys present in nextText; append new ones */
export function mergeDotEnv(existingText, nextText) {
    const nextKv = parseDotEnv(nextText);
    const seen = new Set();
    const out = [];
    for (const rawLine of String(existingText ?? '').split(/\r?\n/)) {
        const line = rawLine;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { out.push(line); continue; }
        const eq = trimmed.indexOf('=');
        const key = eq > 0 ? trimmed.slice(0, eq).trim() : null;
        if (key && key in nextKv) {
            out.push(`${key}=${nextKv[key]}`);
            seen.add(key);
        } else {
            out.push(line);
        }
    }
    for (const [k, v] of Object.entries(nextKv)) {
        if (!seen.has(k)) out.push(`${k}=${v}`);
    }
    return out.join('\n').replace(/\n+$/, '') + '\n';
}
```

- [ ] **Step 4: Run → PASS** (6 pass). **Step 5:** `npm test` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/setup/config-writer.js test/setup/config-writer.test.js
git commit -m "feat(setup): pure config-writer (credentials.json/.env builders + shallow merge)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `src/setup/verify.js` (auth check; deps injected)

**Files:** Create `src/setup/verify.js`, `test/setup/verify.test.js`

- [ ] **Step 1: Failing test** — create `test/setup/verify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLinkedinUrl, cookieToPlaywright, verifyLocal, verifyRemote }
    from '../../src/setup/verify.js';

test('classifyLinkedinUrl', () => {
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/feed/'), 'authed');
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/uas/login?x'), 'login');
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/checkpoint/lg/'), 'login');
    assert.equal(classifyLinkedinUrl('https://www.linkedin.com/authwall'), 'login');
    assert.equal(classifyLinkedinUrl('https://example.com/'), 'unknown');
});

test('cookieToPlaywright: sameSite always Strict|Lax|None; unknown→Lax', () => {
    assert.equal(cookieToPlaywright({ name: 'a', value: 'b', domain: '.x', sameSite: 'no_restriction' }).sameSite, 'None');
    assert.equal(cookieToPlaywright({ name: 'a', value: 'b', domain: '.x', sameSite: 'unspecified' }).sameSite, 'Lax');
    assert.equal(cookieToPlaywright({ name: 'a', value: 'b', domain: '.x' }).sameSite, 'Lax');
});

test('verifyLocal: authed page → ok; login page → bad; launch throw → warn', async () => {
    const okBrowser = { newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }) }), close: async () => {} };
    const r1 = await verifyLocal({ launch: async () => okBrowser, cookies: [{ name: 'li_at', value: 'x', domain: '.www.linkedin.com' }], headless: true });
    assert.equal(r1.status, 'ok');

    const loginBrowser = { newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/uas/login' }) }), close: async () => {} };
    const r2 = await verifyLocal({ launch: async () => loginBrowser, cookies: [{ name: 'li_at', value: 'x' }], headless: true });
    assert.equal(r2.status, 'bad');

    const r3 = await verifyLocal({ launch: async () => { throw new Error('no display'); }, cookies: [], headless: false });
    assert.equal(r3.status, 'warn');
});

test('verifyRemote: 200 → ok; 401 → bad; network throw → warn', async () => {
    const ok = await verifyRemote({ fetchFn: async () => ({ status: 200 }), blacklight: { apiUrl: 'https://b', apiKey: 'k' }, scraperCredentials: { apiUrl: 'https://c', apiKey: 'k' } });
    assert.equal(ok.status, 'ok');
    const bad = await verifyRemote({ fetchFn: async () => ({ status: 401 }), blacklight: { apiUrl: 'https://b', apiKey: 'k' }, scraperCredentials: { apiUrl: 'https://c', apiKey: 'k' } });
    assert.equal(bad.status, 'bad');
    const warn = await verifyRemote({ fetchFn: async () => { throw new Error('ECONN'); }, blacklight: { apiUrl: 'https://b', apiKey: 'k' }, scraperCredentials: { apiUrl: 'https://c', apiKey: 'k' } });
    assert.equal(warn.status, 'warn');
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/setup/verify.test.js`.

- [ ] **Step 3: Implement** — create `src/setup/verify.js`:

```js
// Quick post-setup auth check. Browser/network are injected so the
// decision logic is unit-testable; the live path reuses cloakbrowser.
const LOGIN_RE = /\/login|\/uas\/login|\/checkpoint|\/authwall|session_redirect/;

export function classifyLinkedinUrl(url) {
    const u = String(url || '');
    if (LOGIN_RE.test(u)) return 'login';
    if (/linkedin\.com\/(feed|in\/|mynetwork|jobs|search\/results)/.test(u)) return 'authed';
    return 'unknown';
}

// Mirrors scrapers/linkedin.js::loadCookies sameSite policy (post-1C:
// any non Strict/Lax/None value → 'Lax', never the raw string).
export function cookieToPlaywright(c) {
    const s = c.sameSite;
    const sameSite = s === 'no_restriction' ? 'None'
        : s === 'strict' ? 'Strict'
        : s === 'lax' ? 'Lax'
        : s === 'None' || s === 'Strict' || s === 'Lax' ? s
        : 'Lax';
    const out = {
        name: c.name, value: c.value, domain: c.domain,
        path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite,
    };
    const exp = typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate)
        : (typeof c.expirationDate === 'string' && Number.isFinite(Number(c.expirationDate)))
            ? Math.floor(Number(c.expirationDate)) : undefined;
    if (exp !== undefined) out.expires = exp;
    return out;
}

export async function verifyLocal({ launch, cookies, headless, timeoutMs = 30000 }) {
    let browser;
    try {
        browser = await launch({ headless: !!headless, humanize: true });
        const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York' });
        const mapped = (cookies || []).map(cookieToPlaywright);
        try { await context.addCookies(mapped); }
        catch { for (const c of mapped) { try { await context.addCookies([c]); } catch { /* skip */ } } }
        const page = await context.newPage();
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const cls = classifyLinkedinUrl(page.url());
        if (cls === 'authed') return { status: 'ok', message: '✅ LinkedIn cookies valid — ready. Run: npm start' };
        return { status: 'bad', message: '❌ LinkedIn cookies invalid/expired — re-run `npm run setup` with a fresh cookie export.' };
    } catch (e) {
        return { status: 'warn', message: `⚠️ Could not verify (browser/network): ${String(e.message).split('\n')[0]}. Config written; try \`npm start\`.` };
    } finally {
        if (browser) { try { await browser.close(); } catch { /* noop */ } }
    }
}

export async function verifyRemote({ fetchFn, blacklight, scraperCredentials }) {
    const hit = async (label, base, apiKey, p) => {
        const r = await fetchFn(`${String(base).replace(/\/$/, '')}${p}`, { headers: { 'X-Scraper-API-Key': apiKey } });
        return { label, status: r.status };
    };
    try {
        const a = await hit('credentials', scraperCredentials.apiUrl, scraperCredentials.apiKey, '/api/scraper-credentials/queue/availability');
        const b = await hit('blacklight', blacklight.apiUrl, blacklight.apiKey, '/api/scraper/queue/current-session');
        const denied = [a, b].find((x) => x.status === 401 || x.status === 403);
        if (denied) return { status: 'bad', message: `❌ ${denied.label} API rejected the key (${denied.status}) — check the apiKey.` };
        return { status: 'ok', message: '✅ APIs reachable & key accepted — ready. Run: npm start' };
    } catch (e) {
        return { status: 'warn', message: `⚠️ Could not reach an API (${String(e.message).split('\n')[0]}); config written.` };
    }
}
```

- [ ] **Step 4: Run → PASS** (4 pass). **Step 5:** `npm test` → `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/setup/verify.js test/setup/verify.test.js
git commit -m "feat(setup): quick auth-check (verifyLocal/verifyRemote, deps injected)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `src/setup/wizard.js` + `server.js` hook + `package.json`

**Files:** Create `src/setup/wizard.js`, `test/setup/wizard.test.js`; Modify `server.js`, `package.json`

- [ ] **Step 1: Failing test** — create `test/setup/wizard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../../src/setup/wizard.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setupw-')); }
function scriptedAsk(answers) { let i = 0; return async () => answers[i++]; }
const LI = JSON.stringify([{ name: 'li_at', value: 'x', domain: '.www.linkedin.com' }]);

test('LOCAL: writes credentials.json + .env, returns 0, no raw secret in output', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['1', LI, 'done', 'yes', 'no', 'interactive', '3001']),
        launchFn: async () => ({ newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }) }), close: async () => {} }),
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.ok(Array.isArray(cred.linkedin.credentials) && cred.linkedin.credentials[0].name === 'li_at');
    const env = fs.readFileSync(path.join(cwd, '.env'), 'utf-8');
    assert.match(env, /^NODE_ENV=development$/m);
    assert.ok(!out.join('\n').includes('li_at') || !out.join('\n').includes('"value":"x"'),
        'wizard output must not echo raw cookie values');
});

test('cancel on existing-file prompt writes nothing and returns 1', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{"blacklight":{"apiKey":"SECRET99"}}');
    const code = await runSetupWizard({ cwd, ask: scriptedAsk(['cancel']), isIgnored: () => true, out: () => {} });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'),
        '{"blacklight":{"apiKey":"SECRET99"}}'); // untouched
});

test('REMOTE: writes blacklight+scraperCredentials, NODE_ENV=production, returns 0', async () => {
    const cwd = tmp();
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['2', 'https://b', 'bkey', 'https://c', 'ckey', 'daemon', 'yes', 'no', '3001']),
        fetchFn: async () => ({ status: 200 }),
        isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.equal(cred.blacklight.apiUrl, 'https://b');
    assert.equal(cred.scraperCredentials.apiKey, 'ckey');
    assert.ok(cred.linkedin === undefined);
    assert.match(fs.readFileSync(path.join(cwd, '.env'), 'utf-8'), /^NODE_ENV=production$/m);
});
```

> Prompt order encoded by `scriptedAsk` is the contract Step 3 must implement exactly. LOCAL: [mode `1`, linkedin cookie input, add-platform `done`, headed? `yes`→headed (no LINKEDIN_HEADLESS), strict? `no`, SCRAPER_MODE, PORT]. REMOTE: [mode `2`, blacklight url, blacklight key, scrapercreds url, scrapercreds key, SCRAPER_MODE, headed? `yes`, strict? `no`, PORT]. Existing-file prompt (only if a file exists) is asked FIRST and accepts `merge|overwrite|cancel`.

- [ ] **Step 2: Run → FAIL** — `node --test test/setup/wizard.test.js`.

- [ ] **Step 3: Implement** — create `src/setup/wizard.js`:

```js
// Setup wizard orchestration. ALL I/O is injectable so this is unit-
// testable without a TTY/browser/network. Defaults wire the real ones.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseCookieInput, validateLinkedinCookies } from './cookie-input.js';
import { buildCredentialsJson, buildDotEnv, mergeCredentials, mergeDotEnv } from './config-writer.js';
import { verifyLocal, verifyRemote } from './verify.js';

function defaultAsk() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return Object.assign(async (q) => (await rl.question(q + ' ')).trim(), { close: () => rl.close() });
}
function realIsIgnored(p) {
    try { execFileSync('git', ['check-ignore', '-q', p], { stdio: 'ignore' }); return true; }
    catch (e) { return e.status === 1 ? false : null; } // 1 = not ignored; other/no-git = null (unknown)
}
function mask(v) { const s = String(v ?? ''); return s.length > 4 ? `••••${s.slice(-4)}` : '••••'; }

export async function runSetupWizard(deps = {}) {
    const cwd = deps.cwd || process.cwd();
    const ask = deps.ask || defaultAsk();
    const out = deps.out || ((s) => process.stdout.write(s + '\n'));
    const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf-8'));
    const launchFn = deps.launchFn || (async (o) => (await import('cloakbrowser')).launch(o));
    const fetchFn = deps.fetchFn || globalThis.fetch;
    const isIgnored = deps.isIgnored || realIsIgnored;

    const credPath = path.join(cwd, 'config', 'credentials.json');
    const envPath = path.join(cwd, '.env');
    try {
        out('── Unified Job Scraper — setup ──');
        out('Run via: `npm run setup`  (note: `npm start --setup` swallows the flag; use `npm start -- --setup`).');

        // Idempotency pre-check
        let mode = 'overwrite';
        const credExists = fs.existsSync(credPath);
        const envExists = fs.existsSync(envPath);
        if (credExists || envExists) {
            if (credExists) {
                try {
                    const ex = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
                    out(`Existing config/credentials.json keys: ${Object.keys(ex).map((k) => `${k}(${mask(JSON.stringify(ex[k]))})`).join(', ')}`);
                } catch { out('Existing config/credentials.json present (unparseable).'); }
            }
            if (envExists) out('Existing .env present.');
            mode = (await ask('Existing config found. [merge / overwrite / cancel]?')).toLowerCase();
            if (mode !== 'merge' && mode !== 'overwrite') { out('Cancelled — nothing written.'); return 1; }
        }

        const runMode = (await ask('Run mode? 1) Local single-host  2) Production/queue [1/2]:')) === '2' ? 'remote' : 'local';
        const answers = { mode: runMode };

        if (runMode === 'local') {
            answers.platforms = {};
            // LinkedIn (primary)
            for (let attempt = 1; attempt <= 3; attempt++) {
                const inp = await ask('Paste LinkedIn cookie JSON array OR a file path (paste: end with a lone "." line):');
                let blob = inp;
                if (inp.trimStart().startsWith('[') || inp.trimStart().startsWith('{')) {
                    const more = [];
                    let line;
                    while ((line = await ask('')) !== '.') more.push(line);
                    blob = [inp, ...more].join('\n');
                }
                try {
                    const cookies = parseCookieInput(blob, { readFile });
                    const v = validateLinkedinCookies(cookies);
                    if (!v.ok) { out(`  ✗ ${v.reason}`); if (attempt === 3) out('  (continuing; verify will likely fail)'); continue; }
                    answers.platforms.linkedin = { credentials: cookies };
                    break;
                } catch (e) { out(`  ✗ ${e.message}`); if (attempt === 3) out('  (continuing; verify will likely fail)'); }
            }
            // Optional extra platforms
            let more;
            while ((more = (await ask('Add another platform? [indeed/glassdoor/techfetch/done]:')).toLowerCase()) !== 'done' && more) {
                if (more === 'techfetch') {
                    const email = await ask('  techfetch email:');
                    const password = await ask('  techfetch password:');
                    answers.platforms.techfetch = { email, password };
                } else if (more === 'indeed' || more === 'glassdoor') {
                    try { answers.platforms[more] = { credentials: parseCookieInput(await ask(`  paste ${more} cookie JSON or path:`), { readFile }) }; }
                    catch (e) { out(`  ✗ ${e.message}`); }
                } else { out('  (unknown — choose indeed/glassdoor/techfetch/done)'); }
            }
            answers.headless = (await ask('Run the browser HEADLESS? (LinkedIn default is headed) [y/N]:')).toLowerCase().startsWith('y');
            answers.strictEmpty = (await ask('Enable loud block-detection now (SCRAPER_STRICT_EMPTY)? [y/N]:')).toLowerCase().startsWith('y');
            answers.scraperMode = (await ask('SCRAPER_MODE [interactive/daemon] (default interactive):')) || 'interactive';
            answers.port = (await ask('PORT (default 3001):')) || '3001';
        } else {
            answers.blacklight = { apiUrl: (await ask('blacklight apiUrl:')).replace(/\/$/, ''), apiKey: await ask('blacklight apiKey:') };
            answers.scraperCredentials = { apiUrl: (await ask('scraperCredentials apiUrl:')).replace(/\/$/, ''), apiKey: await ask('scraperCredentials apiKey:') };
            answers.scraperMode = (await ask('SCRAPER_MODE [interactive/daemon] (default daemon):')) || 'daemon';
            answers.headless = (await ask('Run the browser HEADLESS? [y/N]:')).toLowerCase().startsWith('y');
            answers.strictEmpty = (await ask('Enable SCRAPER_STRICT_EMPTY now? [y/N]:')).toLowerCase().startsWith('y');
            answers.port = (await ask('PORT (default 3001):')) || '3001';
        }

        // git-ignore guard
        for (const p of [credPath, envPath]) {
            if (isIgnored(p) === false) { out(`✗ ${p} is NOT git-ignored — refusing to write secrets. Fix .gitignore first.`); return 1; }
        }

        // Build + (optionally) merge + write
        let credObj = buildCredentialsJson(answers);
        let envText = buildDotEnv(answers);
        if (mode === 'merge' && credExists) {
            try { credObj = mergeCredentials(JSON.parse(fs.readFileSync(credPath, 'utf-8')), credObj); } catch { /* keep new */ }
        }
        if (mode === 'merge' && envExists) {
            try { envText = mergeDotEnv(fs.readFileSync(envPath, 'utf-8'), envText); } catch { /* keep new */ }
        }
        fs.mkdirSync(path.dirname(credPath), { recursive: true });
        const writeOpts = { mode: 0o600 };
        try { fs.writeFileSync(credPath, JSON.stringify(credObj, null, 2) + '\n', writeOpts); } catch { fs.writeFileSync(credPath, JSON.stringify(credObj, null, 2) + '\n'); }
        try { fs.writeFileSync(envPath, envText, writeOpts); } catch { fs.writeFileSync(envPath, envText); }
        out(`✓ Wrote ${credPath}`);
        out(`✓ Wrote ${envPath}`);

        // Verify
        let result;
        if (runMode === 'local' && answers.platforms?.linkedin?.credentials) {
            out('Verifying LinkedIn cookies…');
            result = await verifyLocal({ launch: launchFn, cookies: answers.platforms.linkedin.credentials, headless: !!answers.headless });
        } else if (runMode === 'remote') {
            out('Verifying APIs…');
            result = await verifyRemote({ fetchFn, blacklight: answers.blacklight, scraperCredentials: answers.scraperCredentials });
        } else {
            result = { status: 'warn', message: '⚠️ No LinkedIn cookies provided; skipped verify. Config written.' };
        }
        out(result.message);
        out('Setup complete. Start with: npm start');
        return 0;
    } finally {
        if (typeof ask.close === 'function') ask.close();
    }
}
```

- [ ] **Step 4: Wire `server.js`.** Its `async function main() {` body currently begins `const config = getConfig();`. Insert as the FIRST statements of `main()` (before `const config = getConfig();`):

```js
    if (process.argv.slice(2).includes('--setup')) {
        const { runSetupWizard } = await import('./src/setup/wizard.js');
        process.exit(await runSetupWizard());
    }
```

- [ ] **Step 5: `package.json` script.** In `scripts`, after the `"test"` entry, add `"setup": "node server.js --setup"`. Final block:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "NODE_ENV=development node --watch server.js",
    "chrome:login": "node scripts/chrome-debug.js",
    "test": "node --test 'test/**/*.test.js'",
    "setup": "node server.js --setup"
  },
```

- [ ] **Step 6: Run → PASS** — `node --test test/setup/wizard.test.js` (3 pass). Then `npm test` → `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/setup/wizard.js test/setup/wizard.test.js server.js package.json
git commit -m "feat(setup): interactive wizard + server.js --setup hook + npm run setup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verification + empirical smoke (isolated) + NOTES

**Files:** Create `docs/superpowers/plans/2026-05-18-setup-wizard-NOTES.md`

- [ ] **Step 1: Full suite** — `npm test` → `fail 0`. Record pass count.

- [ ] **Step 2: Inertness of the env.js change** — confirm no `.env` exists in the repo root and the suite is green (the loader is dormant). Run: `test -f .env && echo "HAS .env (unexpected)" || echo "no .env — loader inert"`. Expected: `no .env — loader inert`.

- [ ] **Step 3: Isolated empirical smoke (must NOT touch the real `config/credentials.json`).** The repo's `config/credentials.json` holds the user's real LinkedIn cookies — the wizard must be exercised in a TEMP cwd. Run exactly:

```bash
T=$(mktemp -d) && cp server.js "$T/" 2>/dev/null; node -e '
const path=require("node:path");
import(path.join(process.cwd(),"src/setup/wizard.js")).then(async ({runSetupWizard})=>{
  const fs=require("node:fs"), os=require("node:os");
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),"setup-smoke-"));
  const LI=JSON.stringify([{name:"li_at",value:"x",domain:".www.linkedin.com"}]);
  let i=0; const ans=["2","https://b.example","bkey","https://c.example","ckey","daemon","y","n","3001"];
  const code=await runSetupWizard({cwd, ask:async()=>ans[i++], fetchFn:async()=>({status:200}), isIgnored:()=>true, out:()=>{}});
  const cred=JSON.parse(fs.readFileSync(path.join(cwd,"config","credentials.json"),"utf8"));
  const env=fs.readFileSync(path.join(cwd,".env"),"utf8");
  console.log("exit="+code, "cred.blacklight.apiUrl="+cred.blacklight.apiUrl, "hasLinkedin="+(cred.linkedin!==undefined), "envProd="+/^NODE_ENV=production$/m.test(env), "headless="+/^LINKEDIN_HEADLESS=true$/m.test(env));
  fs.rmSync(cwd,{recursive:true,force:true});
});'
```

Expected: `exit=0 cred.blacklight.apiUrl=https://b.example hasLinkedin=false envProd=true headless=true`. Then confirm the repo's real file is untouched: `git status --porcelain config/credentials.json` → no output (still git-ignored/untracked, unchanged).

- [ ] **Step 4: NOTES** — create `docs/superpowers/plans/2026-05-18-setup-wizard-NOTES.md`:

```markdown
# Setup Wizard — completion notes
Status: COMPLETE. npm test fail 0 (pure units: dotenv, cookie-input,
config-writer, verify, wizard-with-injected-fakes).
Delivered: `npm run setup` / `node server.js --setup` interactive wizard
(LOCAL paste cookies → credentials.json + .env NODE_ENV=development;
REMOTE blacklight+scraperCredentials → NODE_ENV=production); zero-dep
.env loader in env.js (inert without a .env; real env wins); quick auth
check (LinkedIn cookie login probe / API ping); merge/overwrite/cancel
idempotency; secrets masked; files 0o600 + git-ignore guarded.
Empirically smoke-tested in an isolated temp cwd (REMOTE path) — the
repo's real config/credentials.json (operator LinkedIn cookies) was NOT
touched.
Production impact: only env.js (.env loader, inert) + server.js (--setup
short-circuit, only when flag passed). No scraper/orchestrator change.
The interactive prompt loop + live browser/API verify are exercised by
running `npm run setup`; unit tests cover all pure logic via injected
fakes.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-18-setup-wizard-NOTES.md
git commit -m "docs(plan): setup-wizard completion notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** §1 decisions: both-modes-ask-first (T5 Q `runMode`), .env+zero-dep loader (T1), quick auth check (T4+T5), Approach-A `src/setup/` layout (T2–T5). §3 invocation: `server.js` hook + `npm run setup` + the `npm start -- --setup` hint (T5 S3/S4/S5). §4 LOCAL/REMOTE flows incl. paste-vs-path disambiguation, extra platforms, defaults (T5 S3). §5 `.env` loader semantics incl. precedence & inert-when-missing (T1). §6 idempotency merge/overwrite/cancel, git-ignore guard, secret masking, 0o600, Ctrl-C/no-write (T5 S3 + T3 merges). §7 verify ok/bad/warn LOCAL & REMOTE, never changes exit code (T4 + T5). §8 testing matrix → T1–T5 tests + T6 empirical. §9 out-of-scope respected (no deps, no doc edits, no scraper change). No gaps.

**2. Placeholder scan:** none — every code step has complete code; every run step has exact command + expected output. The interactive-loop/live-verify "tested empirically not unit" is an explicit, justified strategy (matches spec §8), with the wizard's pure orchestration still unit-tested via injected `ask`/fs/launch/fetch — not a placeholder.

**3. Type/name consistency:** `parseDotEnv`/`applyDotEnv`/`loadDotEnvFile`, `parseCookieInput`/`validateLinkedinCookies`, `buildCredentialsJson`/`buildDotEnv`/`mergeCredentials`/`mergeDotEnv`, `classifyLinkedinUrl`/`cookieToPlaywright`/`verifyLocal`/`verifyRemote`, `runSetupWizard(deps)` with `{cwd,ask,out,readFile,launchFn,fetchFn,isIgnored}` — names/shapes are identical across the tasks that define and consume them; `config-writer` imports `parseDotEnv` from `env.js` (defined T1, used T3); wizard consumes all four modules with the exact signatures their tests assert. Answers object shape (`mode`,`platforms`,`blacklight`,`scraperCredentials`,`headless`,`strictEmpty`,`scraperMode`,`port`) is consistent between T3 and T5. No mismatches.
