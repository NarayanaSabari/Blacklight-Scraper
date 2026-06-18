// Metrics push loop — forwards to the Blacklight scraper telemetry proxy
// at `<telemetry.baseUrl>/api/scraper/telemetry/metrics`.
//
// The backend validates the X-Scraper-API-Key, injects the authoritative
// grouping key (job / instance / scraper_key_id / scraper_name), and
// forwards to Pushgateway over its private network. Scrapers cannot
// forge labels because the backend overwrites them.
//
// Properties:
//   • If telemetry.baseUrl or telemetry.apiKey is unset, push is a no-op
//     — the scraper still runs and /metrics is still available locally.
//   • Push failures NEVER throw into the scraping loop; logged and retried.
//   • Final push on shutdown so counters from the last cycle land.

import { getMetrics } from './registry.js';
import { getConfig } from '../config/env.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('metrics:push');

const DEFAULT_INTERVAL_MS = 30_000;
const PUSH_TIMEOUT_MS = 10_000;

function buildUrl(baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/api/scraper/telemetry/metrics`;
}

export class MetricsPusher {
    constructor() {
        const cfg = getConfig().telemetry ?? {};
        this.baseUrl = cfg.baseUrl || null;
        this.apiKey = cfg.apiKey || null;
        this.intervalMs = cfg.metricsPushIntervalMs ?? DEFAULT_INTERVAL_MS;
        this.instance = cfg.instance || 'unknown';
        this.mode = cfg.mode || 'interactive';
        this.timer = null;
        this.consecutiveFailures = 0;
    }

    get enabled() {
        return Boolean(this.baseUrl && this.apiKey);
    }

    start() {
        if (!this.enabled) {
            log.info('Metrics push disabled (telemetry.baseUrl or apiKey unset); /metrics stays local');
            return;
        }
        log.info('Starting metrics push loop', {
            url: buildUrl(this.baseUrl),
            intervalMs: this.intervalMs,
            instance: this.instance,
            mode: this.mode,
        });

        // Schedule a short-deadline first push — long enough that the
        // heartbeat ticker and any bootstrap counter increments have
        // landed in the registry, but short enough that the dashboard
        // sees a heartbeat well before the first real interval tick
        // (30s). Earlier implementations fire-and-forgot a push inside
        // start() itself, which serialized an empty registry and left
        // Pushgateway holding a blank grouping key for up to 30s.
        const INITIAL_DELAY_MS = Math.min(3_000, Math.max(1_000, Math.floor(this.intervalMs / 10)));
        const initialTimer = setTimeout(() => {
            this.pushOnce().catch((error) => {
                log.warn('initial push error', { err: error.message });
            });
        }, INITIAL_DELAY_MS);
        initialTimer.unref?.();

        this.timer = setInterval(() => {
            this.pushOnce().catch((error) => {
                log.warn('unexpected push error', { err: error.message });
            });
        }, this.intervalMs);
        this.timer.unref?.();
    }

    async stop({ finalPush = true } = {}) {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (finalPush && this.enabled) {
            log.info('Sending final metrics push before shutdown');
            await this.pushOnce().catch((error) => {
                log.warn('final push failed', { err: error.message });
            });
        }
    }

    async pushOnce() {
        if (!this.enabled) return;

        const body = await getMetrics().snapshot();
        const target = buildUrl(this.baseUrl);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

        try {
            const response = await fetch(target, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain; version=0.0.4',
                    'X-Scraper-API-Key': this.apiKey,
                    'X-Scraper-Instance': this.instance,
                    'X-Scraper-Mode': this.mode,
                },
                body,
                signal: controller.signal,
            });

            if (!response.ok) {
                this.consecutiveFailures += 1;
                if (this.consecutiveFailures === 1 || this.consecutiveFailures % 5 === 0) {
                    log.warn('telemetry proxy non-2xx', {
                        status: response.status,
                        consecutiveFailures: this.consecutiveFailures,
                    });
                }
                return;
            }
            if (this.consecutiveFailures > 0) {
                log.info('telemetry proxy recovered', { afterFailures: this.consecutiveFailures });
            }
            this.consecutiveFailures = 0;
        } catch (error) {
            this.consecutiveFailures += 1;
            const msg = error?.name === 'AbortError' ? 'timeout' : error?.message ?? 'unknown';
            if (this.consecutiveFailures === 1 || this.consecutiveFailures % 5 === 0) {
                log.warn('metrics push failed', {
                    err: msg,
                    consecutiveFailures: this.consecutiveFailures,
                });
            }
        } finally {
            clearTimeout(timer);
        }
    }
}

// Module-level singleton.
let pusherInstance = null;
export function getPusher() {
    if (!pusherInstance) pusherInstance = new MetricsPusher();
    return pusherInstance;
}
