// One long-lived CloakBrowser context + credential lease for the process
// lifetime (design: persistent-session D1b). scrapeLinkedIn borrows a page
// per role via withPage(); the context/lease are NOT torn down per role.
import { launchWithCookies } from '../../scrapers/linkedin.js';
import { getCredentialsAPIClient } from '../api/credentials.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('linkedin-session');

export class LinkedInSession {
    constructor({ apiClient = null, launcher = launchWithCookies, platform = 'linkedin',
                  maxLeaseRetries = 10, leaseRetryDelayMs = 60000 } = {}) {
        this._apiClient = apiClient ?? getCredentialsAPIClient();
        this._launch = launcher;
        this._platform = platform;
        this._maxLeaseRetries = maxLeaseRetries;
        this._leaseRetryDelayMs = leaseRetryDelayMs;
        this._lease = null;
        this._browser = null;
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
        const { browser, context } = await this._launch(lease.credential);
        this._browser = browser;
        this._context = context;
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
        await this.#teardownBrowser();
        try { await this._lease?.release?.(); } catch { /* best-effort */ }
        this._lease = null;
        await this.ensureReady(sessionId);
    }

    async shutdown() {
        await this.#teardownBrowser();
        try { await this._lease?.release?.(); } catch { /* best-effort */ }
        this._lease = null;
    }

    async #teardownBrowser() {
        const b = this._browser;
        this._browser = null;
        this._context = null;
        if (b) { try { await b.close(); } catch { /* already closed */ } }
    }
}

let _singleton = null;
export function getLinkedInSession() { return (_singleton ??= new LinkedInSession()); }
export function __resetLinkedInSessionForTest() { _singleton = null; }
