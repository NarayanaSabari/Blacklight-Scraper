# Phase 1B-pipeline — completion notes

Status: COMPLETE. All tests green (`npm test`, fail 0).

Delivered:
- DI seam on QueueOrchestrator (optional client/metrics/scraperResolver);
  behavior-neutral in production (server.js passes none).
- C3: all-failed assignment now fires metrics.recordSessionAllFailed()
  + a `scraper_alert:'session_all_failed'` error log; completeSession is
  STILL always called (backend coordinates sibling sessions).
- O9: a 0-job 'success' submission now emits a distinct
  `scraper_alert:'submitted_zero'` warn log. Wire status + metric
  UNCHANGED (no backend-contract change; the metric dimension is already
  scraper_zero_result_sessions_total from Plan 1B).

Production impact: observability-only. No scraper code, no HTTP
request/response contract change, server.js untouched. Verified:
`git diff origin/main -- src/scrapers scrapers src/api server.js` empty.

The ScraperAllFailedSessions alert (committed in Plan 1B) now has a live
producer (recordSessionAllFailed call site) — it can fire for real.

NOT done — the remaining Phase 1 work:
- Plan 1C (production-behavior-changing): wire assertNotBlocked() into
  the 6 scrapers at nav/pre-parse points; return {jobs,emptyConfirmed:
  true} only on a positively-confirmed empty result; fix Indeed
  loginSuccess timing (I13), Indeed page-1 pagination (I2), Glassdoor
  early-abort (I14), LinkedIn mid-scrape detection (L2). Only AFTER 1C
  lands per-host, flip SCRAPER_STRICT_EMPTY=true. M5 contract: 1C must
  only pass detectBlock a block-page title, never a scraped job title.
  This is the slice that actually changes live scraper behavior — it
  needs an explicit pre-flip checkpoint with the user.
- O9 on-the-wire status change (submit a distinguishable status to the
  backend) remains deferred — needs backend coordination/sign-off.
- Pre-existing, still out of scope: .gitignore + pnpm-lock.yaml drift
  (pnpm-lock drift is audit O7 -> Phase 5); the recordJobsSubmitted /
  recordLinkedInQueryYield Infinity-guard tidy (1B NOTES).
