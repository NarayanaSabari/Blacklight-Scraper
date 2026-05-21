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

const log = createLogger('linkedin-session');

export class LinkedInSession {
    constructor({ apiClient = null, launcher = launchPersistentProfile, platform = 'linkedin',
                  maxLeaseRetries = 10, leaseRetryDelayMs = 60000 } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._launch = launcher;
        this._platform = platform;
        this._maxLeaseRetries = maxLeaseRetries;
        this._leaseRetryDelayMs = leaseRetryDelayMs;
        this._lease = null;
        this._context = null;
        this._establishing = null; // single-flight promise
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
        await this.ensureReady(sessionId);
        const page = await this._context.newPage();
        try { return await fn(page); }
        finally { await page.close().catch(() => {}); }
    }

    async reestablish(sessionId) {
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
