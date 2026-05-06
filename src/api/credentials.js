// Scraper Credentials Queue API client.
//
// Two APIs are exposed:
//
//  1. Legacy (platform-keyed) — for existing scrapers that call:
//       const api = getCredentialsClient();
//       const cred = await api.getCredential('linkedin');
//       await api.reportSuccess('linkedin');
//
//  2. Lease-based (race-safe) — new code should use:
//       const lease = await api.acquire('linkedin', sessionId);
//       try { ... lease.credential ... }
//       finally { await lease.reportSuccess('...msg...') }
//
// Internally both APIs share the same lease map. Each acquire() issues a
// unique lease id, so two concurrent scrapes on the same platform can no
// longer stomp each other's credential state.
//
// ⚠️  KNOWN LIMITATION (latent — does not trigger today):
//   The legacy platform-keyed API resolves leases via `latestByPlatform`.
//   If two concurrent `acquire('linkedin')` calls happen, the second
//   overwrites the pointer. A subsequent `reportSuccess('linkedin')`
//   from the first caller will release the SECOND caller's lease,
//   orphaning it.
//
//   The current scraper orchestration runs platforms sequentially via
//   QueueOrchestrator, so this race cannot fire in practice. If anyone
//   parallelizes platform scrapes in the future, migrate ALL callers to
//   the lease-based API (`lease.reportSuccess()`) before doing so.

import { requestWithRetry } from '../http/client.js';
import { getConfig } from '../config/env.js';
import { createLogger } from '../logger/index.js';
import { NetworkError, AuthError } from '../core/errors.js';
import { getMetrics } from '../metrics/registry.js';

const log = createLogger('credentials');

class CredentialsClient {
    constructor({ apiUrl, apiKey }) {
        this.apiUrl = apiUrl ? apiUrl.replace(/\/$/, '') : null;
        this.apiKey = apiKey ?? null;
        this.isLocal = !apiUrl || !apiKey;
        this.headers = this.isLocal ? null : Object.freeze({
            'X-Scraper-API-Key': apiKey,
            'Content-Type': 'application/json',
        });
        // Map<leaseKey, lease>
        this.leases = new Map();
        // Legacy: per-platform pointer to the most recently issued lease.
        this.latestByPlatform = new Map();
        this.nextNonce = 1;
    }

    // ----- lease bookkeeping ------------------------------------------------

    #issueLease(platform, id, data) {
        const nonce = this.nextNonce++;
        const leaseKey = `${platform}:${id}:${nonce}`;
        const lease = { leaseKey, platform, id, data };
        this.leases.set(leaseKey, lease);
        this.latestByPlatform.set(platform, leaseKey);
        return lease;
    }

    #resolveLease(leaseKeyOrPlatform) {
        if (!leaseKeyOrPlatform) return null;
        // Direct leaseKey hit
        if (this.leases.has(leaseKeyOrPlatform)) return this.leases.get(leaseKeyOrPlatform);
        // Legacy platform name lookup
        const key = this.latestByPlatform.get(leaseKeyOrPlatform);
        return key ? this.leases.get(key) : null;
    }

    #forgetLease(lease) {
        this.leases.delete(lease.leaseKey);
        if (this.latestByPlatform.get(lease.platform) === lease.leaseKey) {
            this.latestByPlatform.delete(lease.platform);
        }
    }

    // ----- remote HTTP helpers ---------------------------------------------

    async #postLeaseAction(lease, action, body = {}) {
        const url = `${this.apiUrl}/api/scraper-credentials/queue/${lease.id}/${action}`;
        const response = await requestWithRetry(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new NetworkError(
                `Credentials API ${action} failed: ${response.status} ${response.statusText}`,
                { statusCode: response.status },
            );
        }
        return response.json();
    }

    // ----- acquire ----------------------------------------------------------

    async acquire(platform, sessionId = null) {
        const metrics = getMetrics();
        if (this.isLocal) {
            const raw = getConfig().rawCredentials ?? {};
            const cred = raw[platform.toLowerCase()];
            if (!cred) {
                log.warn('No local credential found', { platform });
                metrics.recordCredentialsFetch(platform, 'none');
                return null;
            }
            const id = `local-${platform}`;
            const lease = this.#issueLease(platform, id, { id, ...cred });
            metrics.recordCredentialsFetch(platform, 'found');
            return this.#wrapLease(lease);
        }

        const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
        const url = `${this.apiUrl}/api/scraper-credentials/queue/${platform}/next${query}`;

        log.info('Fetching credential from API', { platform });
        let response;
        try {
            response = await requestWithRetry(url, { method: 'GET', headers: this.headers });
        } catch (error) {
            metrics.recordCredentialsFetch(platform, 'error');
            throw error;
        }

        if (response.status === 204) {
            log.warn('No credentials available', { platform });
            metrics.recordCredentialsFetch(platform, 'none');
            return null;
        }
        if (response.status === 401 || response.status === 403) {
            metrics.recordCredentialsFetch(platform, 'error');
            throw new AuthError(`Credentials API denied access (${response.status})`, { platform });
        }
        if (!response.ok) {
            metrics.recordCredentialsFetch(platform, 'error');
            throw new NetworkError(
                `Credentials API returned ${response.status} ${response.statusText}`,
                { statusCode: response.status, platform },
            );
        }

        const credential = await response.json();
        const lease = this.#issueLease(platform, credential.id, credential);
        log.info('Credential acquired', {
            platform,
            name: credential.name ?? credential.email ?? `id=${credential.id}`,
        });
        metrics.recordCredentialsFetch(platform, 'found');
        return this.#wrapLease(lease);
    }

    #wrapLease(lease) {
        return {
            get leaseKey() { return lease.leaseKey; },
            get credential() { return lease.data; },
            get platform() { return lease.platform; },
            reportSuccess: (message) => this.reportSuccess(lease.leaseKey, message),
            reportFailure: (msg, cooldownMinutes) => this.reportFailure(lease.leaseKey, msg, cooldownMinutes),
            release: () => this.release(lease.leaseKey),
        };
    }

    // ----- legacy-compatible methods ---------------------------------------

    async getCredential(platform, sessionId = null) {
        const lease = await this.acquire(platform, sessionId);
        return lease ? lease.credential : null;
    }

    async reportSuccess(leaseKeyOrPlatform, message = null) {
        const lease = this.#resolveLease(leaseKeyOrPlatform);
        if (!lease) {
            log.warn('No active credential to report success for', { key: leaseKeyOrPlatform });
            return;
        }
        if (this.isLocal || String(lease.id).startsWith('local-')) {
            this.#forgetLease(lease);
            return;
        }
        try {
            await this.#postLeaseAction(lease, 'success', message ? { message } : {});
            log.info('Credential released (success)', { platform: lease.platform });
        } catch (error) {
            log.error('Failed to report credential success', { platform: lease.platform, err: error.message });
        } finally {
            this.#forgetLease(lease);
        }
    }

    async reportFailure(leaseKeyOrPlatform, errorMessage, cooldownMinutes = 0) {
        const lease = this.#resolveLease(leaseKeyOrPlatform);
        if (!lease) {
            log.warn('No active credential to report failure for', { key: leaseKeyOrPlatform });
            return;
        }
        if (this.isLocal || String(lease.id).startsWith('local-')) {
            this.#forgetLease(lease);
            return;
        }
        try {
            await this.#postLeaseAction(lease, 'failure', {
                error_message: errorMessage,
                cooldown_minutes: cooldownMinutes,
            });
            log.warn('Credential marked failed', { platform: lease.platform, cooldownMinutes });
        } catch (error) {
            log.error('Failed to report credential failure', { platform: lease.platform, err: error.message });
        } finally {
            this.#forgetLease(lease);
        }
    }

    async release(leaseKeyOrPlatform) {
        const lease = this.#resolveLease(leaseKeyOrPlatform);
        if (!lease) return;
        if (this.isLocal || String(lease.id).startsWith('local-')) {
            this.#forgetLease(lease);
            return;
        }
        try {
            await this.#postLeaseAction(lease, 'release');
        } catch (error) {
            log.error('Failed to release credential', { platform: lease.platform, err: error.message });
        } finally {
            this.#forgetLease(lease);
        }
    }

    getActiveCredential(platform) {
        const lease = this.#resolveLease(platform);
        return lease ? lease.data : null;
    }

    async releaseAll() {
        const keys = Array.from(this.leases.keys());
        for (const key of keys) {
            await this.release(key);
        }
    }
}

// Singleton — initialised at startup.
let client = null;

export function initializeCredentialsClient() {
    const cfg = getConfig();
    const api = cfg.scraperCredentialsApi;
    if (cfg.isDevelopment || !api) {
        log.info('Using LOCAL credentials (credentials.json)');
        client = new CredentialsClient({ apiUrl: null, apiKey: null });
    } else {
        log.info('Using REMOTE credentials API');
        client = new CredentialsClient({ apiUrl: api.apiUrl, apiKey: api.apiKey });
    }
    return client;
}

export function getCredentialsClient() {
    if (!client) {
        client = new CredentialsClient({ apiUrl: null, apiKey: null });
    }
    return client;
}

// Legacy alias — lets existing scrapers keep using `getCredentialsAPIClient()`
// from the old common/credentialsAPI.js path without code churn.
export const getCredentialsAPIClient = getCredentialsClient;
