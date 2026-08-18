// Session supply for the RSC transport: a credential lease, the account's
// cookie jar, and a request template.
//
// The browser is needed ONLY to read cookies out of the on-disk profile — no
// navigation, no page, no LinkedIn traffic. Cookies are cached for a TTL so a
// queue full of roles does not launch a browser per role (CloakBrowser seats are
// capped per licence key, and a free-plan key starts killing sessions after a
// handful of launches).
//
// The request template (URL + client-version headers + body shape) is captured
// once by `npm run linkedin:rsc-template` and read from disk. It is deliberately
// NOT minted on demand: minting needs a real navigation, which is exactly the
// traffic this transport exists to avoid.

import fs from 'fs';
import path from 'path';
import { createLogger } from '../../logger/index.js';
import { getCredentialsAPIClient } from '../../api/credentials.js';
import { AuthError, NetworkError } from '../../core/errors.js';
import { linkedInProfileDir, profileDirFor, hasLiAt } from '../../core/linkedin-profile.js';
import * as linkedinCooldown from '../../core/linkedin-cooldown.js';
import * as defaultTemplateHealth from './template-health.js';
import { captureTemplate as captureTemplateImpl } from './capture-template.js';
import { getMetrics } from '../../metrics/registry.js';

const log = createLogger('linkedin-rsc-session');

const DEFAULT_COOKIE_TTL_MS = 30 * 60 * 1000; // 30 min

// The backend reaps in_use credentials that have not been touched for 10 min
// (`cleanup_stale_assignments(timeout_minutes=10)`), so the lease must be
// pinged well inside that window. 2 min leaves room for several consecutive
// failed ticks before the reaper wins.
const DEFAULT_HEARTBEAT_MS = 2 * 60 * 1000;
const REAPER_TIMEOUT_MS = 10 * 60 * 1000;

function cacheKey(profileKey) {
    return profileKey || null;
}

export function cookieTtlMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_RSC_COOKIE_TTL_MIN ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOKIE_TTL_MS;
    return n * 60 * 1000;
}

/**
 * Lease-heartbeat interval. Clamped below the backend reaper's window: an
 * operator who sets this to 15 min would silently reintroduce SCR-4, so a
 * too-large value is capped rather than honoured.
 */
export function heartbeatIntervalMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_LEASE_HEARTBEAT_MIN ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_HEARTBEAT_MS;
    return Math.min(n * 60 * 1000, REAPER_TIMEOUT_MS / 2);
}

export function templatePath(env = process.env) {
    return env?.LINKEDIN_RSC_TEMPLATE
        || path.join(process.cwd(), 'config', 'linkedin-rsc-template.json');
}

// How often the captured template's freshness is re-checked.
//
// The check itself is one ordinary page fetch, so this is not about cost — it is
// about not making a browser-driving re-capture decision more often than the
// situation can actually change. LinkedIn's build moves continuously but the
// template only BREAKS after hundreds of builds, which takes days. Four hours
// is far tighter than the failure timescale while still amounting to a handful
// of fetches a day.
export const DEFAULT_TEMPLATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function templateCheckIntervalFrom(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_TEMPLATE_CHECK_INTERVAL_MIN ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n * 60 * 1000 : DEFAULT_TEMPLATE_CHECK_INTERVAL_MS;
}

/**
 * Re-capture the template and persist it to this host's configured path.
 *
 * Thin wrapper so the session's injected default writes to the right place
 * without the session needing to know about capture internals.
 */
export function captureTemplate(opts = {}) {
    return captureTemplateImpl({ outPath: templatePath(), ...opts });
}

/**
 * Load the captured pagination template.
 * @throws {AuthError} with recovery instructions when it is missing
 */
export function loadTemplate(file = templatePath()) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        throw new AuthError(
            `LinkedIn RSC template not found at ${file} — run \`npm run linkedin:rsc-template\` on this host`,
            { platform: 'linkedin', code: 'NEEDS_TEMPLATE' },
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new AuthError(`LinkedIn RSC template at ${file} is not valid JSON`, {
            platform: 'linkedin', code: 'NEEDS_TEMPLATE', cause,
        });
    }
    if (!parsed?.url || !parsed?.postData || !parsed?.headers) {
        throw new AuthError(
            `LinkedIn RSC template at ${file} is incomplete (need url, headers, postData) — re-capture it`,
            { platform: 'linkedin', code: 'NEEDS_TEMPLATE' },
        );
    }
    return parsed;
}

/**
 * Read the cookie jar out of a persistent profile WITHOUT navigating anywhere.
 * The context is opened and closed immediately; nothing touches the network.
 */
export async function readProfileCookies({ profileKey = null, launcher = null } = {}) {
    const userDataDir = profileKey ? profileDirFor(profileKey) : linkedInProfileDir();
    // Imported lazily so this module (and everything that unit-tests it) does not
    // require the browser packages just to be loaded.
    const launch = launcher
        ?? (await import('../../core/browser-pool.js')).launchPersistentContext;
    const context = await launch({
        userDataDir,
        headless: true,
        humanize: false,
    });
    try {
        return await context.cookies();
    } finally {
        await context.close().catch(() => {});
    }
}

export class LinkedInRscSession {
    constructor({
        apiClient = null,
        platform = 'linkedin',
        cookieReader = readProfileCookies,
        templateLoader = loadTemplate,
        ttlMs = cookieTtlMs(),
        now = () => Date.now(),
        cooldown = linkedinCooldown,
        heartbeatMs = heartbeatIntervalMs(),
        scheduler = { setInterval, clearInterval },
        // Template freshness. Injected as a unit so a test can pass null to
        // disable the check entirely (no network, no browser) or a stub to
        // drive a specific verdict. Defaults to the real implementation, so
        // production gets the protection without opting in.
        templateHealth = defaultTemplateHealth,
        templateCheckIntervalMs = templateCheckIntervalFrom(),
        recaptureTemplate = captureTemplate,
        // Telemetry sink. Defaults to the process registry; tests pass null to
        // stay free of it. Never load-bearing — see #metric().
        metrics = getMetrics(),
    } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._platform = platform;
        this._readCookies = cookieReader;
        this._loadTemplate = templateLoader;
        this._ttlMs = ttlMs;
        this._now = now;
        this._cooldown = cooldown;
        this._heartbeatMs = heartbeatMs;
        this._scheduler = scheduler;
        this._cookies = new Map();
        this._cookiesAt = new Map();
        this._template = null;
        this._refreshing = new Map();
        this._templateHealth = templateHealth;
        this._templateCheckIntervalMs = templateCheckIntervalMs;
        this._recaptureTemplate = recaptureTemplate;
        this._metrics = metrics;
        // null, not 0: "never checked" must be distinguishable from "checked at
        // epoch", or an injected clock starting at 0 would skip the first check.
        this._templateCheckedAt = null;
        this._templateStatus = null;
    }

    /** Last observed template-freshness verdict, for the control panel. */
    templateStatus() {
        return this._templateStatus;
    }

    /**
     * Cached template; loaded once per process, then kept fresh.
     *
     * FRESHNESS IS NOT OPTIONAL. The template carries LinkedIn's client build
     * number, and once that falls far enough behind, the pagination endpoint
     * stops honouring the request and answers HTTP 200 with a well-formed
     * "No results found" — the same shape a genuinely empty search has. The
     * transport then reports confirmed empties, the canary reads a run of those
     * as a shadow-ban, and healthy credentials get cooled for hours while the
     * actual cause sits on disk. That is the 2026-08-18 outage: five hours at
     * zero, both LinkedIn accounts falsely banned, cause recorded wrong.
     *
     * So the check happens here, at the single place every scrape obtains its
     * template, rather than in a periodic job that could be skipped or fail
     * quietly. It is rate-limited (see CHECK_INTERVAL_MS) so it costs one
     * ordinary page fetch every few hours, not one per scrape.
     */
    async template() {
        if (!this._template) this._template = this._loadTemplate();
        await this.#ensureTemplateFresh();
        return this._template;
    }

    /**
     * Re-capture the template when LinkedIn's client version has moved too far
     * ahead of the captured one.
     *
     * Every failure path here is deliberately non-fatal. A template that MIGHT
     * be stale still works far more often than not, so an unreachable version
     * page, a failed re-capture, or a missing capture module must all leave the
     * existing template in place and let the scrape proceed. Refusing to scrape
     * on a maybe would turn a degraded state into an outage, which is the
     * failure mode this whole module exists to prevent.
     */
    async #ensureTemplateFresh() {
        if (!this._templateHealth) return;             // check disabled by injection
        const now = this._now();
        if (this._templateCheckedAt !== null
            && now - this._templateCheckedAt < this._templateCheckIntervalMs) return;
        // Stamp BEFORE the await. Two concurrent roles reaching a due check must
        // not both spend a fetch, and an in-flight check must not be re-entered.
        this._templateCheckedAt = now;

        const {
            assessTemplate, fetchLiveClientVersion,
        } = this._templateHealth;

        let verdict;
        try {
            const liveVersion = await fetchLiveClientVersion({
                userAgent: this._template?.headers?.['user-agent'],
            });
            verdict = assessTemplate({ template: this._template, liveVersion, now });
            // Remembered so the control panel can show it without issuing a
            // LinkedIn request on every 3s poll.
            this._templateStatus = { ...verdict, checkedAt: new Date(now).toISOString() };
            // Recorded on EVERY check, fresh or stale: the dashboard needs the
            // lag trend to distinguish "our template is drifting" from "the
            // platform changed", and a gauge only written on failure cannot
            // show the approach.
            if (Number.isFinite(verdict.lag)) {
                this.#metric((m) => m.recordLinkedInTemplateLag(verdict.lag));
            }
        } catch (err) {
            log.warn('Template freshness check failed — keeping the current template', {
                err: err?.message,
            });
            return;
        }

        if (!verdict.stale) return;

        log.warn('LinkedIn RSC template is stale — re-capturing', {
            reason: verdict.reason,
            capturedVersion: verdict.captured,
            liveVersion: verdict.live,
            versionLag: verdict.lag,
            scraper_alert: 'linkedin_template_stale',
        });

        try {
            const fresh = await this._recaptureTemplate();
            if (fresh) {
                this._template = fresh;
                this.#metric((m) => m.recordLinkedInTemplateRecapture('succeeded'));
                log.info('LinkedIn RSC template re-captured', {
                    capturedVersion: fresh?.headers?.['x-li-application-version'] ?? null,
                });
            }
        } catch (err) {
            // Left deliberately loud: a host that cannot re-capture will drift
            // back into the outage, and the operator needs to know before the
            // canary starts reporting phantom bans.
            this.#metric((m) => m.recordLinkedInTemplateRecapture('failed'));
            log.error('LinkedIn RSC template re-capture FAILED — scrapes may return phantom empties', {
                err: err?.message,
                scraper_alert: 'linkedin_template_recapture_failed',
            });
        }
    }

    // Telemetry is strictly best-effort: a metrics problem must never affect a
    // scrape, and the module is imported lazily so unit tests that never touch
    // metrics do not pull in the registry.
    #metric(fn) {
        try {
            if (!this._metrics) return;
            fn(this._metrics);
        } catch { /* metrics must never break a scrape */ }
    }

    /**
     * Is the request we are sending still one LinkedIn will honour?
     *
     * Answers the question the canary cannot answer for itself: when a probe
     * comes back empty, is that the ACCOUNT being restricted or our REQUEST
     * being refused? A template whose client version has fallen far behind
     * produces a well-formed "no results" for every query, which is
     * indistinguishable from a ban at the transport level.
     *
     * Forces a check rather than reusing the interval-gated one: this is called
     * at the moment of conviction, where a stale cached answer could cost a
     * healthy credential four hours offline. One extra page fetch is trivial
     * against that.
     *
     * @returns {Promise<boolean>} false when the template looks stale/refused
     */
    async isRequestHealthy() {
        if (!this._templateHealth) return true;      // no checker → no opinion
        if (!this._template) {
            try {
                this._template = this._loadTemplate();
            } catch {
                return true;    // cannot assess; do not block the caller
            }
        }
        const { assessTemplate, fetchLiveClientVersion } = this._templateHealth;
        const liveVersion = await fetchLiveClientVersion({
            userAgent: this._template?.headers?.['user-agent'],
        });
        // Could not read LinkedIn's version at all. Report HEALTHY so a
        // network blip cannot indefinitely block a genuine ban verdict: the
        // canary must still be able to do its job when this check is blind.
        if (liveVersion === null) return true;

        const verdict = assessTemplate({
            template: this._template,
            liveVersion,
            now: this._now(),
        });
        if (verdict.stale) {
            log.error('Request template is stale — LinkedIn is refusing our request, not the account', {
                capturedVersion: verdict.captured,
                liveVersion: verdict.live,
                versionLag: verdict.lag,
                scraper_alert: 'linkedin_template_stale',
            });
            // Refresh immediately. The next scrape should not repeat the
            // failure that just prevented a (wrong) ban report, and the check
            // stamp is reset so the interval gate cannot skip it.
            this._templateCheckedAt = null;
            await this.#ensureTemplateFresh();
            return false;
        }
        return true;
    }

    #cookiesFresh(profileKey) {
        // Boolean, not the jar: isAlive() is reported over HTTP by /healthz and a
        // truthy-but-not-true value serialises misleadingly.
        const key = cacheKey(profileKey);
        const cookies = this._cookies.get(key);
        const cachedAt = this._cookiesAt.get(key);
        return Boolean(cookies) && Number.isFinite(cachedAt)
            && (this._now() - cachedAt) < this._ttlMs;
    }

    /** Single-flight cookie refresh, so concurrent roles share one browser launch. */
    async #refreshCookies(profileKey) {
        const key = cacheKey(profileKey);
        if (this.#cookiesFresh(key)) return this._cookies.get(key);
        if (this._refreshing.has(key)) return this._refreshing.get(key);
        const refresh = (async () => {
            const jar = await this._readCookies({ profileKey });
            if (!hasLiAt(jar)) {
                throw new AuthError(
                    'LinkedIn profile has no li_at — run `npm run linkedin:login` on this host',
                    { platform: 'linkedin', code: 'NEEDS_RELOGIN' },
                );
            }
            this._cookies.set(key, jar);
            this._cookiesAt.set(key, this._now());
            log.info('Read LinkedIn session cookies from profile', { cookies: jar.length });
            return jar;
        })();
        this._refreshing.set(key, refresh);
        refresh.then(
            () => {
                if (this._refreshing.get(key) === refresh) this._refreshing.delete(key);
            },
            () => {
                if (this._refreshing.get(key) === refresh) this._refreshing.delete(key);
            },
        );
        return refresh;
    }

    // Mode signal for storm protection. Treated as LOCAL unless we can positively
    // tell we are remote, so a single-account host never silently loses the pause.
    get isLocal() { return this._apiClient?.isLocal !== false; }

    /** True when a usable session jar is cached. Reported by /healthz. */
    isAlive() {
        return [...this._cookies.keys()].some((key) => this.#cookiesFresh(key));
    }

    /** No browser is held, so shutdown just drops the cached session. */
    async shutdown() {
        this._cookies.clear();
        this._cookiesAt.clear();
    }

    /** Drop the cached jar so the next role re-reads it (used after an auth failure). */
    invalidateCookies(profileKey = null) {
        const key = cacheKey(profileKey);
        this._cookies.delete(key);
        this._cookiesAt.delete(key);
    }

    // Best-effort platform pause. A marker-write failure must never mask the
    // auth error the caller is about to see.
    #pausePlatform() {
        try {
            this._cooldown.writeCooldownMarker({
                writeFile: this._cooldown.defaultWriteFile(),
                rename: this._cooldown.defaultRename(),
                now: new Date(),
                cooldownMs: this._cooldown.cooldownMs(),
                path: this._cooldown.cooldownPath(),
            });
            log.warn('LinkedIn session dead — platform cooled down; run `npm run linkedin:login` to recover', {
                platform: this._platform,
                scraper_alert: 'linkedin_auth_cooldown',
            });
        } catch (err) {
            log.error('Cooldown marker write failed', { err: err?.message });
        }
    }

    /**
     * Keep `lease` alive for as long as the scrape runs (SCR-4).
     *
     * A paginated RSC scrape can outlive the backend's 10-min stale-assignment
     * reaper, and a reaped lease means the pool hands this same credential to
     * another worker while we are still using it. The lease exposes
     * heartbeat() but nothing called it, which is the bug SCR-4 describes.
     *
     * Best-effort by design: a failed tick is retried on the next one and never
     * touches the scrape. The terminal cases that DO stop the ticker mean there
     * is nothing left to keep alive:
     *   - a local reply: no remote lease needs a heartbeat.
     *   - 'superseded': someone else owns the credential now.
     *   - 'no_lease':   already released (the per-role reportSuccess does this).
     *
     * @returns {() => void} stop
     */
    #startHeartbeat(lease) {
        if (this.isLocal || typeof lease?.heartbeat !== 'function' || !(this._heartbeatMs > 0)) {
            return () => {};
        }
        let stopped = false;
        let inFlight = false;
        const timer = this._scheduler.setInterval(async () => {
            // A tick slower than the interval must not stack up requests.
            if (stopped || inFlight) return;
            inFlight = true;
            try {
                const result = await lease.heartbeat();
                if (result?.ok === true && result.local === true) {
                    stop();
                } else if (result && result.ok === false
                    && ['superseded', 'no_lease'].includes(result.reason)) {
                    stop();
                    log.warn('Stopped lease heartbeat — lease is gone', {
                        platform: this._platform, reason: result.reason,
                    });
                }
            } catch (err) {
                // heartbeat() swallows its own errors; this is belt-and-braces
                // so an unexpected throw can never surface as an unhandled
                // rejection from a bare timer callback.
                log.warn('Lease heartbeat threw (ignored)', { err: err?.message });
            } finally {
                inFlight = false;
            }
        }, this._heartbeatMs);
        // A pending heartbeat must never be the reason the process stays alive.
        timer?.unref?.();
        const stop = () => {
            if (stopped) return;
            stopped = true;
            this._scheduler.clearInterval(timer);
        };
        return stop;
    }

    /**
     * Lease a credential, supply its cookie jar, and release the lease afterwards.
     * The lease is what the orchestrator's availability gate keys on, so it is
     * still taken even though no browser is held for the scrape itself.
     */
    async withCookies(sessionId, fn) {
        let lease;
        try {
            lease = await this._apiClient.acquire(this._platform, sessionId);
        } catch (cause) {
            throw new NetworkError(`LinkedIn credential pool unreachable: ${cause?.message ?? cause}`, {
                platform: 'linkedin', cause,
            });
        }
        if (!lease) {
            const err = new Error('No LinkedIn credential available');
            err.skipNoCreds = true;
            throw err;
        }
        const stopHeartbeat = this.#startHeartbeat(lease);
        try {
            const profileKey = lease.credential?.profile_key ?? null;
            const cookies = await this.#refreshCookies(profileKey);
            return await fn(cookies, lease);
        } catch (err) {
            if (err instanceof AuthError && err.code !== 'NEEDS_TEMPLATE') {
                // A dead session must not be reused by the next role...
                this.invalidateCookies(lease.credential?.profile_key ?? null);
                // ...and the BACKEND has to know, or it keeps the credential
                // "available" and the queue hands out LinkedIn roles that all
                // instantly 403. That is the fast-fail storm this codebase has
                // already been burned by the former LinkedIn path (PR #310).
                // Best-effort: never mask the original error with a report failure.
                try {
                    await lease.reportFailure?.(err.message, 0, { authDead: true });
                } catch (reportErr) {
                    log.error('Failed to report LinkedIn credential as auth-dead', {
                        err: reportErr?.message,
                    });
                }
                // LOCAL (single-account) storm protection, carried over from the
                // DOM path's authFailCooldownPlan: with no other account to rotate
                // to, a dead session must pause the platform or the orchestrator
                // fires a role every cycle that instantly 403s. In REMOTE mode the
                // pool rotates, so pausing all of LinkedIn would be self-inflicted
                // downtime — cool the account only.
                if (this.isLocal) this.#pausePlatform();
            }
            throw err;
        } finally {
            // Stop ticking BEFORE releasing, so a tick already scheduled cannot
            // land on a lease this block is about to hand back.
            stopHeartbeat();
            // release() is async today, but a sync one would make `.catch` on its
            // return value throw from inside finally and mask the real error.
            try {
                await lease.release?.();
            } catch (releaseErr) {
                log.warn('Failed to release LinkedIn credential lease', { err: releaseErr?.message });
            }
        }
    }
}

let singleton = null;
export function getLinkedInRscSession(opts) {
    if (!singleton) singleton = new LinkedInRscSession(opts);
    return singleton;
}
export function __resetLinkedInRscSessionForTest() {
    singleton = null;
}
