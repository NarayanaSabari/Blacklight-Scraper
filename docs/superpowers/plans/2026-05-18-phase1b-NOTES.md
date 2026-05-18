# Phase 1B (observability core) — completion notes

Status: COMPLETE. All tests green (`npm test`, fail 0).

Delivered:
- M1 host-qualified the authwall block fragment (linkedin.com/authwall);
  M2 HTTP 401 test; M3 reworded classify.js header comment.
- registry.js: scraper_jobs_last_scraped (gauge, every session incl 0),
  scraper_last_nonzero_scrape_timestamp_seconds (gauge, >0 only),
  scraper_zero_result_sessions_total (counter, via noteZeroJobs()),
  scraper_sessions_all_failed_total (counter, via recordSessionAllFailed()
  — metric defined now, call site lands with 1B-pipeline). scraper_up help
  reworded to stop claiming health (O10). The recordJobsScraped rewrite
  also incidentally fixed a latent Infinity-passes-the-guard bug.
- BaseScraper->registry zero/nonzero wiring locked by integration tests.
- observability/alerts.yml + dashboard.json + README committed (O4);
  README documents heartbeat != scrape health (O3). ScraperNoNonzeroScrape
  has a cold-start `> 0` guard so a fresh platform does not false-fire.
- .env.example documents SCRAPER_STRICT_EMPTY=false (M4); MAC/WINDOWS
  runbooks set SCRAPER_MODE=daemon (O5).

Production impact: observe-only. No scraper/orchestrator/api source
changed (verified: `git diff origin/main -- src/scrapers src/queue
src/api scrapers` is empty). New metric series are emitted by code paths
that already ran.

Known pre-existing tech debt (NOT 1B scope, flag for a future cleanup):
- recordJobsSubmitted() and recordLinkedInQueryYield() in registry.js
  still use the old `if (!count || count < 0) return` guard, which lets
  Infinity through (same class of bug recordJobsScraped just fixed).
  Low risk (counts come from array lengths) but worth normalizing.

NOT done — required follow-ups:
- Plan 1B-pipeline: orchestrator C1/C3/O9 — submit a distinguishable
  signal for 0-job/blocked platforms and call recordSessionAllFailed()
  when summary.successful===0; needs a client/metrics injection seam on
  QueueOrchestrator to be TDD-able without live HTTP. Do NOT change the
  on-the-wire submit `status` to an unknown value without backend
  coordination.
- Plan 1C: per-scraper assertNotBlocked() at nav/pre-parse points +
  return {jobs,emptyConfirmed:true} only on positively-confirmed empty;
  fix Indeed loginSuccess timing (I13), Indeed page-1 pagination (I2),
  Glassdoor early-abort (I14), LinkedIn mid-scrape detection (L2). THEN
  flip SCRAPER_STRICT_EMPTY=true per host. M5 contract: 1C must only
  pass detectBlock a block-page title, never a scraped job title.
- Pre-existing, still out of scope: .gitignore + pnpm-lock.yaml drift
  (pnpm-lock drift is audit O7 -> Phase 5).
