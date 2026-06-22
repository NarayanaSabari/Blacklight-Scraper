// Shared HTTP client for internal API calls (Blacklight queue, credentials API).
// External scraper targets (dice.com, indeed.com, linkedin.com, etc.) use fetch/
// Playwright directly — those requests must NOT be routed through this client
// because they have their own rate-limit and retry semantics.
//
// Features:
//   • Exponential backoff with full jitter
//   • Circuit breaker per host (opens after N consecutive failures)
//   • Request timeout via AbortController

import { createLogger } from '../logger/index.js';
import { NetworkError, TimeoutError } from '../core/errors.js';
import { sleepBackoff } from '../core/delays.js';

const log = createLogger('http');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 4;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

// Per-host circuit breaker state.
const circuits = new Map();

function hostOf(url) {
    try { return new URL(url).host; } catch { return 'unknown'; }
}

function getCircuit(host) {
    let state = circuits.get(host);
    if (!state) {
        state = { failures: 0, openUntil: 0 };
        circuits.set(host, state);
    }
    return state;
}

function assertCircuitClosed(host) {
    const state = getCircuit(host);
    if (state.openUntil > Date.now()) {
        const remainingMs = state.openUntil - Date.now();
        throw new NetworkError(
            `Circuit breaker open for ${host}; retry in ${Math.ceil(remainingMs / 1000)}s`,
            { statusCode: 503 },
        );
    }
}

function recordSuccess(host) {
    const state = getCircuit(host);
    state.failures = 0;
    state.openUntil = 0;
}

function recordFailure(host) {
    const state = getCircuit(host);
    state.failures += 1;
    if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
        state.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
        log.warn('Circuit breaker opened', { host, cooldownMs: CIRCUIT_COOLDOWN_MS });
    }
}

async function fetchOnce(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new TimeoutError(`Request timed out after ${timeoutMs}ms`, { cause: error });
        }
        throw new NetworkError(error.message || 'Network request failed', { cause: error });
    } finally {
        clearTimeout(timer);
    }
}

function shouldRetryStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}

/**
 * Fetch with retry, backoff+jitter, timeout, and circuit breaking.
 * Returns the raw Response on success (2xx/4xx non-retryable).
 * Throws NetworkError / TimeoutError for transport failures and exhausted retries.
 *
 * @param {string} url
 * @param {object} [options]           - fetch options
 * @param {object} [config]
 * @param {number} [config.retries]    - total attempts including first try
 * @param {number} [config.timeoutMs]
 */
export async function requestWithRetry(url, options = {}, config = {}) {
    const retries = config.retries ?? DEFAULT_RETRIES;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const host = hostOf(url);

    assertCircuitClosed(host);

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        if (attempt > 0) {
            await sleepBackoff(attempt - 1, { baseMs: 1000, maxMs: 30_000 });
        }

        try {
            const response = await fetchOnce(url, options, timeoutMs);

            if (shouldRetryStatus(response.status) && attempt < retries - 1) {
                log.warn('Retryable status, backing off', {
                    url, status: response.status, attempt: attempt + 1, retries,
                });
                continue;
            }

            if (response.ok || !shouldRetryStatus(response.status)) {
                recordSuccess(host);
                return response;
            }

            // Final attempt with retryable status: report + return the response
            // so the caller can decide. Still counts as a failure for the circuit.
            recordFailure(host);
            return response;
        } catch (error) {
            lastError = error;
            if (attempt >= retries - 1) break;
            log.warn('Request failed, will retry', {
                url, attempt: attempt + 1, retries, err: error.message,
            });
        }
    }

    recordFailure(host);
    throw lastError ?? new NetworkError(`Request failed after ${retries} attempts: ${url}`);
}

/**
 * Convenience wrapper that additionally parses JSON and throws on non-ok.
 */
export async function requestJson(url, options = {}, config = {}) {
    const response = await requestWithRetry(url, options, config);
    if (response.status === 204) return null;
    if (!response.ok) {
        throw new NetworkError(
            `HTTP ${response.status} ${response.statusText} for ${url}`,
            { statusCode: response.status },
        );
    }
    return response.json();
}
