# Server-side robustness — observability, health, wizard, docs, lifecycle

**Date:** 2026-06-03
**Scope:** server-only hardening. `scrapers/linkedin.js` is NOT modified. The slice falls out of the 2026-06-03 LinkedIn workflow robustness audit and addresses Items #1, #3, #4 (observability/health, setup wizard + docs, process lifecycle) — leaving the LinkedIn extractor untouched.

## Goal

Make the running scraper's state observable from outside the process, defuse the silent-failure class that produced the aravind-mac-mini "100% empty `job_url`" incident, and tighten the setup/restart story so operators stop ending up with stale `node server.js` processes after `git pull`.

## Non-goals

- No changes to `scrapers/linkedin.js`, the menu permalink resolver, or any per-platform scraper code.
- No changes to `src/scrapers/linkedin-session.js` lifecycle (the lease-leak / reestablish-race / closes-all-pages findings are deferred to a separate slice). `isAlive()` already exists; we use it but don't extend it.
- No new metric dashboards or alert rules (that's a Grafana-side change). We only emit the data.
- No backend changes.

## Section A — Boot stamp + structured startup log (`server.js`)

**Current state (`server.js` ~lines 78–107):**
`main()` resolves config, boots telemetry, initializes the credentials client, builds the orchestrator, mounts routes, calls `app.listen(...)`, and registers SIGINT/SIGTERM handlers. There is no record in logs of which git revision is actually running, which persistent-profile dir the process is bound to, whether `LINKEDIN_HEADLESS` or `SCRAPER_STRICT_EMPTY` are set, or what PID the process owns. The Heartbeat ticks but stamps no identity.

**Change:**
1. Inside `main()` before `bootTelemetry`, resolve `bootInfo = resolveBootInfo()` from a new helper in `src/config/boot-info.js`:
   ```js
   // src/config/boot-info.js
   import { execSync } from 'child_process';
   import { readFileSync } from 'fs';
   import path from 'path';
   import { linkedInProfileDir } from '../../scrapers/linkedin.js';

   export function resolveBootInfo() {
       const gitSha = (() => {
           if (process.env.GIT_SHA) return process.env.GIT_SHA;
           try { return execSync('git rev-parse --short HEAD', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
           catch { return 'unknown'; }
       })();
       const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
       const profileDir = linkedInProfileDir();
       return {
           pid: process.pid,
           gitSha,
           bootedAt: new Date().toISOString(),
           nodeVersion: process.version,
           pkgVersion: pkg.version || '0.0.0',
           profileDir,
           headless: process.env.LINKEDIN_HEADLESS === 'true',
           strict: process.env.SCRAPER_STRICT_EMPTY === 'true',
       };
   }
   ```
   `resolveBootInfo` is pure and cacheable — call it once and pass the result around.

2. Two log enrichments in `server.js`:
   - At the existing startup line (just before `app.listen`), call `log.info('boot', bootInfo)`.
   - Wrap `app.listen` callback to include `bootInfo`:
     ```js
     app.listen(config.port, () => log.info('Server listening', { port: config.port, ...bootInfo }));
     ```
3. Pass `bootInfo` into `new Heartbeat({ bootInfo })` so every heartbeat tick carries the same identity (add a `bootInfo` field to the Heartbeat log line; do not change cadence).

**Failure modes / edge cases:**
- `git rev-parse` is unavailable in some deploys (no `git` binary, deployed via tarball). The helper returns `'unknown'` and respects `process.env.GIT_SHA` as the override path.
- `package.json` not readable → throw. We treat that as a fatal misconfiguration (process won't function anyway).

**What this buys:** for every running process, `journalctl -u qp-scraper | head` answers "what code is this and where is its profile?" in one line. The aravind-mac-mini "did the pull take effect" question becomes a `grep gitSha` away.

## Section B — `/healthz` (cheap) + `/health/linkedin` (probe) (`src/routes/health.js`)

**Current state (`src/routes/health.js`):**
A single `GET /` handler returning a static welcome payload with version `"2.0.0"` and curl examples. No readiness or liveness endpoint suitable for monitors/uptime probes. No way to ask "is the LinkedIn session alive right now" from outside the process.

**Change:**

1. Extract a `health` module under `src/routes/health.js` keeping `registerHealthRoute(app, port, deps)` but adding two more routes:
   ```js
   app.get('/healthz', (_req, res) => {
       const session = deps.getLinkedInSession();
       res.json({
           ok: true,
           ...deps.bootInfo,
           profileDirExists: existsSync(deps.bootInfo.profileDir),
           sessionAlive: session.isAlive(),
           leaseCredentialId: session.lease?.credential?.id ?? null,
           uptimeSec: Math.round(process.uptime()),
       });
   });

   app.get('/health/linkedin', async (req, res) => {
       if (req.query.probe !== '1') {
           return res.json({ probe: false, hint: 'Add ?probe=1 to run an in-session feed check. Cheap state in /healthz.' });
       }
       const session = deps.getLinkedInSession();
       try {
           const verdict = await session.withPage(`healthcheck-${Date.now()}`, async (page) => {
               await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
               const url = page.url();
               const klass = classifyLinkedinUrl(url); // already exported by scrapers/linkedin.js
               return { url, klass };
           });
           res.json({ probe: true, checkedAt: new Date().toISOString(), ...verdict, loggedIn: verdict.klass === 'authed' });
       } catch (e) {
           res.status(503).json({ probe: true, checkedAt: new Date().toISOString(), loggedIn: false, error: e.message });
       }
   });
   ```

2. Update `server.js` to register the new route with deps:
   ```js
   registerHealthRoute(app, config.port, { bootInfo, getLinkedInSession });
   ```

3. The existing `GET /` payload stays for backward compatibility but gets a `version: pkg.version` and `gitSha` field added so legacy callers gain identity too.

**Failure modes:**
- `/health/linkedin?probe=1` will actually open a browser tab and navigate. Two callers running it concurrently borrow two pages from the persistent context — fine. A flood (e.g. external monitor hitting it every 5s) would interfere with real scrapes; rate-limit via a simple in-route 30s mutex (skip if a probe ran in the last 30s; return the cached verdict).
- Cheap `/healthz` does no I/O — safe for k8s livenessProbe.

**What this buys:** the operator can curl `/healthz` and see SHA, profile path, session-alive in one line. `/health/linkedin?probe=1` answers "is my persistent profile still logged in" without leasing a credential or running a real scrape.

## Section C — URL-quality + build-info metrics (`src/metrics/registry.js` + `src/core/base-scraper.js`)

**Current state (`src/metrics/registry.js`):**
- `scraper_jobs_scraped_total{platform}` counts jobs without inspecting URL quality.
- `scraper_build_info` has `labelNames: ['node_version']` only.
- `BaseScraper.normalizeResult` (in `src/core/base-scraper.js`) emits success metrics by jobs.length without classifying the URL field.

**Change:**

1. In `src/metrics/registry.js`, add:
   ```js
   this.urlQualityTotal = new Counter({
       name: 'scraper_url_quality_total',
       help: 'Job URLs emitted by scrapers, classified at the BaseScraper output seam',
       labelNames: ['platform', 'quality'], // quality = permalink|profile_in|empty|other
   });
   this.recordUrlQuality = (platform, quality) =>
       this.#safe(() => this.urlQualityTotal.labels(platform, quality).inc());
   ```

2. Extend `scraper_build_info`:
   ```js
   this.buildInfo = new Gauge({
       name: 'scraper_build_info',
       help: 'Static build info; value 1 for the active build label tuple',
       labelNames: ['node_version', 'git_sha', 'pkg_version', 'headless', 'strict'],
   });
   this.recordBuildInfo = (info) => this.#safe(() => this.buildInfo
       .labels(info.nodeVersion, info.gitSha, info.pkgVersion, String(info.headless), String(info.strict)).set(1));
   ```
   Call `metrics.recordBuildInfo(bootInfo)` once at startup in `server.js` (right after `getMetrics()` is wired).

3. In `src/core/base-scraper.js` `normalizeResult` (or wherever jobs leave the scraper, before they are POSTed by `formatJobForBlacklight`), classify each `job.url` and emit:
   ```js
   import { classifyUrl } from './url-quality.js';
   for (const job of jobs) {
       metrics.recordUrlQuality(platform, classifyUrl(job.url));
   }
   ```

4. New tiny helper `src/core/url-quality.js`:
   ```js
   export function classifyUrl(url) {
       if (!url) return 'empty';
       const s = String(url);
       if (s.includes('/in/')) return 'profile_in';
       if (/\/feed\/update\/|\/posts\/|\/jobs\/view\//.test(s)) return 'permalink';
       return 'other';
   }
   ```
   This is shared across platforms; LinkedIn's `postSourceUrl` and the LinkedIn scraper itself are NOT changed. The classifier mirrors `postSourceUrl`'s `/in/` rule plus a generous "looks like a permalink" pattern (also covers Indeed `/jobs/view/`).

**Failure modes:**
- Metric cardinality is bounded: platforms × 4 = ~24 series total. No risk.
- If a future platform emits a URL form not matching `permalink` regex, it falls into `other` — visible without misclassifying as `empty`.

**What this buys:** `rate(scraper_url_quality_total{platform="linkedin",quality="permalink"}[5m]) / rate(scraper_url_quality_total{platform="linkedin"}[5m])` is the permalink-success-rate dashboard. If a future LinkedIn DOM rotation drops it to 0%, alerts fire even though `jobs_scraped_total` stays healthy.

## Section D — Wizard: mandatory `linkedin:login` + harder API verify (`src/setup/wizard.js` + `src/setup/verify.js`)

**Current state (`src/setup/wizard.js`):**
After collecting credentials and writing `config/credentials.json`, the wizard prints success. It never tells the operator about `npm run linkedin:login`. `verifyRemote` in `src/setup/verify.js` calls the credentials API and accepts any 2xx response — a captive-portal interstitial that returns HTTP 200 with HTML content passes the check.

**Change:**

1. After `writeConfig` succeeds (near the end of `runSetupWizard`, just before the function returns 0), print a loud, bolded block (terminal styling; no actual markdown):
   ```text
   ─────────────────────────────────────────────────────────────────────
   IMPORTANT — next step (do not skip):

   The runtime uses an on-disk LinkedIn profile, NOT the cookies you just
   saved. To make scraping work you MUST log in once:

       npm run linkedin:login

   Sign into LinkedIn in the window that opens, press Enter in this
   terminal when you see your feed, then start the server with:

       npm start
   ─────────────────────────────────────────────────────────────────────
   ```
   Then check whether `linkedInProfileDir()/Default/Cookies` exists; if it does NOT, append:
   ```text
   (We checked — your persistent profile at <path> does not exist yet.
    `npm run linkedin:login` will create it.)
   ```

2. In `src/setup/verify.js` tighten `verifyRemote`:
   - Require `content-type` to start with `application/json`.
   - Parse the response and assert the expected schema shape (whatever the credentials API already returns — minimally a top-level `ok` or `credentials` key; adjust to match observed response).
   - On any of these failing, return `{ok: false, reason: 'API returned non-JSON or unexpected schema (captive portal? wrong URL?)'}` so the operator sees a specific diagnosis instead of a green check.

**Failure modes:**
- If the credentials API changes its response shape, the wizard's schema check would false-negative. Mitigation: schema check is permissive — only requires a JSON content-type plus the presence of any one of a known set of keys (`{ok|credentials|queue|status}`). Easy to relax later.

**What this buys:** new operators get told the next step instead of staring at a working-but-failing scraper. Captive-portal LANs stop passing the wizard's API check.

## Section E — Operator docs: restart-after-pull (`docs/MAC_SETUP.md` + `docs/WINDOWS_SETUP.md` + `README.md`)

**Current state:** both setup docs describe `git pull` flows but do not mention that the long-running `node server.js` process must be restarted to pick up the new code. `MAC_SETUP.md:335` and `WINDOWS_SETUP.md:268` paragraphs imply hot-reload behavior; this is misleading.

**Change:**

1. At the top of the "updating" / "deploying changes" section in each doc, insert a bolded callout (verbatim, both docs):
   > **⚠ Node does NOT hot-reload imported source files. After `git pull`, you MUST restart the service.**
   >
   > On Mac (launchd): `launchctl kickstart -k gui/$UID/com.qp.scraper`
   > On Windows (NSSM): `nssm restart qp-scraper`
   > Bare process: kill the running `node server.js` and start a new one with `npm start`.
   >
   > **Skipping the restart is silent** — the in-memory copy of the scraper keeps executing the old code, while `git log` and the file system show the new commit. Symptoms include emitting `job_url=""` rows that backend tooling can't fix without a re-scrape.

2. Reword the existing post-recipe paragraph (`MAC_SETUP.md:335` / `WINDOWS_SETUP.md:268`) to clarify that the only thing that is re-read per scrape is `config/credentials.json`, not the scraper source.

3. In `README.md`, add a one-paragraph "After updating" subsection under "Setup" that links to the relevant platform doc.

**Failure modes:** none — pure documentation.

**What this buys:** prevents the documented aravind-mac-mini incident from recurring on every prod box at zero code cost.

## Section F — Lifecycle hygiene (`server.js` only)

**Current state (`server.js` ~lines 160–200):**
The shutdown handler runs four `withTimeout(label, promise)` steps (orchestrator, linkedin-session, credentials, etc.) and then `server.close()` → `process.exit(0)`. Quirks:
- The shared `withTimeout` is short (~2s) → `linkedin-session.shutdown()` (which closes Chromium) often gets killed mid-teardown, leaving orphan Chromium with `SingletonLock` that breaks the next boot.
- `process.on('unhandledRejection', ...)` logs only — no triggered shutdown.
- No `process.on('uncaughtException', ...)`.
- All exits are code `0`. Supervisors can't distinguish "auth dead, re-page humans" from "crashed, restart me."

**Change:**

1. Tier the shutdown:
   ```js
   async function shutdown(signal) {
       log.info(`Shutting down (${signal})...`, bootInfo);
       try { server.close(); } catch {}                         // stop accepting new HTTP
       const drainMs = 10000;
       await Promise.race([new Promise(r => setImmediate(r)), new Promise(r => setTimeout(r, drainMs))]);
       const steps = [
           ['orchestrator', orchestrator?.stop?.() ?? Promise.resolve()],
           ['linkedin-session', getLinkedInSession().shutdown()],
           ['credentials', getCredentialsClient().releaseAll()],
       ];
       for (const [label, promise] of steps) {
           try { await withTimeout(label, promise, label === 'linkedin-session' ? 15000 : 5000); }
           catch (e) { log.error(`shutdown step '${label}' failed`, { err: e.message }); }
       }
       process.exit(exitCodeFor(shutdownReason));
   }
   ```
   `withTimeout` becomes `(label, promise, ms)`; existing call sites pass the appropriate budget.

2. Track a `shutdownReason` variable defaulting to `'signal'`. Errors set it to a specific token:
   - `'auth-dead'` — set when `scrapeLinkedIn` throws AuthError repeatedly (we listen via an event emitter on `BaseScraper` or hook the orchestrator's failure path).
   - `'lease-starved'` — set when `getNextRole` returns 0 assignments for N consecutive checks.
   - `'crash'` — set in `uncaughtException` / `unhandledRejection` handlers.

3. Exit code map (`exitCodeFor`):
   - `signal` → 0
   - `auth-dead` → 2
   - `lease-starved` → 3
   - `crash` → 42
   Document this table in `README.md` (one-line per code) so supervisors can wire restart policies (`pm2 restart` on 42 only; page humans on 2; back off on 3).

4. New handlers:
   ```js
   process.on('uncaughtException', (err) => {
       log.error('uncaughtException', { err: String(err?.stack || err) });
       shutdownReason = 'crash';
       shutdown('uncaughtException').finally(() => process.exit(42));
   });
   process.on('unhandledRejection', (reason) => {
       log.error('unhandledRejection', { reason: String(reason) });
       shutdownReason = 'crash';
       shutdown('unhandledRejection').finally(() => process.exit(42));
   });
   ```

5. Optional Chromium SIGKILL backstop (deferred behind a feature toggle for now; not in this PR — listed here so we don't forget): walk `getLinkedInSession()._context?.browser()?.process?.()?.pid` (if exposed) and `process.kill(pid, 'SIGKILL')` after `linkedin-session` step times out. We log a TODO and call it out in the spec; implementation lands in the Session+Lease slice.

**Failure modes:**
- A misbehaving `uncaughtException` listener that itself throws — guard with try/catch around the `log.error` call.
- Re-entry: SIGTERM during an already-running shutdown — gate with `let shuttingDown = false`.
- `exitCodeFor` for an unknown reason falls back to `1` to retain the existing fatal-startup-error semantics.

**What this buys:** clean Chromium teardown (no orphan SingletonLock collisions on next boot), structured crash signal to supervisors, and a path for monitors to distinguish "the credentials pool is dry" (which a human needs to refill) from "the process panicked" (which the supervisor should restart).

## File map

| File | Action | Roughly |
|---|---|---|
| `src/config/boot-info.js` | new | ~40 LOC |
| `server.js` | edit boot/shutdown | ~70 LOC delta |
| `src/routes/health.js` | extend with /healthz + /health/linkedin | ~60 LOC |
| `src/metrics/registry.js` | add 1 counter + extend buildInfo + helpers | ~30 LOC |
| `src/core/url-quality.js` | new | ~15 LOC |
| `src/core/base-scraper.js` | classify job.url in normalizeResult | ~10 LOC |
| `src/setup/wizard.js` | post-write linkedin:login banner + profile-dir hint | ~30 LOC |
| `src/setup/verify.js` | tighten verifyRemote (JSON + schema check) | ~25 LOC |
| `docs/MAC_SETUP.md` | restart-after-pull callout + soften hot-reload paragraph | docs |
| `docs/WINDOWS_SETUP.md` | same | docs |
| `README.md` | "after updating" subsection + exit-code table | docs |
| `test/setup/wizard-linkedin-login-prompt.test.js` | new | ~20 LOC |
| `test/setup/verify-remote-strict.test.js` | new | ~30 LOC |
| `test/routes/healthz.test.js` | new | ~40 LOC |
| `test/core/url-quality.test.js` | new | ~25 LOC |
| `test/config/boot-info.test.js` | new | ~25 LOC |
| `test/server/shutdown-exit-codes.test.js` | new | ~30 LOC |

Total estimate: ~260 LOC code + ~170 LOC tests + ~50 LOC docs. ~430 LOC across 16 files.

## Testing approach

Pure-helper TDD where possible (`url-quality.js`, `boot-info.js`, `exitCodeFor`, `classifyUrl`). For routes use `supertest` against an app instance built with stubbed deps (mocked `getLinkedInSession`). For the wizard, drive `runSetupWizard` with a stubbed readline and capture stdout — assert the banner appears AFTER the success path. For shutdown, child-process-spawn a sandbox script that imports the shutdown helper and exit-code is asserted.

## Out of scope (deferred to next slice)

- The 6 P1 session/lease lifecycle bugs (lease leak on launch failure, reestablish single-flight, reestablish closes all pages, browser-crash listener, profile-dir cross-process lock, stale `_lease` after reportSuccess). Tracked separately; this slice intentionally does not touch `src/scrapers/linkedin-session.js` except via its existing `isAlive()` getter.
- Audit of the other 5 scrapers (Glassdoor/Indeed/Monster/Dice/TechFetch) and `src/core/base-scraper.js` internals beyond the one URL-quality classification call.
- LinkedIn permalink resolver tolerance (P0 from the audit) — separate slice; needs `scrapers/linkedin.js` edits the user has ring-fenced for now.
- Grafana dashboards / alert rules for the new metrics.
