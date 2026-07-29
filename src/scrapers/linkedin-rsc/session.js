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

const log = createLogger('linkedin-rsc-session');

const DEFAULT_COOKIE_TTL_MS = 30 * 60 * 1000; // 30 min

export function cookieTtlMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_RSC_COOKIE_TTL_MIN ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOKIE_TTL_MS;
    return n * 60 * 1000;
}

export function templatePath(env = process.env) {
    return env?.LINKEDIN_RSC_TEMPLATE
        || path.join(process.cwd(), 'config', 'linkedin-rsc-template.json');
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
    } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._platform = platform;
        this._readCookies = cookieReader;
        this._loadTemplate = templateLoader;
        this._ttlMs = ttlMs;
        this._now = now;
        this._cooldown = cooldown;
        this._cookies = null;
        this._cookiesAt = 0;
        this._template = null;
        this._refreshing = null;
    }

    /** Cached template; loaded once per process. */
    async template() {
        if (!this._template) this._template = this._loadTemplate();
        return this._template;
    }

    #cookiesFresh() {
        // Boolean, not the jar: isAlive() is reported over HTTP by /healthz and a
        // truthy-but-not-true value serialises misleadingly.
        return Boolean(this._cookies) && (this._now() - this._cookiesAt) < this._ttlMs;
    }

    /** Single-flight cookie refresh, so concurrent roles share one browser launch. */
    async #refreshCookies(profileKey) {
        if (this.#cookiesFresh()) return this._cookies;
        if (this._refreshing) return this._refreshing;
        this._refreshing = (async () => {
            const jar = await this._readCookies({ profileKey });
            if (!hasLiAt(jar)) {
                throw new AuthError(
                    'LinkedIn profile has no li_at — run `npm run linkedin:login` on this host',
                    { platform: 'linkedin', code: 'NEEDS_RELOGIN' },
                );
            }
            this._cookies = jar;
            this._cookiesAt = this._now();
            log.info('Read LinkedIn session cookies from profile', { cookies: jar.length });
            return jar;
        })().finally(() => { this._refreshing = null; });
        return this._refreshing;
    }

    // Mode signal for storm protection. Treated as LOCAL unless we can positively
    // tell we are remote, so a single-account host never silently loses the pause.
    get isLocal() { return this._apiClient?.isLocal !== false; }

    /** True when a usable session jar is cached. Reported by /healthz. */
    isAlive() { return this.#cookiesFresh(); }

    /** No browser is held, so shutdown just drops the cached session. */
    async shutdown() { this.invalidateCookies(); }

    /** Drop the cached jar so the next role re-reads it (used after an auth failure). */
    invalidateCookies() {
        this._cookies = null;
        this._cookiesAt = 0;
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
        try {
            const cookies = await this.#refreshCookies(lease.credential?.profile_key ?? null);
            return await fn(cookies, lease);
        } catch (err) {
            if (err instanceof AuthError) {
                // A dead session must not be reused by the next role...
                this.invalidateCookies();
                // ...and the BACKEND has to know, or it keeps the credential
                // "available" and the queue hands out LinkedIn roles that all
                // instantly 403. That is the fast-fail storm this codebase has
                // already been burned by (see scrapers/linkedin.js on PR #310).
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
