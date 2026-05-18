# Setup Wizard (`--setup`) — Design Spec

- **Date:** 2026-05-18
- **Repo:** Unified Job Scraper (Node 20+ ESM; host runs Node v24.14.0)
- **Goal:** An interactive, zero-dependency wizard that asks a few questions and writes the config needed to make the scraper ready to run — covering both the LOCAL single-host path (paste cookies) and the REMOTE production/queue path (backend APIs) — ending with a quick "is it actually working?" check.
- **Status:** Design approved; this spec is the source of truth for the implementation plan.

## 1. Decisions locked (from brainstorming)

1. **Scope:** ONE wizard that asks LOCAL vs REMOTE as its first question, then branches.
2. **Env persistence:** Wizard writes a `.env`; a new ~15-line **zero-dependency** `.env` parser is added to `src/config/env.js` so `npm start` auto-applies it. No new npm dependency. `.env` is git-ignored.
3. **Verification:** Ends with a **quick auth check** (LOCAL: cookie login probe; REMOTE: API ping), reported as ✅/❌; failure is a warning, not a crash.
4. **Architecture:** Approach A — standalone `src/setup/` module, invoked via `node server.js --setup` (+ `npm run setup`). Bash/dotenv-dependency approaches rejected.

## 2. Background facts the implementation must respect (verified in code)

- **Credential mode decision** (`src/api/credentials.js` → `initializeCredentialsClient`): REMOTE is used **only if** `!getConfig().isDevelopment` **AND** `getConfig().scraperCredentialsApi` is set; otherwise LOCAL (`config/credentials.json`). Therefore the wizard's LOCAL branch writes `NODE_ENV=development` (forces LOCAL mode AND disables the auto queue-checker for true standalone), and the REMOTE branch writes `NODE_ENV=production`.
- **Auto queue-checker** (`server.js`): starts only when `orchestrator && !config.isDevelopment`. Consistent with the above.
- **`config/credentials.json` shapes** (`config/credentials.example.json` + code):
  - LOCAL LinkedIn (primary): `{ "linkedin": { "credentials": [ <chrome cookie-export objects> ] } }`. `scrapers/linkedin.js::loadCookies` reads `credential.credentials` (array) and maps `sameSite` (post-1C: any unknown → `Lax`). The auth cookie is `li_at`.
  - LOCAL others (optional): `indeed`/`glassdoor` → `{ "credentials": [...] }`; `linkedin`/`techfetch` may also carry `{ "email": "...", "password": "..." }`.
  - REMOTE: `{ "blacklight": { "apiUrl", "apiKey" }, "scraperCredentials": { "apiUrl", "apiKey" } }` — **no** local cookie arrays. `env.js` maps these to `cfg.blacklight` and `cfg.scraperCredentialsApi`.
- **`src/config/env.js`** already imports `fs`, `os`, `path`; `getConfig()` is a cached singleton with `resetConfigForTest()` exported. `loadCredentialsFile()` reads `config/credentials.json` and returns `null` on any error (so a partial/edited file must remain valid JSON).
- **Git-ignore:** `.gitignore` already excludes `config/credentials.json`, `config/*.local.json`, `.env`, `.env.*` (with `!.env.example`). The wizard must still re-confirm via `git check-ignore` before writing and never print secret values.
- **No `.env` loader exists today** (no `dotenv`); `.env.example` is documentation only — nothing reads it. This is the gap section 5 closes.
- **Node-24 test runner:** `package.json` `test` = `node --test 'test/**/*.test.js'`; explicit file paths also work. Tests use `node:test` + `node:assert/strict`.

## 3. Invocation & component layout

- `package.json` `scripts`: add `"setup": "node server.js --setup"`. Usable as `npm run setup` or `node server.js --setup`.
- `npm start --setup` does NOT pass the flag (npm consumes it); the correct ad-hoc form is `npm start -- --setup`. The wizard's only obligation here: when it runs, print a one-line hint documenting `npm run setup` / `npm start -- --setup` so users who hit the npm-arg pitfall are unblocked. (We cannot detect "user typed `npm start --setup`" — npm already ate the arg — so this is a documentation/print-on-run hint, not detection.)
- `server.js`: as the **first statements inside `main()`**, before `getConfig()`/`bootTelemetry()`/`buildOrchestrator()`/`express()`:
  ```
  if (process.argv.slice(2).includes('--setup')) {
      const { runSetupWizard } = await import('./src/setup/wizard.js');
      const code = await runSetupWizard();
      process.exit(code);   // 0 = success (incl. verify-failed-but-config-written), 1 = aborted
  }
  ```
  Express/telemetry/orchestrator are never constructed in setup mode.
- New files (each a single clear responsibility, independently testable):
  - `src/setup/wizard.js` — orchestration + the interactive prompt loop (thin shell over `node:readline/promises`). Exports `runSetupWizard(): Promise<number>`. Also exports small injectable seams so it is testable without a TTY (an `ask` function injectable; default uses readline).
  - `src/setup/config-writer.js` — **pure**: `buildCredentialsJson(answers)` and `buildDotEnv(answers)` return string/object content from an answers object; `mergeCredentials(existing, next)` does a **shallow top-level key merge** — top-level keys present in `next` (e.g. `linkedin`, `blacklight`) replace the matching key in `existing`; unrelated top-level keys in `existing` are preserved untouched (no per-cookie/sub-object deep merge). No I/O.
  - `src/setup/cookie-input.js` — **pure**: `parseCookieInput(rawOrPath, { readFile })` → normalized cookie array; `validateLinkedinCookies(arr)` → `{ ok, reason }` (must be a non-empty array; at least one entry with `name === 'li_at'`). File reading via an injected `readFile` for testability.
  - `src/setup/verify.js` — the post-write check. `verifyLocal({ launch, loadCookies, cookies, headless })` and `verifyRemote({ fetchFn, blacklight, scraperCredentials })`. Browser/network deps injected so the pure decision is testable; the live path reuses `cloakbrowser` `launch` and `scrapers/linkedin.js`-style cookie loading.
  - `test/setup/*.test.js` — unit tests (section 8).
- `src/config/env.js` — add the zero-dep `.env` loader (section 5).

## 4. Wizard flow

`runSetupWizard()`:

1. Print banner + the invocation hint (`npm run setup` / `npm start -- --setup`).
2. **Idempotency pre-check** (section 6): if `config/credentials.json` and/or `.env` exist, print which top-level keys are set (values masked `••••<last4>`), then ask: **merge / overwrite / cancel**. `cancel` → write nothing, return `1`.
3. **Q0:** "Run mode? (1) Local single-host  (2) Production/queue".
4. **LOCAL branch:**
   - LinkedIn (primary): "Paste your Chrome cookie-export JSON array, or a file path to it." **Input disambiguation:** read the first non-empty line; if it begins with `[` or `{` it is treated as the start of a pasted JSON blob — keep reading lines until a line that is exactly `.` (a lone dot) is entered, then parse the accumulated text; otherwise the first line is treated as a filesystem path and read via the injected `readFile` (error → re-prompt). Then `parseCookieInput` → `validateLinkedinCookies`; on invalid, show the reason and re-prompt (max 3 tries; 3rd failure → continue but mark verify as will-fail).
   - "Add another platform? indeed / glassdoor / techfetch / done". For indeed/glassdoor → cookie paste (same parser, no `li_at` requirement). For techfetch → `email` + `password` (password input not echoed). Loop until `done`.
   - Settings prompts (with defaults): headed? (default **yes** → `LINKEDIN_HEADLESS` unset; "no" → `LINKEDIN_HEADLESS=true`); enable loud block-detection now? (default **no** → `SCRAPER_STRICT_EMPTY` unset; "yes" → `=true`); `SCRAPER_MODE` (default `interactive`); `PORT` (default `3001`).
   - Writes `config/credentials.json` from the collected platform sections; writes `.env` including `NODE_ENV=development` plus the chosen flags.
5. **REMOTE branch:**
   - Prompt: `blacklight.apiUrl`, `blacklight.apiKey`, `scraperCredentials.apiUrl`, `scraperCredentials.apiKey` (keys not echoed). Trim trailing slash on URLs; basic `https?://` validation, re-prompt on invalid.
   - Settings: `SCRAPER_MODE` (default **`daemon`**), headed? (default yes), `SCRAPER_STRICT_EMPTY` (default no), `PORT` (default `3001`).
   - Writes `config/credentials.json` with `blacklight` + `scraperCredentials` blocks (no cookie arrays); writes `.env` including `NODE_ENV=production` plus chosen flags.
6. **Verify (section 7).** Print the result and a precise "next step" line (`npm start`, or how to fix).
7. Return `0`.

## 5. `.env` loader (`src/config/env.js`)

Add a private `loadDotEnvFile()` invoked once at the **top of `buildConfig()`** (so all downstream `process.env` reads see it; `getConfig()`'s caching means it runs once per process, and `resetConfigForTest()` re-runs it — acceptable and test-friendly):

- Path: `path.join(process.cwd(), '.env')`. If absent → return (inert; no behavior change for anyone without a `.env`).
- Parse line-by-line: skip blank lines and lines whose first non-space char is `#`; split on the **first** `=`; trim key; value = remainder with one layer of surrounding matching `'…'` or `"…"` quotes stripped, else trimmed as-is.
- For each pair: set `process.env[key]` **only if `process.env[key] === undefined`** — real environment / launchd / NSSM values always win over the file.
- Never throw: wrap the read/parse in try/catch; a malformed `.env` logs nothing and is ignored line-by-line (best-effort), consistent with `loadCredentialsFile()`'s fail-safe stance.
- The parsing logic is factored into a pure exported `parseDotEnv(text): Record<string,string>` so it is unit-testable without filesystem; `loadDotEnvFile()` is the thin fs wrapper that applies precedence.

This is the only change to existing production code and is inert when no `.env` exists.

## 6. Safety / idempotency / secrets

- Before writing either file: `git check-ignore` both paths; if (unexpectedly) not ignored, refuse to write and tell the user to fix `.gitignore` first (prevents committing secrets).
- Existing-file handling (step 2): `merge` is a **shallow top-level key merge** — for `credentials.json`, top-level keys the wizard collected (e.g. `linkedin`, `blacklight`, `scraperCredentials`) replace the matching existing top-level key; unrelated existing top-level keys are preserved untouched (no per-cookie/sub-object merge). For `.env`, wizard-set keys overwrite their lines; unrelated existing lines are preserved. `overwrite` replaces the whole file. `cancel` writes nothing.
- Secrets: never echo pasted cookie values, passwords, or API keys. When displaying existing config, mask every value as `••••<last4>` (or `••••` if <4 chars). The wizard's own stdout must not contain raw secrets.
- `Ctrl-C` / EOF mid-wizard before the write step → nothing is written; exit `1`.
- The wizard writes files atomically-ish: build full content in memory, then a single `fs.writeFileSync` per file (no partial writes).
- Files written with restrictive intent: `config/credentials.json` and `.env` created with mode `0o600` where the platform supports it (best-effort; ignore failure on Windows).

## 7. Verify step (quick auth check)

- **LOCAL:** `launch({ headless: <per LINKEDIN_HEADLESS choice>, humanize: true })`, create context, inject the LinkedIn cookies using the same normalization as `scrapers/linkedin.js::loadCookies`, `goto('https://www.linkedin.com/feed/', { waitUntil:'domcontentloaded', timeout: 30000 })`, then classify the landed URL: authenticated (`/feed`, not a login/checkpoint/authwall URL) → `✅ LinkedIn cookies valid — ready. Run: npm start`; else → `❌ LinkedIn cookies invalid/expired — re-run \`npm run setup\` with a fresh cookie export`. Always `browser.close()` in a `finally`; a launch/timeout error → `⚠️ Could not verify (browser/network): <msg>. Config written; try \`npm start\`.` Hard cap the whole verify at ~45s.
- **REMOTE:** with the provided key as `X-Scraper-API-Key`, `GET {scraperCredentials.apiUrl}/api/scraper-credentials/queue/availability` and `GET {blacklight.apiUrl}/api/scraper/queue/current-session`. 2xx (or 204/expected) → `✅ APIs reachable & key accepted`. 401/403 → `❌ API key rejected ({status}) — check the key`. Other/network → `⚠️ Could not reach {which} API ({status/err}); config written`.
- Verify NEVER changes exit code on its own (config is already written); it only prints status + the exact remediation. Browser/network access in this environment is not guaranteed — a `⚠️` outcome is acceptable and explicitly worded as "config written, verification inconclusive."

## 8. Testing

Unit (`node:test`, zero new deps; browser/network/TTY injected, never invoked in unit tests):
- `test/config/dotenv.test.js` — `parseDotEnv`: comments/blank lines ignored; first-`=` split; quoted & unquoted values; `loadDotEnvFile` precedence (existing `process.env` wins; missing file = inert; malformed line skipped, no throw).
- `test/setup/cookie-input.test.js` — `parseCookieInput` accepts a pasted JSON array and a file path (injected `readFile`); `validateLinkedinCookies` rejects non-array / empty / missing-`li_at`, accepts a set containing `li_at`.
- `test/setup/config-writer.test.js` — LOCAL answers → exact `credentials.json` (`linkedin.credentials` shape, optional other platforms) + `.env` (`NODE_ENV=development`, chosen flags, omits unset ones); REMOTE answers → `blacklight`+`scraperCredentials` blocks (no cookies) + `.env` (`NODE_ENV=production`); `mergeCredentials` preserves unrelated keys and lets wizard answers win; output contains no field the answers didn't supply.
- `test/setup/verify.test.js` — `verifyLocal`/`verifyRemote` decision logic with injected fakes: authenticated URL → ✅; login/checkpoint URL → ❌; launch throw → ⚠️; REMOTE 200 → ✅, 401/403 → ❌, network error → ⚠️.
- The interactive prompt loop and the live browser/API verification are validated empirically (run `npm run setup`), not unit-tested — same pattern used to verify the LinkedIn scraper.

Full suite (`npm test`) must remain green; the `.env` loader change must not regress existing config/registry tests (it is inert without a `.env`, and tests should `resetConfigForTest()` + control `process.env` as today).

## 9. Out of scope (YAGNI)

- No TUI/colors/spinners beyond plain prompts. No `inquirer`/`dotenv`/any new dependency.
- No editing of `docs/MAC_SETUP.md`/`WINDOWS_SETUP.md` (they already document service wrapping; the wizard's printed next-step line points there for REMOTE).
- No multi-credential-per-platform management, no cookie refresh/rotation, no encryption-at-rest (files are `0o600` + git-ignored; that is the scope).
- No changes to scraper/orchestrator behavior; this feature only adds setup + a passive `.env` loader.
