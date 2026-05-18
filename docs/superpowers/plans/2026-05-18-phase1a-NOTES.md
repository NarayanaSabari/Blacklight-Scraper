# Phase 1A — completion notes

Status: COMPLETE. All tests green (`npm test`, fail 0).

Delivered (pure additions / backward-compatible):
- BlockedError, DomChangedError (src/core/errors.js)
- classify.js maps them -> 'blocked' / 'dom_changed'
- src/core/block-detection.js: detectBlock() + assertNotBlocked()
  (structural, pure, unit-tested; markers tightened to challenge-
  specific tokens — js.datadome.co not bare 'datadome'; segment-
  anchored /challenge/ /captcha/ — to avoid job-page false positives)
- base-scraper.js: normalized return contract ({jobs,emptyConfirmed}
  or Array) + opt-in strictEmpty + noteZeroJobs?() seam
- Node built-in test harness (npm test), no new deps

Production impact: NONE by default. Only new runtime effect is one
extra log.warn line on a 0-job scrape. The behavioral flip is gated
behind strictEmpty / SCRAPER_STRICT_EMPTY (default OFF).

Execution-environment facts (for 1B/1C):
- Host runs Node v24.14.0 (NOT 20 as README says). `node --test <dir>`
  is broken on 24; package.json uses `node --test 'test/**/*.test.js'`.
- node_modules were installed with pnpm. pnpm-lock.yaml is drifted
  (cloakbrowser added to package.json without lockfile update) — this
  is pre-existing audit finding O7, deliberately left UNCOMMITTED and
  out of Plan 1A scope (fix in Phase 5).
- A working-tree `.gitignore` modification predates this work and was
  left untouched throughout.

Required next (do NOT enable strictEmpty in prod until BOTH land):
- Plan 1B: src/metrics/registry.js — add noteZeroJobs(), the
  scraper_jobs_last_scraped gauge, scraper_zero_result_sessions_total,
  result="empty"/"blocked" labels, 'blocked'/'dom_changed' in the
  failures label set; orchestrator C1/C3/O9; commit alert rules +
  dashboard; SCRAPER_MODE=daemon in runbooks.
- Plan 1C: each scraper calls assertNotBlocked() at nav/pre-parse
  points and returns { jobs, emptyConfirmed:true } ONLY on a
  positively confirmed empty result set; fix Indeed loginSuccess
  timing (I13), Indeed page-1 pagination (I2), Glassdoor early-abort
  (I14), LinkedIn mid-scrape detection (L2). THEN enable
  SCRAPER_STRICT_EMPTY per host.

Final whole-increment review advisories (non-blocking for 1A — these
are pre-1B/1C action items; detectBlock is unused in prod until 1C):
- M1: `/authwall` in BLOCK_URL_FRAGMENTS has no trailing-slash anchor
  (unlike /challenge/ /captcha/ /checkpoint/). Tighten to a segment-
  safe form before 1C wires detectBlock into LinkedIn, or a job URL
  containing the substring could false-positive.
- M2: HTTP 401 path (kind 'http_forbidden') has no dedicated test —
  add a one-line test in 1B/1C (behaviour is correct, just untested).
- M3: classify.js header comment ("Reasons must match the label set
  in registry.js") is slightly misleading — prom-client does NOT
  enforce label values; the real coupling is Grafana dashboards/alerts
  (Plan 1B). Reword when 1B touches registry.
- M4: add `SCRAPER_STRICT_EMPTY` (default false, with a comment) to
  `.env.example` as part of 1B/1C so operators can discover the flag.
- M5: `/security check/i` title regex matches the phrase anywhere —
  safe ONLY because 1C must pass detectBlock a block-page title, never
  a scraped job-listing title. Enforce that contract in 1C wiring.
