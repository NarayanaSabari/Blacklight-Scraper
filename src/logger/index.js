// Structured logger with secret masking and child loggers.
// Zero runtime dependencies — wraps console so we keep the existing "pretty"
// startup output while giving every module a consistent API.
//
// Usage:
//   import { createLogger } from '../logger/index.js';
//   const log = createLogger('monster');
//   log.info('Fetching page', { page: 3 });
//   log.error('API failure', { status: 500, err });

import { getConfig } from '../config/env.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 99 });

function activeLevel() {
    const name = (getConfig().logLevel || 'info').toLowerCase();
    return LEVELS[name] ?? LEVELS.info;
}

// Fields that must be masked anywhere they appear in log metadata.
const SENSITIVE_KEYS = new Set([
    'apikey', 'api_key', 'apiKey',
    'password', 'pwd', 'pass',
    'token', 'access_token', 'refresh_token',
    'authorization', 'auth',
    'cookie', 'cookies',
    'secret', 'clientsecret', 'client_secret',
    'x-scraper-api-key',
]);

function maskValue(value) {
    if (value == null) return value;
    const str = String(value);
    if (str.length <= 8) return '***';
    return `${str.slice(0, 4)}…${str.slice(-2)}`;
}

function maskSensitive(obj, depth = 0) {
    if (obj == null || depth > 5) return obj;
    if (obj instanceof Error) {
        return { name: obj.name, message: obj.message, code: obj.code, stack: obj.stack };
    }
    if (Array.isArray(obj)) return obj.map((v) => maskSensitive(v, depth + 1));
    if (typeof obj !== 'object') return obj;

    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
            out[key] = maskValue(value);
        } else {
            out[key] = maskSensitive(value, depth + 1);
        }
    }
    return out;
}

function format(level, scope, message, meta) {
    const prefix = scope ? `[${scope.toUpperCase()}]` : '';
    const time = new Date().toISOString();
    if (meta && Object.keys(meta).length > 0) {
        return `${time} ${level.toUpperCase()} ${prefix} ${message} ${JSON.stringify(maskSensitive(meta))}`;
    }
    return `${time} ${level.toUpperCase()} ${prefix} ${message}`;
}

// Optional side-sinks — wired up lazily at runtime so this module has zero
// import cycles with src/metrics/* or src/logger/loki-transport.js.
// Both sinks MUST be exception-safe; logging must never crash the caller.
let lokiSink = null;
let metricsSink = null;

export function attachLokiSink(transport) {
    lokiSink = transport;
}
export function attachMetricsSink(registry) {
    metricsSink = registry;
}

function write(level, scope, message, meta) {
    if (LEVELS[level] < activeLevel()) return;
    const line = format(level, scope, message, meta);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    // Fan out to side sinks. Each sink is guarded so a failure in one
    // doesn't take down the logger (and therefore the whole scraper).
    if (lokiSink) {
        try { lokiSink.enqueue(level, scope || 'root', line); }
        catch { /* swallow — sink is best-effort */ }
    }
    if (metricsSink) {
        try { metricsSink.recordLogLine(level, scope || 'root'); }
        catch { /* swallow */ }
    }
}

export function createLogger(scope = null) {
    return Object.freeze({
        debug: (message, meta) => write('debug', scope, message, meta),
        info: (message, meta) => write('info', scope, message, meta),
        warn: (message, meta) => write('warn', scope, message, meta),
        error: (message, meta) => write('error', scope, message, meta),
        child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
    });
}

// Convenience root logger for modules that don't need a scope.
export const logger = createLogger();
