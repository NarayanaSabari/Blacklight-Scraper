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
            help: 'Whether the scraper process is up (1) or down (0). Always 1 while pushing.',
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
            help: 'Build info; always 1. Useful for joining by version/os labels.',
            labelNames: ['node_version'],
            registers: reg,
        });
        this.buildInfo.labels(process.version).set(1);

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

        // Logger tap -------------------------------------------------------
        this.logLinesTotal = new Counter({
            name: 'scraper_log_lines_total',
            help: 'Log lines emitted, by level and scope.',
            labelNames: ['level', 'scope'],
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
        if (!count || count < 0) return;
        this.#safe(() => this.jobsScrapedTotal.labels(platform).inc(count));
    }

    recordJobsSubmitted(platform, status, count) {
        if (!count || count < 0) return;
        this.#safe(() => this.jobsSubmittedTotal.labels(platform, status).inc(count));
    }

    recordFailure(platform, reason) {
        this.#safe(() => this.failuresTotal.labels(platform, reason || 'unknown').inc());
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

    recordLogLine(level, scope) {
        this.#safe(() => this.logLinesTotal.labels(level, scope || 'root').inc());
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
