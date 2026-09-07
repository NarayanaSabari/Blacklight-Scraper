// Account-scoped search diagnostics. Empty role queries request a probe;
// only corroborated control results or an explicit 429 justify a cooldown.
export const DEFAULT_EMPTY_THRESHOLD = 25;
export const DEFAULT_BASE_PAUSE_MS = 5 * 60_000;
export const DEFAULT_MAX_PAUSE_MS = 60 * 60_000;
export const DEFAULT_EMPTY_MAX_PAUSE_MS = 15 * 60_000;
const CONTROL_QUERIES = ['hiring', 'jobs', 'recruiting'];

export function emptyThreshold(env = process.env) {
    const n = Number.parseInt(env.LINKEDIN_QUOTA_EMPTY_THRESHOLD, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMPTY_THRESHOLD;
}
export function basePauseMs(env = process.env) {
    const n = Number.parseInt(env.LINKEDIN_QUOTA_PAUSE_MIN, 10);
    return Number.isFinite(n) && n > 0 ? n * 60_000 : DEFAULT_BASE_PAUSE_MS;
}
export function maxPauseMs(env = process.env) {
    const n = Number.parseInt(env.LINKEDIN_QUOTA_MAX_PAUSE_MIN, 10);
    return Number.isFinite(n) && n > 0 ? n * 60_000 : DEFAULT_MAX_PAUSE_MS;
}

export class SearchQuotaTracker {
    constructor({ threshold = emptyThreshold(), basePause = basePauseMs(),
        maxPause = maxPauseMs(), now = Date.now, startupProbe = false,
        retryMs = 60_000 } = {}) {
        this._threshold = threshold;
        this._basePause = basePause;
        this._maxPause = maxPause;
        this._now = now;
        this._retryMs = retryMs;
        this._consecutiveEmpty = 0;
        this._consecutiveTrips = 0;
        this._strikes = 0;
        this._inconclusive = 0;
        this._needsProbe = startupProbe;
        this._inFlight = false;
        this._retryAt = null;
        this._pausedUntil = null;
        this._lastTripAt = null;
        this._lastServedAt = null;
        this._lastOutcome = null;
        this._probeIndex = 0;
    }

    // Hold the account's slot until the entire assignment finishes. An older
    // query cannot race a probe and overwrite its evidence or release its slot.
    beginSearch() {
        const now = this._now();
        if (this._inFlight || (this._retryAt !== null && now < this._retryAt)) {
            return { allowed: false, retryAt: Math.max(this._retryAt ?? 0, now + this._retryMs) };
        }
        this._inFlight = true;
        return { allowed: true, recovery: this._needsProbe };
    }
    endSearch() { this._inFlight = false; }
    nextProbeQuery() { return CONTROL_QUERIES[this._probeIndex++ % CONTROL_QUERIES.length]; }

    recordEmpty() {
        this._consecutiveEmpty++;
        if (this._consecutiveEmpty >= this._threshold) this._needsProbe = true;
        return { probeDue: this._needsProbe, streak: this._consecutiveEmpty, tripped: false, pauseMs: 0 };
    }

    recordServed() {
        this._consecutiveEmpty = 0;
        this._consecutiveTrips = 0;
        this._strikes = 0;
        this._inconclusive = 0;
        this._needsProbe = false;
        this._retryAt = null;
        this._pausedUntil = null;
        this._lastServedAt = this._now();
        this._lastOutcome = 'healthy';
    }

    finishRecovery(outcome) {
        this._lastOutcome = outcome;
        if (outcome === 'healthy') {
            this.recordServed();
            return { tripped: false, pauseMs: 0, outcome };
        }
        this._needsProbe = true;
        this._pausedUntil = null;
        let pauseMs = this._retryMs;
        let tripped = false;
        if (outcome === 'empty' || outcome === 'rate_limited') {
            this._inconclusive = 0;
            this._strikes++;
            // Different broad queries, on separate assignments at least one
            // retry interval apart, corroborate an otherwise ambiguous empty.
            if (this._strikes >= 2 || outcome === 'rate_limited') {
                this._consecutiveTrips++;
                pauseMs = this._pauseMs(outcome, this._consecutiveTrips - 1);
                this._lastTripAt = this._now();
                this._pausedUntil = this._now() + pauseMs;
                tripped = true;
            }
        } else {
            // Unknown auth/template/network state invalidates empty evidence.
            // It gets a diagnostic retry, never a quota strike or escalation.
            this._strikes = 0;
            this._inconclusive++;
            pauseMs = Math.min(this._retryMs * 2 ** (this._inconclusive - 1), 5 * 60_000);
        }
        this._retryAt = this._now() + pauseMs;
        return { tripped, pauseMs, outcome, retryAt: this._retryAt };
    }

    _pauseMs(outcome, exponent) {
        // Empty controls still cannot distinguish account restrictions from
        // upstream search failures. Keep checking without weakening 429 backoff.
        const cap = outcome === 'empty' ? Math.min(this._maxPause, DEFAULT_EMPTY_MAX_PAUSE_MS) : this._maxPause;
        return Math.min(this._basePause * 2 ** exponent, cap);
    }

    snapshot() {
        return {
            consecutiveEmpty: this._consecutiveEmpty, consecutiveTrips: this._consecutiveTrips,
            threshold: this._threshold, recoveryInFlight: this._inFlight && this._needsProbe,
            paused: this._pausedUntil !== null && this._now() < this._pausedUntil,
            pausedUntil: this._pausedUntil === null ? null : new Date(this._pausedUntil).toISOString(),
            nextRetryAt: this._retryAt === null ? null : new Date(this._retryAt).toISOString(),
            lastTripAt: this._lastTripAt === null ? null : new Date(this._lastTripAt).toISOString(),
            lastServedAt: this._lastServedAt === null ? null : new Date(this._lastServedAt).toISOString(),
            lastOutcome: this._lastOutcome, diagnosticDue: this._needsProbe,
            corroboratingEmpties: this._strikes,
            nextPauseMs: this._pauseMs(this._lastOutcome, this._consecutiveTrips),
        };
    }
}

export function accountKey(lease) {
    const credential = lease?.credential;
    return credential?.id != null ? `id:${credential.id}` : `profile:${credential?.profile_key || 'local'}`;
}

export class SearchQuotaRegistry {
    constructor(options = {}) { this._accounts = new Map(); this._options = options; }
    forAccount(lease) {
        const key = accountKey(lease);
        if (!this._accounts.has(key)) this._accounts.set(key, new SearchQuotaTracker({ startupProbe: true, ...this._options }));
        return this._accounts.get(key);
    }
    snapshot() {
        return { scope: 'account', accounts: Object.fromEntries(
            [...this._accounts].map(([key, tracker]) => [key, tracker.snapshot()])) };
    }
}
