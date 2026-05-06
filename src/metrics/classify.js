// Error → failure reason classifier.
//
// Scrapers keep throwing vanilla Error objects; this helper inspects name,
// code, and message text to pick the best reason label. Keeping the logic
// centralized means we can tweak patterns without touching scraper code.
//
// Reasons must match the label set declared in src/metrics/registry.js
// (see scraper_failures_total) or Grafana alert rules will miss them.

import { AuthError, NetworkError, TimeoutError, ParseError, BrowserError } from '../core/errors.js';

const REASONS = Object.freeze({
    AUTH_REQUIRED: 'auth_required',
    CAPTCHA: 'captcha',
    NETWORK: 'network',
    TIMEOUT: 'timeout',
    PARSE_ERROR: 'parse_error',
    RATE_LIMITED: 'rate_limited',
    BROWSER_CRASH: 'browser_crash',
    CREDENTIAL_MISSING: 'credential_missing',
    UNKNOWN: 'unknown',
});

const PATTERNS = [
    { reason: REASONS.AUTH_REQUIRED, regex: /login|authwall|unauthori[sz]ed|not logged in|invalid (email|password|credential)|session expired|re-?login/i },
    { reason: REASONS.CAPTCHA, regex: /captcha|challenge|datadome|cloudflare|bot detection/i },
    { reason: REASONS.RATE_LIMITED, regex: /rate ?limit|429|too many requests|throttl/i },
    { reason: REASONS.TIMEOUT, regex: /timeout|timed out|etimedout|aborted/i },
    { reason: REASONS.BROWSER_CRASH, regex: /target closed|crash|disconnected|browser has been closed|chromium|playwright|cdp/i },
    { reason: REASONS.NETWORK, regex: /enetunreach|econnrefused|econnreset|enotfound|network|socket hang up|fetch failed/i },
    { reason: REASONS.PARSE_ERROR, regex: /unexpected token|json|parse|invalid structured data|selector (?:not )?found/i },
    { reason: REASONS.CREDENTIAL_MISSING, regex: /no credential|no linkedin credentials|credentials? (?:not )?available/i },
];

export function classifyError(error) {
    if (!error) return REASONS.UNKNOWN;

    if (error instanceof AuthError) return REASONS.AUTH_REQUIRED;
    if (error instanceof TimeoutError) return REASONS.TIMEOUT;
    if (error instanceof ParseError) return REASONS.PARSE_ERROR;
    if (error instanceof BrowserError) return REASONS.BROWSER_CRASH;
    if (error instanceof NetworkError) {
        const status = error.statusCode;
        if (status === 429) return REASONS.RATE_LIMITED;
        if (status === 401 || status === 403) return REASONS.AUTH_REQUIRED;
        return REASONS.NETWORK;
    }

    const haystack = [error.name, error.code, error.message].filter(Boolean).join(' ');
    for (const { reason, regex } of PATTERNS) {
        if (regex.test(haystack)) return reason;
    }
    return REASONS.UNKNOWN;
}

export { REASONS };
