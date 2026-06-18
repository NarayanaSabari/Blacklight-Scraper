// Typed error hierarchy for scrapers and API clients.
// Callers use `instanceof` to make retry / fail-fast decisions.

export class ScraperError extends Error {
    constructor(message, { code = 'SCRAPER_ERROR', platform = null, cause = null } = {}) {
        super(message);
        this.name = 'ScraperError';
        this.code = code;
        this.platform = platform;
        if (cause) this.cause = cause;
    }
}

export class AuthError extends ScraperError {
    constructor(message, opts = {}) {
        super(message, { code: 'AUTH_ERROR', ...opts });
        this.name = 'AuthError';
    }
}

export class NetworkError extends ScraperError {
    constructor(message, { statusCode = null, ...rest } = {}) {
        super(message, { code: 'NETWORK_ERROR', ...rest });
        this.name = 'NetworkError';
        this.statusCode = statusCode;
    }
}

export class TimeoutError extends ScraperError {
    constructor(message, opts = {}) {
        super(message, { code: 'TIMEOUT', ...opts });
        this.name = 'TimeoutError';
    }
}

export class ParseError extends ScraperError {
    constructor(message, opts = {}) {
        super(message, { code: 'PARSE_ERROR', ...opts });
        this.name = 'ParseError';
    }
}

export class BrowserError extends ScraperError {
    constructor(message, opts = {}) {
        super(message, { code: 'BROWSER_ERROR', ...opts });
        this.name = 'BrowserError';
    }
}

export class ValidationError extends ScraperError {
    constructor(message, opts = {}) {
        super(message, { code: 'VALIDATION_ERROR', ...opts });
        this.name = 'ValidationError';
    }
}

export class BlockedError extends ScraperError {
    // Anti-bot block / challenge / interstitial (Cloudflare, DataDome,
    // auth-wall, 403/429). `kind` records which signal tripped, for
    // metrics + triage. Distinct from AuthError: the remediation is
    // IP/fingerprint/backoff, NOT credential rotation.
    constructor(message, { kind = null, ...rest } = {}) {
        super(message, { code: 'BLOCKED', ...rest });
        this.name = 'BlockedError';
        this.kind = kind;
    }
}

export class DomChangedError extends ScraperError {
    // Page loaded fine and was NOT blocked, but the expected result
    // containers/fields were absent — the site changed its DOM. Loud
    // by design: must never be reported as a successful empty scrape.
    constructor(message, opts = {}) {
        super(message, { code: 'DOM_CHANGED', ...opts });
        this.name = 'DomChangedError';
    }
}
