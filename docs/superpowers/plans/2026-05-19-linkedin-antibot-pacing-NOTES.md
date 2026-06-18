# LinkedIn anti-bot pacing — completion notes

Status: COMPLETE. `npm test` → **133 / 0**.

## Delivered (scraper-only, `scrapers/linkedin.js`)
Three pure, exported, unit-tested helpers + thin wiring + 7 env knobs:
- `readPacingConfig(env)` → `{maxScrolls, noProgressStop, scrollPacing}` (mirrors `env.js::toInt`; absent/garbage → default, never throws), folded into `CONFIG` via `...readPacingConfig()`.
- `pickSessionQuery(queries, rng)` → one uniformly-random variant (clamped in-bounds for any rng∈[0,1]); `null` for empty/non-array.
- `nextScrollDelay(scrollIndex, rng, cfg)` → jittered base delay + a longer "reading pause" every `pauseEvery` scrolls.

Wiring: `scrapeLinkedIn` runs **exactly one** randomly-chosen variant per session (logs `🎲 Variant [k/N]`); the `for(qi…)` loop now iterates once, so the per-query `/feed/` re-auth and the 8–12 s inter-query delay are structurally eliminated (loop/delay block left byte-unchanged — degenerate, not deleted). `extractPosts` uses `CONFIG.maxScrolls` (def **60**, was 150), `CONFIG.noProgressStop` (def **4**, was 5), and `await wait(nextScrollDelay(scrollAttempts, Math.random, CONFIG.scrollPacing))` (was `randomDelay(2000,3000)`). Stale "runs each query sequentially / 3 searches" doc comments corrected to match (honesty fix, T4 review Minor #2).

## Env knobs (all default to gentler-but-functional; tune per host, no code change)
`LINKEDIN_MAX_SCROLLS`=60 · `LINKEDIN_NOPROGRESS_STOP`=4 · `LINKEDIN_SCROLL_MIN_MS`=2500 · `LINKEDIN_SCROLL_MAX_MS`=5000 · `LINKEDIN_SCROLL_PAUSE_EVERY`=6 · `LINKEDIN_SCROLL_PAUSE_MIN_MS`=8000 · `LINKEDIN_SCROLL_PAUSE_MAX_MS`=15000.

## Quality gates
Every task: combined spec+code-quality review (opus), all APPROVED. Reviewers verified by trace: `pickSessionQuery` clamp valid across full `[0,1]` (incl. rng=1 → last, never undefined); `nextScrollDelay` no modulo-by-zero/NaN, 1-based `scrollAttempts` → clean every-6th-scroll pause cadence, no off-by-one; no collateral multi-query logic broken (dedup/perQueryYield degrade correctly to single-pass); verdict/`{jobs,emptyConfirmed}`/`maxPosts(100)`/error taxonomy unchanged; the qi-loop + inter-query block byte-identical to pre-change.

## Non-goals honoured (YAGNI)
No orchestrator/backend/proxy changes; no persistent browser profile; auth-detection mechanism unchanged; `maxPosts` 100 unchanged; legacy `CONFIG.scrollDelay:2000` left in place (now unread on the scroll path — intentional per spec §B2, a later cleanup if desired).

## Verification
- Full suite 133/0 (new: `readPacingConfig` ×4, `pickSessionQuery` ×4, `nextScrollDelay` ×4 in `test/scrapers/`).
- `node --check scrapers/linkedin.js` clean; wiring probe shows all 5 call sites present and 0 old forms / 0 stale comments remaining.
- Pure logic exhaustively unit-tested; the browser-driven scrape path is not unit-testable (consistent with the rest of `test/scrapers/`).

## HONEST CAVEAT — anti-bot effectiveness not proven here
"LinkedIn no longer kills the session after ~1 query" is a property of LinkedIn's live anti-bot, observable only as production session-survival over time. There is no valid prod credential this session, so a real REMOTE scrape was not run. What is verified: the pure logic (exhaustive units), the wired path (syntax + suite + static probe), and the design rationale. Effectiveness is documented as **expected, to be confirmed by ops** watching prod credential-12 `last_success_at` / LinkedIn starvation rate after rollout — **not asserted as proven**. The empirical local headed run (the plan's Task 6 Step 3) was likewise not executed here for the same no-valid-credential reason; behaviour is covered by the unit suite + review traces.

## Diagnosis context
This is **action #4** of the 2026-05-19 diagnosis. #1/#2 are ops (add email+password to credential 12; add more LinkedIn creds — no code). #3 (cookie write-back) shipped in PR #7. #5 (backend `report_credential_failure` honoring positive `cooldown_minutes`) is a separate backend handoff — still open.
