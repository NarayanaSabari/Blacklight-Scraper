# Setup Wizard — completion notes

Status: COMPLETE. `npm test` → **102 pass / 0 fail** (26 new: dotenv, cookie-input,
config-writer, verify, wizard — all pure logic / injected-fake tested).

## Delivered
`npm run setup` / `node server.js --setup` — a zero-dependency interactive wizard:
- **LOCAL** mode: paste LinkedIn cookie JSON (one-line or multi-line, or a file
  path) + optional indeed/glassdoor/techfetch → writes `config/credentials.json`
  + `.env` (`NODE_ENV=development`); quick headed/headless LinkedIn cookie probe.
- **REMOTE** mode: `blacklight` + `scraperCredentials` apiUrl/apiKey → writes the
  remote-shaped `config/credentials.json` + `.env` (`NODE_ENV=production`);
  quick API key/availability probe.
- Idempotency: merge / overwrite / cancel when config already exists (cancel
  writes nothing, exit 1).
- Zero-dep `.env` loader in `src/config/env.js` (`parseDotEnv`/`applyDotEnv`/
  `loadDotEnvFile`) — **inert when no `.env` exists** (repo has none, so startup
  is byte-identical for anyone without one); a real OS/launchd/NSSM env value
  always wins over the file (`applyDotEnv` sets only `undefined` keys).
- Safety: secrets masked (`••••<last4>`), cookie/key values never echoed,
  files written `0o600`, git-ignore guard refuses to write if the target is not
  ignored, Ctrl-C / cancel writes nothing.

## Production impact
Only two runtime files changed: `src/config/env.js` (the `.env` loader, inert
without a `.env`) and `server.js` (a 4-line `--setup` short-circuit at the top
of `main()`, active only when the flag is passed). No scraper / orchestrator
behavior changed. Pre-existing dirty `.gitignore` / `pnpm-lock.yaml` left
unstaged throughout.

## Empirical verification (this machine)
- Full suite: 102/102.
- `.env` loader inert (no `.env` in repo → confirmed).
- `node --check server.js` parses after the insertion; `package.json`
  `scripts.setup` present.
- Isolated end-to-end smoke (REMOTE, run in a **temp cwd** so it cannot touch
  the operator's real `config/credentials.json`): `exit=0`, correct
  `credentials.json` (`blacklight`/`scraperCredentials`, no `linkedin`) and
  `.env` (`NODE_ENV=production`, `LINKEDIN_HEADLESS=true`, `SCRAPER_MODE=daemon`).
- Operator's real `config/credentials.json` confirmed still git-ignored,
  untracked (0 files), and absent from `git status` — untouched by all of this.

## Plan deviation (as-built)
The plan's verbatim `wizard.js` entered the multi-line-paste loop whenever the
first line started with `[`/`{` and only exited on a lone `.`. The plan's own
`wizard.test.js` LOCAL case scripts a complete one-line JSON array with no `.`
terminator → that would have hung. Corrected in-flight: the wizard now tries
`JSON.parse` on the one-line paste first (the common case — minified cookie
exports are one line) and only falls back to multi-line accumulation when the
paste is *not* complete JSON, with an EOF guard (`line == null → break`) so a
closed stdin can never spin. Behavior is a strict superset of the plan intent;
all 3 wizard tests pass.

## Review status
Tasks 1–4 went through full two-stage review (spec + code-quality) with two
caught-and-fixed defects (cookie-input empty-input message; verify cookie
mapping drift from production — now byte-identical to `scrapers/linkedin.js`,
which was left untouched; config-writer `mergeDotEnv` duplicate-key + blank-line
defects). Per operator direction, Task 5 (wizard/server/package) skipped the
review subagents — verified functionally instead (3/3 unit + full suite +
isolated smoke). Code review deferred to the operator.

## Out of scope (unchanged)
No new npm dependency. No scraper logic changed. `scrapers/linkedin.js` not
modified. Deferred LinkedIn enhancements D2/D3/L10 still open. Other platforms
(glassdoor/dice) remain deprioritized.
