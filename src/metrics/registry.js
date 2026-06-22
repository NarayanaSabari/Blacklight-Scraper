// Metrics registry — single source of truth for every counter/gauge/histogram
// the scraper emits. All collectors live here so there's one place to find
// and modify them.
//
// Design notes:
//   • We use a dedicated prom-client Registry (not the default global one) so
//     the Pushgateway push code can serialize exactly this set of metrics.
//   • Default labels (instance/host/os/version/mode) are attached at
//     construction time and flow through to every series automatically.
//   • Every incrementing helper is wrapped in a try/catch so bad label values
//     can never crash the scraping path. Observability must never take down
//     the thing it's observing.

import os from 'os';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { getConfig } from '../config/env.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('metrics');

// Histogram bucket choices: session durations range from ~10s (Monster HTTP)
// to ~5min (Dice full Playwright crawl). Buckets should cover that range
// without being wasteful.
const SESSION_BUCKETS = [5, 10, 30, 60, 120, 180, 300, 600, 1200];

function defaultInstanceId() {
    return process.env.INSTANCE_ID || os.hostname();
}

function defaultMode() {
    return process.env.SCRAPER_MODE === 'daemon' ? 'daemon' : 'interactive';
}

function detectOs() {
    const platform = process.platform;
    if (platform === 'darwin') return 'mac';
    if (platform === 'win32') return 'windows';
    return 'linux';
}

class MetricsRegistry {
    constructor() {
        this.registry = new Registry();
        const cfg = getConfig();
        const telemetry = cfg.telemetry ?? {};

        this.defaultLabels = Object.freeze({
            // instance/mode come from config so the scraper can be
            // uniquely identified per host; backend overwrites these
            // again server-side as an extra spoof-prevention layer.
            instance: telemetry.instance || defaultInstanceId(),
            host: os.hostname(),
            os: detectOs(),
            version: '2.0.0',
            mode: telemetry.mode || defaultMode(),
            node_env: cfg.nodeEnv,
        });
        this.registry.setDefaultLabels(this.defaultLabels);

        // Process-level metrics (event loop lag, memory, gc) — opt-in via env.
        if (process.env.METRICS_DEFAULT_PROCESS !== 'false') {
            collectDefaultMetrics({ register: this.registry, prefix: 'scraper_node_' });
        }

        this.buildCollectors();
    }

    buildCollectors() {
        const reg = [this.registry];

        // Liveness ---------------------------------------------------------
        this.up = new Gauge({
            name: 'scraper_up',
            help: 'Process liveness ONLY — 1 while the push loop runs; never 0 in practice. NOT scrape health: a 100%-blocked scraper still reports 1. Use scraper_last_nonzero_scrape_timestamp_seconds for scrape health.',
            registers: reg,
        });
        this.up.set(1);

        this.lastHeartbeat = new Gauge({
            name: 'scraper_last_heartbeat_timestamp_seconds',
            help: 'Unix seconds of the scraper\'s last heartbeat tick.',
            registers: reg,
        });

        this.startTimestamp = new Gauge({
            name: 'scraper_start_timestamp_seconds',
            help: 'Unix seconds when the scraper process started.',
            registers: reg,
        });
        this.startTimestamp.set(Math.floor(Date.now() / 1000));

        this.buildInfo = new Gauge({
            name: 'scraper_build_info',
            help: 'Build info; always 1. Useful for joining by version/sha/headless/strict labels.',
            labelNames: ['node_version', 'git_sha', 'pkg_version', 'headless', 'strict'],
            registers: reg,
        });
        // Sentinel default so the gauge has a value before server.js calls
        // recordBuildInfo() with the real labels. Replaced at boot.
        this.buildInfo.labels(process.version, 'unknown', '0.0.0', 'false', 'false').set(1);

        // Sessions ---------------------------------------------------------
        this.sessionsTotal = new Counter({
            name: 'scraper_sessions_total',
            help: 'Total scrape sessions, by platform and result.',
            labelNames: ['platform', 'result'], // result = success|failed|skipped
            registers: reg,
        });

        this.sessionDurationSeconds = new Histogram({
            name: 'scraper_session_duration_seconds',
            help: 'Scrape session duration per platform.',
            labelNames: ['platform', 'result'],
            buckets: SESSION_BUCKETS,
            registers: reg,
        });

        this.jobsScrapedTotal = new Counter({
            name: 'scraper_jobs_scraped_total',
            help: 'Total jobs successfully scraped per platform.',
            labelNames: ['platform'],
            registers: reg,
        });

        this.urlQualityTotal = new Counter({
            name: 'scraper_url_quality_total',
            help: 'Job URLs emitted by scrapers, classified at the BaseScraper output seam (quality = permalink|profile_in|empty|other).',
            labelNames: ['platform', 'quality'],
            registers: reg,
        });

        // Silent-block visibility (spec O1/O3) ----------------------------
        // jobsScrapedTotal is a monotonic counter — it simply STOPS
        // incrementing when a scraper is blocked, which is invisible on a
        // rate() panel and identical to "no jobs matched". These three
        // make the silent case loud:
        this.jobsLastScraped = new Gauge({
            name: 'scraper_jobs_last_scraped',
            help: 'Jobs from the most recent scrape per platform, set on EVERY session including 0. A flatline at 0 is the silent-block / DOM-change signal.',
            labelNames: ['platform'],
            registers: reg,
        });

        this.lastNonzeroScrapeTimestamp = new Gauge({
            name: 'scraper_last_nonzero_scrape_timestamp_seconds',
            help: 'Unix seconds of the last scrape that returned > 0 jobs, per platform. Staleness here = blocked/broken even while scraper_up=1.',
            labelNames: ['platform'],
            registers: reg,
        });

        this.zeroResultSessionsTotal = new Counter({
            name: 'scraper_zero_result_sessions_total',
            help: 'Sessions that did not throw but yielded 0 jobs and were NOT positively confirmed-empty (suspected silent block / DOM change).',
            labelNames: ['platform'],
            registers: reg,
        });

        this.sessionsAllFailedTotal = new Counter({
            name: 'scraper_sessions_all_failed_total',
            help: 'Assignments where every platform failed or yielded zero. Completed anyway (backend coordination) but flagged for alerting.',
            registers: reg,
        });

        this.jobsSubmittedTotal = new Counter({
            name: 'scraper_jobs_submitted_total',
            help: 'Total jobs submitted to the Blacklight backend per platform.',
            labelNames: ['platform', 'status'], // status = success|failed
            registers: reg,
        });

        this.failuresTotal = new Counter({
            name: 'scraper_failures_total',
            help: 'Categorized scrape failures per platform.',
            labelNames: ['platform', 'reason'],
            registers: reg,
        });

        // LinkedIn per-query yield -----------------------------------------
        // The LinkedIn scraper iterates AI-generated search-query variants
        // for each role (3 by default) — this counter tracks how many
        // unique posts each query index contributed. Lets Grafana surface
        // whether the AI prompt is generating useful variants, and which
        // index slot is the highest-yield slot in steady state.
        this.linkedinQueryYieldTotal = new Counter({
            name: 'scraper_linkedin_query_yield_total',
            help: 'Posts attributed to each LinkedIn query variant (per role).',
            labelNames: ['query_index'], // 0|1|2 (or "0" for the legacy single-template)
            registers: reg,
        });

        // Queue ------------------------------------------------------------
        this.queueChecksTotal = new Counter({
            name: 'scraper_queue_checks_total',
            help: 'Outcomes of Blacklight queue poll attempts.',
            labelNames: ['result'], // job_found|empty|active_session|skipped_busy|error
            registers: reg,
        });

        this.queueLastSuccessTimestamp = new Gauge({
            name: 'scraper_queue_last_success_timestamp_seconds',
            help: 'Unix seconds of the last successfully completed queue cycle.',
            registers: reg,
        });

        // Browser lifecycle ------------------------------------------------
        this.browserLaunchesTotal = new Counter({
            name: 'scraper_browser_launches_total',
            help: 'Playwright browser launches per platform.',
            labelNames: ['platform', 'result'], // success|failure
            registers: reg,
        });

        this.browserCleanupFailuresTotal = new Counter({
            name: 'scraper_browser_cleanup_failures_total',
            help: 'Browser or context close() failures in scraper finally blocks.',
            labelNames: ['platform'],
            registers: reg,
        });

        // API interactions -------------------------------------------------
        this.blacklightApiRequestsTotal = new Counter({
            name: 'scraper_blacklight_api_requests_total',
            help: 'Requests issued to the Blacklight scraper API.',
            labelNames: ['endpoint', 'status'], // status = 2xx|4xx|5xx|error
            registers: reg,
        });

        this.credentialsFetchesTotal = new Counter({
            name: 'scraper_credentials_fetches_total',
            help: 'Credential fetch attempts per platform.',
            labelNames: ['platform', 'result'], // found|none|error
            registers: reg,
        });

        this.credentialRefreshesTotal = new Counter({
            name: 'scraper_credential_refreshes_total',
            help: 'Cookie-jar write-back attempts per platform.',
            labelNames: ['platform', 'outcome'], // refreshed|skipped_local|skipped_no_li_at|skipped_too_large|error
            registers: reg,
        });

        // Logger tap -------------------------------------------------------
        this.logLinesTotal = new Counter({
            name: 'scraper_log_lines_total',
            help: 'Log lines emitted, by level and scope.',
            labelNames: ['level', 'scope'],
            registers: reg,
        });

        this.logLinesDroppedTotal = new Counter({
            name: 'scraper_log_lines_dropped_total',
            help: 'Log lines dropped before reaching Loki (ring-buffer overflow or sustained push failure). A nonzero rate means logs are being LOST — Loki outage or backpressure — and the live-log panels are incomplete (audit L3).',
            registers: reg,
        });
    }

    // ---------------------------------------------------------------------
    // Safe helpers — wrap every inc/observe so label errors can't crash the
    // scraping loop. If a helper ever throws, we log once and move on.
    // ---------------------------------------------------------------------

    #safe(fn) {
        try { fn(); } catch (error) {
            log.warn('metric write failed', { err: error.message });
        }
    }

    recordSession(platform, result, durationMs) {
        this.#safe(() => {
            this.sessionsTotal.labels(platform, result).inc();
            if (Number.isFinite(durationMs)) {
                this.sessionDurationSeconds.labels(platform, result).observe(durationMs / 1000);
            }
        });
    }

    recordJobsScraped(platform, count) {
        const n = Number.isFinite(count) && count > 0 ? count : 0;
        this.#safe(() => {
            // Gauge is set on EVERY session, including 0 — that is the
            // whole point: a flatline at 0 is the silent-block signal.
            this.jobsLastScraped.labels(platform).set(n);
            if (n > 0) {
                this.jobsScrapedTotal.labels(platform).inc(n);
                this.lastNonzeroScrapeTimestamp
                    .labels(platform)
                    .set(Math.floor(Date.now() / 1000));
            }
        });
    }

    // Called by BaseScraper when a scrape returned 0 jobs WITHOUT a
    // positive confirmed-empty signal (the Plan 1A `noteZeroJobs?.()`
    // seam). This is the metric an operator alerts on for silent blocks.
    noteZeroJobs(platform) {
        this.#safe(() => this.zeroResultSessionsTotal.labels(platform).inc());
    }

    // Called (in Plan 1B-pipeline) when an entire assignment had zero
    // successful platforms. Defined here so the metric exists and is
    // testable now; the call site lands with the orchestrator work.
    recordSessionAllFailed() {
        this.#safe(() => this.sessionsAllFailedTotal.inc());
    }

    recordUrlQuality(platform, quality) {
        this.#safe(() => this.urlQualityTotal.labels(platform ?? 'unknown', quality ?? 'unknown').inc());
    }

    recordBuildInfo(info) {
        this.#safe(() => {
            // Reset to drop the boot-time sentinel.
            this.buildInfo.reset();
            this.buildInfo.labels(
                String(info.nodeVersion ?? 'unknown'),
                String(info.gitSha ?? 'unknown'),
                String(info.pkgVersion ?? '0.0.0'),
                String(!!info.headless),
                String(!!info.strict),
            ).set(1);
        });
    }

    recordJobsSubmitted(platform, status, count) {
        if (!count || count < 0) return;
        this.#safe(() => this.jobsSubmittedTotal.labels(platform, status).inc(count));
    }

    recordFailure(platform, reason) {
        this.#safe(() => this.failuresTotal.labels(platform, reason || 'unknown').inc());
    }

    recordLinkedInQueryYield(queryIndex, count) {
        if (!count || count < 0) return;
        this.#safe(() =>
            this.linkedinQueryYieldTotal.labels(String(queryIndex)).inc(count),
        );
    }

    recordQueueCheck(result) {
        this.#safe(() => this.queueChecksTotal.labels(result).inc());
        if (result === 'job_found') {
            this.#safe(() => this.queueLastSuccessTimestamp.set(Math.floor(Date.now() / 1000)));
        }
    }

    recordBrowserLaunch(platform, result = 'success') {
        this.#safe(() => this.browserLaunchesTotal.labels(platform, result).inc());
    }

    recordBrowserCleanupFailure(platform) {
        this.#safe(() => this.browserCleanupFailuresTotal.labels(platform).inc());
    }

    recordBlacklightApiRequest(endpoint, status) {
        this.#safe(() => this.blacklightApiRequestsTotal.labels(endpoint, status).inc());
    }

    recordCredentialsFetch(platform, result) {
        this.#safe(() => this.credentialsFetchesTotal.labels(platform, result).inc());
    }

    recordCredentialRefresh(platform, outcome) {
        this.#safe(() => this.credentialRefreshesTotal.labels(platform, outcome).inc());
    }

    recordLogLine(level, scope) {
        this.#safe(() => this.logLinesTotal.labels(level, scope || 'root').inc());
    }

    recordLogLinesDropped(count) {
        if (!count || count < 0) return;
        this.#safe(() => this.logLinesDroppedTotal.inc(count));
    }

    markHeartbeat() {
        this.#safe(() => {
            this.lastHeartbeat.set(Math.floor(Date.now() / 1000));
            this.up.set(1);
        });
    }

    // Returns the raw Prometheus text format.
    async snapshot() {
        return this.registry.metrics();
    }

    // Content type string for the /metrics endpoint response.
    get contentType() {
        return this.registry.contentType;
    }
}

// Singleton — one registry per process.
let instance = null;

export function getMetrics() {
    if (!instance) {
        instance = new MetricsRegistry();
    }
    return instance;
}

// Test-only helper
export function resetMetricsForTest() {
    instance = null;
}
