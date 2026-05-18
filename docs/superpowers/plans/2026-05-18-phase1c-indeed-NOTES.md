# Phase 1C-Indeed — completion notes

Status: COMPLETE. All tests green (`npm test`, fail 0).

Delivered (flag-gated; SCRAPER_STRICT_EMPTY OFF by default = byte-identical
scrape FLOW to pre-1C Indeed; only the return is the BaseScraper
{jobs,emptyConfirmed} contract shape, which Plan 1A handles identically):
- pure indeedNoResults(html) confirmed-empty detector (unit-tested,
  challenge-page != confirmed-empty verified).
- import assertNotBlocked + STRICT const; assertNotBlocked() wired
  post-navigation, STRICT-gated.
- I13: loginSuccess deferred to confirmed page-0 (STRICT only; legacy
  `if (!STRICT) loginSuccess = true;` preserved).
- I2: page-0 zero with no no-results marker throws (STRICT only); later
  pages still legitimately end pagination; confirmed-empty sets the flag.
- static guard tests assert every assertNotBlocked() is STRICT-gated,
  the I2 throw is STRICT-gated, and the legacy loginSuccess path exists.

Production impact when OFF (shipped default): scrape flow unchanged
(verified: legacy early loginSuccess, break-on-any-zero, no
assertNotBlocked call; inertness probe OK gated / OK I13). Activation =
set SCRAPER_STRICT_EMPTY=true on a host (instantly reversible). A page-0
CF/DataDome block then throws -> 60-min cooldown + 'blocked' metric; an
ambiguous page-0 zero (no no-results marker, not a CF page) throws ->
30-min cooldown (DOM-change-like). M5 honored: assertNotBlocked sees the
search-results document, never a scraped job title.

Remaining Plan 1C scrapers (same flag-gated template, parallelizable —
disjoint files): glassdoor.js (I3/I14), dice.js (T9), techfetch.js
(T1/T2/T3/T4), linkedin.js (L1/L2). monster.js is de-registered (skip
until residential proxies). Only AFTER all are wired should the operator
flip SCRAPER_STRICT_EMPTY=true per host (start with one host, watch the
Plan 1B zero-result / blocked / ScraperNoNonzeroScrape alerts).
