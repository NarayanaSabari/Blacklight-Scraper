# Phase 1C-LinkedIn — completion notes

Status: COMPLETE. `npm test` 76/0. Final whole-increment review: READY TO FINISH.
Empirically re-verified with the operator's real LinkedIn cookies, HEADED.

## Delivered
- Pure `linkedinPageState(html,url,title)` classifier (results|no_results|
  auth_wall|challenge|unknown); unit-tested incl. challenge-precedence &
  junk-safety. A block can never classify as results/no_results.
- STRICT-gated (`SCRAPER_STRICT_EMPTY`) wiring: `assertNotBlocked()` on a
  challenge page; `AuthError` on auth_wall; `DomChangedError` on
  0-posts-and-not-no_results. So a real block/checkpoint now FAILS LOUD
  (cooldown + classified metric) instead of silent `reportSuccess([])`
  (audit L1/L2/D1).
- Catch routes typed errors via `instanceof` BEFORE the message-substring
  fallback: BlockedError→60m, DomChangedError→30m, AuthError→0 (auth
  recheck/rotate). Fixes the review-found CRITICAL (was: permanent 0-min
  credential burn for nearly all real blocks). `classifyError` (Plan 1A)
  labels the metric correctly (blocked/dom_changed/auth_required).
- D4: cookie `sameSite` always maps to Strict|Lax|None (was passing the
  raw 'unspecified' through → Playwright dropped ~40% of the jar).
- L5: stale "(CDP Method)" banner corrected.
- Browser HEADED by default per operator requirement; `LINKEDIN_HEADLESS=true`
  escape hatch for no-display environments.
- Returns the BaseScraper `{ jobs, emptyConfirmed }` contract (Plan 1A).

## Empirical proof (headed, real cookies, this machine)
| Run | Cookies | Auth | Posts | Time |
|---|---|---|---|---|
| OFF (STRICT unset) | 24/24 (was 14/24 — D4 fixed) | logged in | 100 | 196s |
| STRICT=true | 24/24 | logged in | 100 | 187s |

- Headed launch verified working here (HEADED LAUNCH OK ~3.7s).
- OFF is byte-identical (still ~100 posts/~196s vs the pre-1C baseline
  100/193s).
- STRICT-on does NOT false-throw on a healthy page — `linkedinPageState`
  classifies the live page as `results`; full 100-post scrape succeeds.
  (The false-positive risk was the main concern; it is empirically clean.)

## Production impact
OFF (shipped default) = byte-identical scrape FLOW except: D4 (more
cookies — safe), banner text, `{jobs,emptyConfirmed}` return (BaseScraper
handles identically), HEADED default (intended operator change), and a
read-only `page.content()` on the 0-posts path. Activation = set
`SCRAPER_STRICT_EMPTY=true` per host (instantly reversible). Verified by
the 5-line inertness probe (OK gated/strict/banner/samesite/headed) and
the empirical OFF re-run.

## Deferred follow-ups (enhancements, NOT safety; documented, not dropped)
- D2: post permalink recovery (NEW search DOM has none — `url` falls back
  to author profile).
- D3: scroll volume / incremental human scroll (~60 scrolls / ~190s).
- L10: module-global `CONFIG` race on concurrent in-process scrapes;
  locale/timezone hardcoded vs the cookie's tz.
- Cosmetic: the legacy `navigateToSearch` "No recognizable container" log
  still prints on healthy OFF runs (legacy log path left untouched for
  byte-identity; STRICT path classifies correctly regardless).
- `linkedinPageState` omits DataDome markers (LinkedIn doesn't use
  DataDome — correctly out of scope; still a loud failure if it ever did).

## Credentials
`config/credentials.json` holds the operator's LinkedIn cookies LOCALLY
only — git-ignored, never committed, untracked (`git check-ignore`
confirms; `git ls-files` count 0). Values never printed. Delete on request.
