// One long-lived CloakBrowser persistent-profile context + credential lease
// for the process lifetime (design: persistent-session D1b, manual-login
// model). scrapeLinkedIn borrows a page per role via withPage(); the
// context/lease are NOT torn down per role. The browser session lives in an
// on-disk profile the operator logged into once (`npm run linkedin:login`) —
// no per-run cookie injection. The lease is still acquired as a slot/lock for
// the orchestrator's availability gate + email/password re-login fallback.
import { launchPersistentProfile, hasLiAt } from '../../scrapers/linkedin.js';
import { getCredentialsAPIClient } from '../api/credentials.js';
import { createLogger } from '../logger/index.js';
import { Semaphore } from '../core/semaphore.js';

const log = createLogger('linkedin-session');

// Concurrency cap for parallel LinkedIn tabs on the single account. Default 2
// (conservative — one session running many concurrent searches gets
// shadow-banned). Override with LINKEDIN_MAX_CONCURRENCY (positive integer).
export function linkedinMaxConcurrency(env = process.env) {
    const raw = env?.LINKEDIN_MAX_CONCURRENCY;
    if (raw === undefined || raw === null || raw === '') return 2;
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return 2;
    return n;
}

// Staggered start so the N tabs don't hit LinkedIn in lockstep. 500–2000ms.
function defaultJitter() {
    return new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 1500)));
}

// Max-lease rotation window (hours, float) from LINKEDIN_LEASE_ROTATE_HOURS.
// UNSET / 0 / NaN / <=0 ⇒ null ⇒ time-driven rotation DISABLED (default — the
// live single-account box is byte-unchanged). H > 0 ⇒ rotate after ~H hours so
// the scraper never camps one account (the pool hands out the next available
// account on the re-lease). Reads env unless an explicit value is injected.
export function linkedinLeaseRotateHours(raw = process.env.LINKEDIN_LEASE_ROTATE_HOURS) {
    if (raw === undefined || raw === null || raw === '') return null;
    const h = Number.parseFloat(String(raw));
    if (!Number.isFinite(h) || h <= 0) return null;
    return h;
}

// Returns a multiplier in [0, 1) used to jitter the lease cap by ±20% so a
// fleet of scrapers doesn't rotate in lockstep. Injectable for deterministic
// tests; defaults to Math.random.
function defaultRotationJitter() {
    return Math.random();
}

export class LinkedInSession {
    constructor({ apiClient = null, launcher = launchPersistentProfile, platform = 'linkedin',
                  maxLeaseRetries = 10, leaseRetryDelayMs = 60000,
                  maxConcurrency = linkedinMaxConcurrency(), jitter = defaultJitter,
                  // Seams for unit-testing the seed-vs-reuse decision without a
                  // real browser: readCookies pulls the context's current jar,
                  // isAuthed classifies it (li_at present).
                  readCookies = (ctx) => ctx.cookies(), isAuthed = hasLiAt,
                  // Time-driven rotation seams. now() is the clock (injectable
                  // so tests advance time without real timers). rotateHours is
                  // the configured window (defaults to reading the env);
                  // rotationJitter returns [0,1) for the ±20% cap jitter.
                  now = () => Date.now(),
                  rotateHours = linkedinLeaseRotateHours(),
                  rotationJitter = defaultRotationJitter } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._launch = launcher;
        this._platform = platform;
        this._maxLeaseRetries = maxLeaseRetries;
        this._leaseRetryDelayMs = leaseRetryDelayMs;
        this._lease = null;
        this._context = null;
        this._establishing = null; // single-flight promise
        this._sem = new Semaphore(maxConcurrency);
        this._jitter = jitter;
        this._readCookies = readCookies;
        this._isAuthed = isAuthed;
        // Rotation state. _rotateHours null ⇒ rotation OFF (default). _maxLeaseMs
        // is the jittered per-lease deadline, (re)computed in #establish so each
        // lease has its own stable cap. _establishedAt is the lease birth time.
        this._now = now;
        this._rotateHours = linkedinLeaseRotateHours(rotateHours);
        this._rotationJitter = rotationJitter;
        this._maxLeaseMs = null;
        this._establishedAt = 0;
    }

    get lease() { return this._lease; }
    isAlive() { return !!this._context; }

    async ensureReady(sessionId) {
        if (this._context) return;
        if (this._establishing) return this._establishing;
        this._establishing = this.#establish(sessionId).finally(() => { this._establishing = null; });
        return this._establishing;
    }

    async #establish(sessionId) {
        const lease = await this.#acquireLease(sessionId);
        if (!lease) throw new Error('No LinkedIn credential available from API');
        this._lease = lease;
        // Stamp the lease birth time and (re)compute its jittered rotation cap.
        // Done per (re)establish so every lease gets its own stable deadline.
        this._establishedAt = this._now();
        this._maxLeaseMs = this.#computeMaxLeaseMs();

        const cred = lease.credential || {};
        const cookies = cred.cookies;
        const profileKey = cred.profile_key;
        // Per-account seed+proxy path activates ONLY when the lease carries
        // BOTH a non-empty cookie jar AND a profile_key (future A3 accounts).
        // When either is absent (local mode / current accounts) the behavior is
        // byte-identical to before: launchPersistentProfile() with NO args
        // (fixed dir, no proxy) and NO cookie injection.
        const perAccount = Array.isArray(cookies) && cookies.length > 0 && !!profileKey;

        if (perAccount) {
            // Launch the per-account on-disk profile, routed through the
            // account's static proxy (Task 2 threads profileKey + proxy).
            this._context = await this._launch({ profileKey, proxy: cred.proxy ?? null });
            // Seed-vs-reuse: only seed when the aged profile lacks valid auth
            // (no li_at). An already-authed profile is reused (organic aging) —
            // reseeding would clobber a fresher in-profile session.
            let authed = false;
            try {
                authed = this._isAuthed(await this._readCookies(this._context));
            } catch { authed = false; }
            if (!authed) {
                await this._context.addCookies(cookies);
                log.info('Seeded LinkedIn profile from leased cookie jar', {
                    credentialId: cred.id, profileKey, cookies: cookies.length });
            } else {
                log.info('Reusing authed LinkedIn profile (no reseed)', {
                    credentialId: cred.id, profileKey });
            }
        } else {
            // launchPersistentProfile returns a BrowserContext directly (no
            // separate Browser handle); the operator's logged-in session lives
            // in the on-disk profile, so we do NOT inject the lease's cookies.
            this._context = await this._launch();
        }
        log.info('Persistent LinkedIn session established', { credentialId: cred.id });
    }

    // Jittered max-lease window in ms, or null when rotation is disabled. Base
    // is H hours, scaled by 0.8–1.2 (±20%) via the injectable jitter seam.
    #computeMaxLeaseMs() {
        if (this._rotateHours == null) return null;
        const baseMs = this._rotateHours * 60 * 60 * 1000;
        const r = this._rotationJitter(); // [0, 1)
        const factor = 0.8 + 0.4 * (Number.isFinite(r) ? r : 0); // 0.8 .. 1.2
        return baseMs * factor;
    }

    // True when time-driven rotation is enabled AND the live lease has outlived
    // its jittered cap. Only meaningful for an already-established context.
    #leaseExpired() {
        return this._maxLeaseMs != null
            && this._context != null
            && (this._now() - this._establishedAt) > this._maxLeaseMs;
    }

    async #acquireLease(sessionId) {
        for (let i = 0; i < this._maxLeaseRetries; i++) {
            const lease = await this._apiClient.acquire(this._platform, sessionId);
            if (lease) return lease;
            if (i < this._maxLeaseRetries - 1 && this._leaseRetryDelayMs > 0) {
                await new Promise(r => setTimeout(r, this._leaseRetryDelayMs));
            }
        }
        return null;
    }

    async withPage(sessionId, fn) {
        const release = await this._sem.acquire();
        try {
            await this.ensureReady(sessionId);
            // Time-driven rotation: if the live lease has aged past its jittered
            // cap, release + re-lease BEFORE borrowing a page so the pool rotates
            // us onto the next available account (never camp one account).
            // Single-flight-safe: we hold the ONLY semaphore slot here
            // (inUse === 1 ⇒ no sibling is mid-scrape), so tearing down the
            // shared context can't cascade "context closed" into a sibling; and
            // the re-establish inside #rotateLease goes through ensureReady's
            // _establishing guard. With rotation disabled (default) this is inert.
            if (this._sem.inUse === 1 && this.#leaseExpired()) {
                await this.#rotateLease(sessionId);
            }
            // Capture the lease atomically (no await between this and ensureReady)
            // as a stable per-borrower reference: a sibling scrape's reestablish()
            // can null this._lease mid-flight, so the callback uses this captured
            // ref instead of re-reading the shared singleton lease.
            const lease = this._lease;
            await this._jitter();            // staggered start (no-op in tests)
            let page;
            try {
                page = await this._context.newPage();
            } catch {
                // The shared context was closed (a sibling's reestablish, or a
                // genuine browser crash). Drop it, re-establish (single-flight),
                // and retry once so this borrower self-heals instead of failing.
                this._context = null;
                await this.ensureReady(sessionId);
                page = await this._context.newPage();
            }
            try { return await fn(page, lease); }
            finally { await page.close().catch(() => {}); }
        } finally {
            release();
        }
    }

    async reestablish(sessionId) {
        // Don't tear down the SHARED context while sibling borrowers are
        // mid-scrape (concurrent LinkedIn roles) — closing it cascades
        // "context has been closed" failures into every sibling. Re-launching
        // the persistent profile can't fix expired cookies anyway (that needs a
        // manual `npm run linkedin:login`), so when busy we just keep the warm
        // context; the AuthError caller already applied the credential cooldown.
        if (this._sem && this._sem.inUse > 0) {
            return;
        }
        await this.#dropAndReacquire(sessionId);
    }

    // Time-driven rotation: release the aged lease and re-acquire (the pool
    // hands out the NEXT available account). Called from withPage ONLY when the
    // caller holds the sole semaphore slot (inUse === 1), so — unlike
    // reestablish's AuthError path — there's no busy guard to honor: no sibling
    // borrower can be disrupted by tearing down the shared context.
    async #rotateLease(sessionId) {
        await this.#dropAndReacquire(sessionId);
    }

    // Shared teardown → release → re-establish. ensureReady's _establishing
    // guard keeps the re-establish single-flight; #establish re-stamps
    // _establishedAt + recomputes the jittered cap so the fresh lease isn't
    // immediately re-rotated.
    async #dropAndReacquire(sessionId) {
        await this.#teardown();
        try { await this._lease?.release?.(); } catch { /* best-effort */ }
        this._lease = null;
        await this.ensureReady(sessionId);
    }

    async shutdown() {
        await this.#teardown();
        try { await this._lease?.release?.(); } catch { /* best-effort */ }
        this._lease = null;
    }

    async #teardown() {
        const ctx = this._context;
        this._context = null;
        if (ctx) {
            // Persistent context: close the context (flushes the profile to
            // disk); also close its Browser if Playwright exposes one.
            try { await ctx.close(); } catch { /* already closed */ }
            try { await ctx.browser?.()?.close?.(); } catch { /* none / already closed */ }
        }
    }
}

let _singleton = null;
export function getLinkedInSession() { return (_singleton ??= new LinkedInSession()); }
export function __resetLinkedInSessionForTest() { _singleton = null; }
