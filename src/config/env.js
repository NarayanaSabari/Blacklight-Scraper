// Environment configuration — loaded once at startup, validated, immutable.
// No secrets are logged here; values flow through to modules that need them.

import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULTS = Object.freeze({
    NODE_ENV: 'production',
    PORT: 3001,
    LOG_LEVEL: 'info',
    QUEUE_CHECK_INTERVAL_MS: 30_000,
    QUEUE_CHECK_STARTUP_DELAY_MS: 5_000,
    CDP_PORT: 9222,
    CHROME_PATH: process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/usr/bin/google-chrome',
    METRICS_PUSH_INTERVAL_MS: 30_000,
    LOKI_PUSH_INTERVAL_MS: 5_000,
    LOKI_PUSH_BATCH_MAX: 200,
    // The backend no longer drives location-specific scraping (only role-based).
    // Per-platform scrapers still need a location string for their search URLs,
    // so each instance falls back to this. Override with SCRAPER_DEFAULT_LOCATION
    // if you want to scope a scraper to a tighter region.
    SCRAPER_DEFAULT_LOCATION: 'United States',
});

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function loadCredentialsFile() {
    const credentialsPath = path.join(process.cwd(), 'config', 'credentials.json');
    try {
        return JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
    } catch {
        return null;
    }
}

function buildConfig() {
    const nodeEnv = process.env.NODE_ENV || DEFAULTS.NODE_ENV;
    const credentials = loadCredentialsFile();

    const blacklight = credentials?.blacklight ?? null;
    const scraperCredentials = credentials?.scraperCredentials ?? null;

    return Object.freeze({
        nodeEnv,
        isDevelopment: nodeEnv === 'development',
        isProduction: nodeEnv === 'production',
        port: toInt(process.env.PORT, DEFAULTS.PORT),
        logLevel: process.env.LOG_LEVEL || DEFAULTS.LOG_LEVEL,

        queue: Object.freeze({
            checkIntervalMs: toInt(process.env.QUEUE_CHECK_INTERVAL_MS, DEFAULTS.QUEUE_CHECK_INTERVAL_MS),
            startupDelayMs: toInt(process.env.QUEUE_CHECK_STARTUP_DELAY_MS, DEFAULTS.QUEUE_CHECK_STARTUP_DELAY_MS),
            defaultLocation: process.env.SCRAPER_DEFAULT_LOCATION || DEFAULTS.SCRAPER_DEFAULT_LOCATION,
        }),

        linkedin: Object.freeze({
            chromePath: process.env.CHROME_PATH || DEFAULTS.CHROME_PATH,
            cdpPort: toInt(process.env.CDP_PORT, DEFAULTS.CDP_PORT),
        }),

        blacklight: blacklight
            ? Object.freeze({ apiUrl: blacklight.apiUrl, apiKey: blacklight.apiKey })
            : null,

        scraperCredentialsApi: scraperCredentials
            ? Object.freeze({ apiUrl: scraperCredentials.apiUrl, apiKey: scraperCredentials.apiKey })
            : null,

        // Raw credentials file — only the platform sections (linkedin/glassdoor/indeed/techfetch).
        // Consumed by the credential-api client when running in local mode.
        rawCredentials: credentials ? Object.freeze(credentials) : null,

        // Observability — telemetry is proxied through the Blacklight API
        // (api.qpeakhire.com) using the existing scraper API key. The
        // backend injects identity labels server-side and forwards to
        // Pushgateway + Loki over the private network. If `blacklight` is
        // not configured, telemetry is disabled but the scraper still
        // runs and exposes /metrics locally for debugging.
        //
        // Override env vars (all optional):
        //   TELEMETRY_URL    — base URL (defaults to blacklight.apiUrl)
        //   TELEMETRY_KEY    — API key (defaults to blacklight.apiKey)
        //   INSTANCE_ID      — per-host instance label (defaults to os.hostname())
        //   SCRAPER_MODE     — 'daemon' enables offline alerts
        telemetry: Object.freeze({
            baseUrl: process.env.TELEMETRY_URL || blacklight?.apiUrl || null,
            apiKey: process.env.TELEMETRY_KEY || blacklight?.apiKey || null,
            metricsPushIntervalMs: toInt(process.env.METRICS_PUSH_INTERVAL_MS, DEFAULTS.METRICS_PUSH_INTERVAL_MS),
            logsPushIntervalMs: toInt(process.env.LOKI_PUSH_INTERVAL_MS, DEFAULTS.LOKI_PUSH_INTERVAL_MS),
            logsBatchMax: toInt(process.env.LOKI_PUSH_BATCH_MAX, DEFAULTS.LOKI_PUSH_BATCH_MAX),
            instance: process.env.INSTANCE_ID || os.hostname(),
            mode: process.env.SCRAPER_MODE === 'daemon' ? 'daemon' : 'interactive',
        }),
    });
}

// Singleton — loaded once, never mutated.
let cached = null;

export function getConfig() {
    if (!cached) {
        cached = buildConfig();
    }
    return cached;
}

// Test-only helper; not used in production code paths.
export function resetConfigForTest() {
    cached = null;
}
