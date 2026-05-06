// Heartbeat — ticks scraper_up + scraper_last_heartbeat_timestamp_seconds
// every N seconds so Grafana can detect a dead scraper before Pushgateway
// would otherwise serve stale values forever.
//
// This runs independently of the push loop so the heartbeat gauge moves
// forward in memory regardless of network health. The next successful
// push carries whatever tick was recorded most recently.

import { getMetrics } from './registry.js';
import { createLogger } from '../logger/index.js';

const DEFAULT_INTERVAL_MS = 10_000;

const log = createLogger('metrics:heartbeat');

export class Heartbeat {
    constructor(intervalMs = DEFAULT_INTERVAL_MS) {
        this.intervalMs = intervalMs;
        this.timer = null;
    }

    start() {
        if (this.timer) return;
        const metrics = getMetrics();
        metrics.markHeartbeat();
        this.timer = setInterval(() => {
            metrics.markHeartbeat();
        }, this.intervalMs);
        this.timer.unref?.();
        log.info('heartbeat started', { intervalMs: this.intervalMs });
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            log.info('heartbeat stopped');
        }
    }
}
