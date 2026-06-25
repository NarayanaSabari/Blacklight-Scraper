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
import { AuthError, NetworkError } from '../core/errors.js';
import * as linkedinCooldown from '../core/linkedin-cooldown.js';

const log = createLogger('linkedin-session');

// SHORT platform cooldown written when the credentials POOL is UNREACHABLE in
// REMOTE mode (Task A / spec decision 3). Distinct from the 30-min auth-dead
// cooldown: an unreachable pool is usually a transient outage, so we pause
// LinkedIn for one short window and let the next cycle re-probe rather than
// firing an uncoordinated local fallback. Override via env for tuning.
const DEFAULT_POOL_UNREACHABLE_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

export function poolUnreachableCooldownMs(env = process.env) {
    const raw = env?.LINKEDIN_POOL_UNREACHABLE_COOLDOWN_MIN;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_POOL_UNREACHABLE_COOLDOWN_MS;
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_POOL_UNREACHABLE_COOLDOWN_MS;
    return n * 60 * 1000;
}

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

// Gate for the coordinated single-flight re-login (off by default). When ON, an
// AuthError mid-scrape triggers ONE coordinated re-login (rotate to a fresh pool
// account) that concurrent tabs wait on + retry, instead of the legacy
// bail-when-busy reestablish that wedges the session until a process restart.
// Override with LINKEDIN_SINGLEFLIGHT_RELOGIN (1/true/yes → on).
export function linkedinSingleFlightRelogin(env = process.env) {
    const raw = env?.LINKEDIN_SINGLEFLIGHT_RELOGIN;
    if (raw === undefined || raw === null) return false;
    return ['1', 'true', 'yes'].includes(String(raw).trim().toLowerCase());
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
                  rotationJitter = defaultRotationJitter,
                  // Task A seam: the cooldown module (injectable so the
                  // pool-unreachable marker write is unit-testable without
                  // touching the real homedir filesystem).
                  cooldown = linkedinCooldown,
                  poolUnreachableCooldownMs: poolCooldownMs = poolUnreachableCooldownMs(),
                  // Coordinated single-flight re-login (off by default). isAuthFailure
                  // classifies an in-scrape error as "credential dead → re-login" (an
                  // AuthError by default); injectable for tests.
                  singleFlightRelogin = linkedinSingleFlightRelogin(),
                  isAuthFailure = (e) => e instanceof AuthError } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._cooldown = cooldown;
        this._poolUnreachableCooldownMs = poolCooldownMs;
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
        // Single-flight re-login state. _relogin holds the in-flight re-login
        // promise (so concurrent tabs coordinate on ONE re-login); _openPages
        // counts live borrowed pages so the re-login can quiesce (never tear
        // down the shared context under a live tab); _idleWaiters wake when the
        // last page closes.
        this._singleFlightRelogin = singleFlightRelogin;
        this._isAuthFailure = isAuthFailure;
        this._relogin = null;
        this._openPages = 0;
        this._idleWaiters = [];
    }

    get lease() { return this._lease; }
    isAlive() { return !!this._context; }

    // Mode signal for the auth-fail site (Task B) and pool-unreachable pause
    // (Task A). Reads the credentials client's local/remote flag. Treated as
    // LOCAL unless we can positively tell we're remote, so the live single-
    // account box's storm-protection is never silently dropped.
    get isLocal() { return this._apiClient?.isLocal !== false; }
    get isRemote() { return this._apiClient?.isLocal === false; }

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
        const profileKey = cred.profile_key;
        // Per-account warm-profile model: gate on profile_key ALONE. The on-disk
        // profile (logged in once via the per-account login command) is the only
        // session source — we NEVER inject leased cookies (that mismatches the
        // device fingerprint and triggers LinkedIn's security-code challenge).
        const perAccount = !!profileKey;

        if (perAccount) {
            this._context = await this._launch({ profileKey, proxy: cred.proxy ?? null });
            let authed = false;
            try { authed = this._isAuthed(await this._readCookies(this._context)); }
            catch { authed = false; }
            if (authed) {
                log.info('Reusing warm LinkedIn profile', { credentialId: cred.id, profileKey });
            } else {
                await this.#teardown(); // don't leave a dead context alive
                throw new AuthError(
                    'LinkedIn account not logged in — needs re-login',
                    { platform: 'linkedin', code: 'NEEDS_RELOGIN' });
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
        // Distinguish two failure shapes from the pool:
        //  • acquire() returns null  → HTTP 204 "no account available". Retry
        //    across the window; if still none, return null → #establish throws
        //    "No LinkedIn credential available". No platform marker (today's
        //    behavior — there may simply be no free account this instant).
        //  • acquire() throws NetworkError → the pool itself is UNREACHABLE.
        //    Retry across the window; if still unreachable, in REMOTE mode
        //    write a SHORT platform cooldown so the orchestrator PAUSES
        //    LinkedIn next cycle (no uncoordinated local fallback — spec
        //    decision 3), then re-throw. In LOCAL mode behavior is unchanged:
        //    no marker, the error propagates as before.
        let lastNetworkError = null;
        for (let i = 0; i < this._maxLeaseRetries; i++) {
            try {
                const lease = await this._apiClient.acquire(this._platform, sessionId);
                if (lease) return lease;
                lastNetworkError = null; // a clean 204 supersedes an earlier blip
            } catch (error) {
                if (!(error instanceof NetworkError)) throw error;
                lastNetworkError = error;
            }
            if (i < this._maxLeaseRetries - 1 && this._leaseRetryDelayMs > 0) {
                await new Promise(r => setTimeout(r, this._leaseRetryDelayMs));
            }
        }
        if (lastNetworkError) {
            // Pool unreachable after all retries.
            if (this.isRemote) this.#pausePlatformOnPoolUnreachable();
            throw lastNetworkError;
        }
        return null;
    }

    // REMOTE-only: write a SHORT local platform cooldown marker so the
    // orchestrator excludes LinkedIn next cycle (platform-cooldowns.js reads
    // it). Best-effort: a marker-write failure must never mask the underlying
    // NetworkError the caller is about to re-throw.
    #pausePlatformOnPoolUnreachable() {
        try {
            this._cooldown.writeCooldownMarker({
                writeFile: this._cooldown.defaultWriteFile(),
                rename: this._cooldown.defaultRename(),
                now: new Date(),
                cooldownMs: this._poolUnreachableCooldownMs,
                path: this._cooldown.cooldownPath(),
            });
            log.warn('LinkedIn credentials pool unreachable — platform paused for one short cycle', {
                platform: this._platform,
                scraper_alert: 'linkedin_pool_unreachable_cooldown',
                cooldownMin: Math.round(this._poolUnreachableCooldownMs / 60000),
            });
        } catch (cdErr) {
            log.error('Pool-unreachable cooldown write failed', { err: cdErr.message });
        }
    }

    async withPage(sessionId, fn) {
        const release = await this._sem.acquire();
        try {
            if (this._singleFlightRelogin) {
                return await this.#borrowWithRelogin(sessionId, fn, 1);
            }
            return await this.#legacyBorrowPage(sessionId, fn);
        } catch (err) {
            if (err?.code === 'NEEDS_RELOGIN') {
                // Pause this account: report it dead so the backend flips it to
                // needs_relogin and excludes it from claim. Best-effort; never mask
                // the original error. Do NOT trigger a re-login/rotate — that would
                // just storm onto other un-logged-in accounts.
                try { await this._lease?.reportFailure?.(err.message, 0, { authDead: true }); }
                catch { /* reporting is best-effort */ }
            }
            throw err;
        } finally {
            release();
        }
    }

    // Legacy borrow-a-page path (single-flight re-login OFF). Byte-unchanged
    // behavior: an AuthError mid-scrape is NOT retried here — the caller's
    // reestablish() (bail-when-busy) handles it.
    async #legacyBorrowPage(sessionId, fn) {
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
    }

    // Borrow-a-page path WITH coordinated single-flight re-login. On an AuthError
    // mid-scrape, trigger ONE re-login (rotate to a fresh pool account) that all
    // concurrent tabs wait on, then retry the role once on the fresh session —
    // instead of the legacy wedge-until-restart.
    async #borrowWithRelogin(sessionId, fn, retriesLeft) {
        // Park while a re-login is in flight so we proceed on the FRESH session,
        // not the dead one. A re-login failure rejects _relogin → fall through
        // and let our own ensureReady surface the real error.
        while (this._relogin) {
            try { await this._relogin; } catch { /* handled on our own path */ }
        }
        await this.ensureReady(sessionId);
        if (this._sem.inUse === 1 && this.#leaseExpired()) {
            await this.#rotateLease(sessionId);
        }
        const lease = this._lease;
        await this._jitter();
        const page = await this.#openPage(sessionId);
        let result;
        let caught = null;
        try {
            result = await fn(page, lease);
        } catch (err) {
            caught = err;
        } finally {
            await this.#closePage(page);
        }
        if (!caught) return result;
        if (retriesLeft > 0 && this._isAuthFailure(caught)) {
            await this.reloginOnce(sessionId);
            return await this.#borrowWithRelogin(sessionId, fn, retriesLeft - 1);
        }
        throw caught;
    }

    // Open a borrowed page, tracking it so a concurrent re-login can quiesce.
    // Keeps the legacy closed-context self-heal (re-establish + retry once).
    async #openPage(sessionId) {
        let page;
        try {
            page = await this._context.newPage();
        } catch {
            this._context = null;
            await this.ensureReady(sessionId);
            page = await this._context.newPage();
        }
        this._openPages++;
        return page;
    }

    // Close a borrowed page and, when the last one closes, wake any re-login
    // waiting to quiesce.
    async #closePage(page) {
        try { await page.close(); } catch { /* best-effort */ }
        this._openPages--;
        if (this._openPages === 0) this.#fireIdle();
    }

    // Single-flight re-login: the FIRST caller performs the re-login; concurrent
    // callers await the SAME promise. Clears on completion so a later auth death
    // can re-login again.
    async reloginOnce(sessionId) {
        this._relogin ??= this.#performRelogin(sessionId).finally(() => { this._relogin = null; });
        return this._relogin;
    }

    // Quiesce (wait for live pages to drain) → drop the dead lease + context →
    // re-acquire a FRESH pool account → relaunch. Quiescing first guarantees we
    // never tear down the shared context under a live tab.
    async #performRelogin(sessionId) {
        await this.#whenPagesIdle();
        await this.#dropAndReacquire(sessionId);
    }

    // Resolves once no page is borrowed (immediately if already idle).
    #whenPagesIdle() {
        if (this._openPages === 0) return Promise.resolve();
        return new Promise((resolve) => { this._idleWaiters.push(resolve); });
    }

    #fireIdle() {
        const waiters = this._idleWaiters;
        this._idleWaiters = [];
        for (const w of waiters) w();
    }

    async reestablish(sessionId) {
        // Single-flight re-login ON: this is a NO-OP. linkedin.js calls
        // reestablish() from INSIDE the withPage callback (the borrower's page is
        // still open), so tearing down here would close the shared context under
        // a live tab. The coordinated re-login instead runs in #borrowWithRelogin
        // AFTER fn throws + the page closes (quiesced, single-flight, retried).
        if (this._singleFlightRelogin) {
            return;
        }
        // Legacy (flag OFF): don't tear down the SHARED context while sibling
        // borrowers are mid-scrape (concurrent LinkedIn roles) — closing it
        // cascades "context has been closed" failures into every sibling.
        // Re-launching the persistent profile can't fix expired cookies anyway
        // (that needs a manual `npm run linkedin:login`), so when busy we just
        // keep the warm context; the AuthError caller already applied the
        // credential cooldown.
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
// Test-only: install a fake/stub session so callers that read the singleton
// (e.g. scrapeLinkedIn) can exercise the auth-fail wiring without a real
// browser. Pair with __resetLinkedInSessionForTest() in test teardown.
export function __setLinkedInSessionForTest(session) { _singleton = session; }
