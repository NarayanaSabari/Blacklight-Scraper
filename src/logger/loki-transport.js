// Loki log transport — pushes through the Blacklight telemetry proxy
// at `<telemetry.baseUrl>/api/scraper/telemetry/logs`.
//
// The backend validates the X-Scraper-API-Key, REWRITES identity stream
// labels (app, scraper_name, scraper_key_id, instance) so clients cannot
// spoof them, and forwards the payload to Loki over the private network.
// Client-provided labels like `level` and `scope` are preserved.
//
// Design:
//   • Buffers log lines and flushes every N seconds (or N entries).
//   • Bounded ring buffer — oldest lines drop if the buffer fills.
//   • Graceful degradation: unreachable proxy → warn + retry next tick.
//   • Never blocks the scraping loop; all I/O runs on a timer.
//   • Final flush on shutdown so the last cycle of logs lands.

import os from 'os';
import { createLogger } from './index.js';
import { getMetrics } from '../metrics/registry.js';

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_MAX = 200;
const PUSH_TIMEOUT_MS = 10_000;
const BUFFER_HARD_LIMIT = 5_000;

function detectOs() {
    const platform = process.platform;
    if (platform === 'darwin') return 'mac';
    if (platform === 'win32') return 'windows';
    return 'linux';
}

function buildUrl(baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/api/scraper/telemetry/logs`;
}

export class LokiTransport {
    constructor({ baseUrl, apiKey, intervalMs, batchMax, instance, mode } = {}) {
        this.baseUrl = baseUrl || null;
        this.apiKey = apiKey || null;
        this.intervalMs = intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
        this.batchMax = batchMax ?? DEFAULT_BATCH_MAX;
        this.instance = instance || os.hostname();
        this.mode = mode || 'interactive';
        this.clientLabels = Object.freeze({
            host: os.hostname(),
            os: detectOs(),
            mode: this.mode,
        });
        this.buffer = [];
        this.droppedCount = 0;
        this.timer = null;
        // Bootstrap logger must NOT push back to Loki or we'd create a
        // feedback loop where push failures log more push failures.
        this.log = createLogger('logger:loki');
        this.started = false;
    }

    get enabled() {
        return Boolean(this.baseUrl && this.apiKey);
    }

    start() {
        if (this.started || !this.enabled) {
            if (!this.enabled) {
                this.log.info('Loki push disabled (telemetry.baseUrl or apiKey unset); stdout only');
            }
            return;
        }
        this.started = true;
        this.log.info('Loki transport started', {
            url: buildUrl(this.baseUrl),
            intervalMs: this.intervalMs,
            batchMax: this.batchMax,
        });
        this.timer = setInterval(() => {
            this.flush().catch((error) => {
                this.log.warn('loki flush failed', { err: error.message });
            });
        }, this.intervalMs);
        this.timer.unref?.();
    }

    async stop({ finalFlush = true } = {}) {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (finalFlush && this.enabled) {
            await this.flush().catch(() => {});
        }
        this.started = false;
    }

    /**
     * Enqueue a log line. Called for every logger invocation.
     * @param {string} level
     * @param {string} scope
     * @param {string} line
     */
    enqueue(level, scope, line) {
        if (!this.enabled) return;
        // Never push our own bootstrap logs — avoids a recursive loop
        // where a failed push emits a warning that tries to be pushed.
        if (scope === 'logger:loki') return;

        if (this.buffer.length >= BUFFER_HARD_LIMIT) {
            this.buffer.shift();
            this.droppedCount += 1;
        }
        // Loki wants nanosecond timestamps as strings.
        const ts = `${Date.now()}000000`;
        this.buffer.push({ ts, level, scope, line });
    }

    // Put a failed batch back at the head of the buffer, but drop lines
    // (counted) if doing so would blow the hard limit. The previous
    // implementation silently dropped the whole chunk in the overflow
    // case, so sustained outages leaked without any visible signal.
    #requeueOrDrop(chunk) {
        const available = BUFFER_HARD_LIMIT - this.buffer.length;
        if (available <= 0) {
            // No room at all — drop the whole chunk and count it.
            this.droppedCount += chunk.length;
            return;
        }
        if (chunk.length <= available) {
            this.buffer.unshift(...chunk);
            return;
        }
        // Partial fit: keep the newest `available` entries (tail of the
        // chunk) so we preserve the most recent data. Drop the older
        // overflow and increment the dropped counter so the warning at
        // the end of flush() fires.
        const keep = chunk.slice(chunk.length - available);
        const dropped = chunk.length - available;
        this.buffer.unshift(...keep);
        this.droppedCount += dropped;
    }

    async flush() {
        if (!this.enabled || this.buffer.length === 0) return;

        const chunk = this.buffer.splice(0, this.batchMax);

        // Group by (level, scope) for stable stream label sets.
        // Identity labels (app, scraper_name, scraper_key_id, instance)
        // are injected by the backend — we do NOT include them here.
        const streamsByKey = new Map();
        for (const entry of chunk) {
            const key = `${entry.level}|${entry.scope}`;
            if (!streamsByKey.has(key)) {
                streamsByKey.set(key, {
                    stream: { ...this.clientLabels, level: entry.level, scope: entry.scope },
                    values: [],
                });
            }
            streamsByKey.get(key).values.push([entry.ts, entry.line]);
        }

        const body = { streams: Array.from(streamsByKey.values()) };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

        try {
            const response = await fetch(buildUrl(this.baseUrl), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Scraper-API-Key': this.apiKey,
                    'X-Scraper-Instance': this.instance,
                    'X-Scraper-Mode': this.mode,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok) {
                this.#requeueOrDrop(chunk);
                this.log.warn('loki push non-2xx', { status: response.status });
            }
        } catch (error) {
            this.#requeueOrDrop(chunk);
            const msg = error?.name === 'AbortError' ? 'timeout' : error?.message ?? 'unknown';
            this.log.warn('loki push failed', { err: msg });
        } finally {
            clearTimeout(timer);
        }

        if (this.droppedCount > 0) {
            this.log.warn('log buffer overflow — lines dropped', { dropped: this.droppedCount });
            // audit L3: surface dropped lines as a metric so a Loki outage /
            // backpressure is visible on the dashboard, not just in a local warn.
            try { getMetrics().recordLogLinesDropped(this.droppedCount); } catch { /* metrics best-effort */ }
            this.droppedCount = 0;
        }
    }
}

// Module-level singleton.
let transportInstance = null;

export function getLokiTransport() {
    return transportInstance;
}

export function initializeLokiTransport(config) {
    transportInstance = new LokiTransport(config);
    return transportInstance;
}
