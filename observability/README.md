# Observability artifacts

Version-controlled so the metric↔alert contract is reviewable (audit O4).

- `alerts.yml` — Prometheus alerting rules. Load into the Prometheus that
  scrapes this fleet's Pushgateway (rule_files: in prometheus.yml, or an
  Alertmanager-managed rule group).
- `dashboard.json` — import into Grafana (Dashboards → Import → Upload JSON).

## Heartbeat is NOT scrape health

`scraper_up` and `scraper_last_heartbeat_timestamp_seconds` only prove the
Node process is alive and the push loop is running. A scraper that is
**100% blocked still reports `scraper_up = 1`** and a fresh heartbeat. Do
not build "is the scraper working?" alerts on those.

Scrape health is `scraper_last_nonzero_scrape_timestamp_seconds` (per
platform) and `scraper_zero_result_sessions_total`. The committed alerts
key off those. `SCRAPER_MODE=daemon` only adds a process-offline alert —
it is necessary but not sufficient; the residential hosts that get
blocked most must run daemon mode AND have these rules loaded.

## Status of detection

Until Plan 1C wires `assertNotBlocked()` into the scrapers, a block still
surfaces primarily as "0 jobs" (→ `scraper_zero_result_sessions_total` +
`scraper_jobs_last_scraped` flatline), not as a `blocked` failure. The
`ScraperZeroResultRatioHigh` / `ScraperNoNonzeroScrape` alerts are the
load-bearing ones in that interim; `ScraperBlockedFailures` becomes
primary once 1C lands.
