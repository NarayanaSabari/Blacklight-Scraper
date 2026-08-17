// Two-step LinkedIn login state machine for the control panel.
//
//   idle → opening → awaiting_operator → capturing → validating → done
//                                       ↘ cancelled (cancel() or timeout) ↗
//                        (failed on any step's error, or a failed verdict)
//
// Replaces the old fire-and-forget `child_process.spawn` of
// scripts/linkedin-login.js. That approach was broken by construction: the
// spawned child's stdin was ignored, but linkedin-login.js blocks on an
// interactive "press Enter when logged in" prompt — with no stdin to answer
// it, the script would hit EOF and exit before the operator could log in.
//
// This module owns the browser handle directly instead, coordinating with
// the operator entirely through HTTP (start / complete / cancel) so the
// panel can drive it from the two-step API in src/panel/router.js.
//
// Guards enforced by start(): no scrape session in flight (reusing
// session-guard.js, the same check POST /panel/api/restart uses), and a free
// CloakBrowser seat available (best-effort — the real seat accounting still
// happens in src/core/browser-pool.js when the browser actually launches;
// this is a pre-flight to fail fast with a clear message instead of hanging
// the HTTP request behind pool.acquire()'s queue).

import { createLogger } from '../logger/index.js';
import * as defaultFlow from '../core/linkedin-login-flow.js';
import { activeSessions } from './session-guard.js';

const log = createLogger('panel:linkedin-login');

export const STATES = Object.freeze({
    IDLE: 'idle',
    OPENING: 'opening',
    AWAITING_OPERATOR: 'awaiting_operator',
    CAPTURING: 'capturing',
    VALIDATING: 'validating',
    DONE: 'done',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

// States where a browser is open / a login is actively in progress — start()
// refuses while in any of these. done/failed/cancelled are resting states,
// same as idle: the operator can start a fresh attempt immediately.
const BUSY_STATES = new Set([
    STATES.OPENING, STATES.AWAITING_OPERATOR, STATES.CAPTURING, STATES.VALIDATING,
]);

const DEFAULT_AWAITING_TIMEOUT_MS = 15 * 60 * 1000;

export class LinkedInLoginController {
    constructor({
        orchestrator = null, licensePool = null, flow = defaultFlow,
        timeoutMs = DEFAULT_AWAITING_TIMEOUT_MS, now = () => Date.now(),
    } = {}) {
        this._orchestrator = orchestrator;
        this._licensePool = licensePool;
        this._flow = flow;
        this._timeoutMs = timeoutMs;
        this._now = now;

        this._state = STATES.IDLE;
        this._handle = null;
        this._profileKey = null;
        this._profileDir = null;
        this._startedAt = null;
        this._lastVerdict = null;
        this._lastError = null;
        this._timeoutTimer = null;
    }

    // Read-only detail for the control panel (folded into buildStatus's
    // `linkedin.login`). Pure read, no side effects.
    status() {
        return {
            state: this._state,
            profileKey: this._profileKey,
            profileDir: this._profileDir,
            startedAt: this._startedAt,
            lastVerdict: this._lastVerdict,
            lastError: this._lastError,
        };
    }

    /**
     * Open the headed login browser and enter `awaiting_operator`.
     * @throws {Error} with `.code` one of LOGIN_IN_PROGRESS, SESSION_IN_FLIGHT,
     *   NO_FREE_SEAT — the router maps each to a 409.
     */
    async start({ profileKey = null, proxy = null } = {}) {
        if (BUSY_STATES.has(this._state)) {
            throw this.#error('LOGIN_IN_PROGRESS', `A LinkedIn login is already in progress (state: ${this._state}).`);
        }

        const sessions = activeSessions(this._orchestrator);
        if (sessions.length > 0) {
            throw this.#error(
                'SESSION_IN_FLIGHT',
                `${sessions.length} scrape session(s) in flight — wait for them to finish before logging in.`,
            );
        }

        const seats = this._licensePool?.snapshot?.() ?? { total: 0, free: 0 };
        if (seats.total > 0 && seats.free === 0) {
            throw this.#error('NO_FREE_SEAT', 'No free CloakBrowser seat — a scrape or another login is already using it.');
        }

        this._profileKey = profileKey || null;
        this._profileDir = this._flow.resolveLoginProfileDir({ profileKey: this._profileKey });
        this._lastVerdict = null;
        this._lastError = null;
        this._startedAt = new Date(this._now()).toISOString();
        this._state = STATES.OPENING;

        try {
            this._handle = await this._flow.openLoginBrowser({ profileKey: this._profileKey, proxy });
        } catch (error) {
            this._lastError = error.message;
            this._state = STATES.FAILED;
            this._handle = null;
            log.error('Failed to open LinkedIn login browser', { profileDir: this._profileDir, err: error.message });
            throw error;
        }

        this._state = STATES.AWAITING_OPERATOR;
        this.#armTimeout();
        return { state: this._state, profileDir: this._profileDir, profileKey: this._profileKey };
    }

    /**
     * Capture cookies, validate the session by navigating to the feed, and
     * close the browser (releasing the seat) regardless of outcome.
     * @throws {Error} with `.code` NOT_AWAITING (409) if called out of turn.
     */
    async complete() {
        if (this._state !== STATES.AWAITING_OPERATOR) {
            throw this.#error('NOT_AWAITING', `No login is awaiting completion (state: ${this._state}).`);
        }
        this.#clearTimeout();
        this._state = STATES.CAPTURING;

        const handle = this._handle;
        let captured = { cookies: [], persisted: 0, error: null };
        let verdict;
        try {
            // Validate FIRST, capture LAST. validateSession navigates to the
            // feed, and that navigation makes LinkedIn re-issue JSESSIONID as
            // a session-only cookie — so a capture done before validation had
            // its persisted JSESSIONID overwritten and then dropped on close.
            // Observed live onboarding li-acct-2 (2026-08-17): two capture
            // rounds both reported healthy cookie counts, both left the
            // profile without JSESSIONID. The persist must be the LAST write
            // before the context closes.
            this._state = STATES.VALIDATING;
            verdict = await this._flow.validateSession(handle);
            captured = await this._flow.captureSession(handle);
        } catch (error) {
            this._lastError = error.message;
            verdict = { ok: false, reason: 'error', error: error.message, finalUrl: null };
        } finally {
            await this.#closeAndRelease();
        }

        this._lastVerdict = verdict;
        this._state = verdict.ok ? STATES.DONE : STATES.FAILED;
        if (!verdict.ok) {
            log.warn('LinkedIn login validation failed — profile is still dead', {
                profileDir: this._profileDir, reason: verdict.reason, finalUrl: verdict.finalUrl,
            });
        } else {
            log.info('LinkedIn login validated', { profileDir: this._profileDir, finalUrl: verdict.finalUrl });
        }

        return {
            state: this._state,
            verdict,
            profileDir: this._profileDir,
            profileKey: this._profileKey,
            cookiesCaptured: captured.cookies.length,
            // Session-only auth cookies re-added with an explicit expiry —
            // lets the operator confirm JSESSIONID survival without a
            // separate profile read (each of those costs a browser launch).
            sessionCookiesPersisted: captured.persisted ?? 0,
            cookieCaptureError: captured.error,
        };
    }

    // Idempotent no-op when nothing is in flight. Closes the browser and
    // releases its seat when there is one. Used for the explicit Cancel
    // button AND the awaiting-operator timeout below.
    async cancel() {
        if (!BUSY_STATES.has(this._state)) {
            return { state: this._state };
        }
        this.#clearTimeout();
        await this.#closeAndRelease();
        this._state = STATES.CANCELLED;
        return { state: this._state };
    }

    #error(code, message) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    async #closeAndRelease() {
        const handle = this._handle;
        this._handle = null;
        if (!handle) return;
        try {
            await this._flow.closeLoginBrowser(handle);
        } catch (error) {
            // The seat-release wiring lives in browser-pool.js's close()
            // wrapper — if close() itself throws, log it loudly (a stuck
            // seat is exactly the failure mode this whole flow exists to
            // avoid) but never let it escape into the caller.
            log.warn('Failed to close LinkedIn login browser cleanly', { err: error.message });
        }
    }

    #armTimeout() {
        this.#clearTimeout();
        this._timeoutTimer = setTimeout(() => {
            log.warn('LinkedIn login timed out awaiting the operator — auto-cancelling', {
                profileDir: this._profileDir, timeoutMs: this._timeoutMs,
            });
            this.cancel().catch((error) => log.error('Auto-cancel failed', { err: error.message }));
        }, this._timeoutMs);
        this._timeoutTimer.unref?.();
    }

    #clearTimeout() {
        if (this._timeoutTimer) {
            clearTimeout(this._timeoutTimer);
            this._timeoutTimer = null;
        }
    }
}
