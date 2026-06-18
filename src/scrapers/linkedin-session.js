// One long-lived CloakBrowser persistent-profile context + credential lease
// for the process lifetime (design: persistent-session D1b, manual-login
// model). scrapeLinkedIn borrows a page per role via withPage(); the
// context/lease are NOT torn down per role. The browser session lives in an
// on-disk profile the operator logged into once (`npm run linkedin:login`) —
// no per-run cookie injection. The lease is still acquired as a slot/lock for
// the orchestrator's availability gate + email/password re-login fallback.
import { launchPersistentProfile } from '../../scrapers/linkedin.js';
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

export class LinkedInSession {
    constructor({ apiClient = null, launcher = launchPersistentProfile, platform = 'linkedin',
                  maxLeaseRetries = 10, leaseRetryDelayMs = 60000,
                  maxConcurrency = linkedinMaxConcurrency(), jitter = defaultJitter } = {}) {
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
        // launchPersistentProfile returns a BrowserContext directly (no
        // separate Browser handle); the operator's logged-in session lives in
        // the on-disk profile, so we do NOT inject the lease's cookies.
        this._context = await this._launch();
        log.info('Persistent LinkedIn session established', { credentialId: lease.credential?.id });
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
