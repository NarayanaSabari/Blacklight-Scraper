// Blacklight Scraper Queue API client.
// All Blacklight-specific HTTP contracts live here; the orchestrator only
// sees domain-level methods (checkActiveSession, getNextRole, ...).

import { requestWithRetry } from '../http/client.js';
import { NetworkError } from '../core/errors.js';
import { getMetrics } from '../metrics/registry.js';

function statusBucket(status) {
    if (status >= 500) return '5xx';
    if (status >= 400) return '4xx';
    if (status >= 300) return '3xx';
    if (status >= 200) return '2xx';
    return 'error';
}

export class BlacklightApiClient {
    constructor(apiUrl, apiKey) {
        if (!apiUrl || !apiKey) {
            throw new Error('BlacklightApiClient requires apiUrl and apiKey');
        }
        this.apiUrl = apiUrl.replace(/\/$/, '');
        this.headers = Object.freeze({
            'X-Scraper-API-Key': apiKey,
            'Content-Type': 'application/json',
        });
    }

    async #request(method, path, body = undefined) {
        const url = `${this.apiUrl}${path}`;
        const options = { method, headers: this.headers };
        if (body !== undefined) options.body = JSON.stringify(body);

        const metrics = getMetrics();
        const endpointLabel = `${method} ${path}`;

        let response;
        try {
            response = await requestWithRetry(url, options);
        } catch (error) {
            metrics.recordBlacklightApiRequest(endpointLabel, 'error');
            throw error;
        }

        metrics.recordBlacklightApiRequest(endpointLabel, statusBucket(response.status));

        if (response.status === 204) return { _empty: true };

        if (response.status === 202 || response.ok) {
            return response.json();
        }

        // 4xx non-retryable: surface a structured error.
        if (response.status === 409) {
            throw new NetworkError('Scraper already has an active session', { statusCode: 409 });
        }
        throw new NetworkError(
            `Blacklight ${method} ${path} → ${response.status} ${response.statusText}`,
            { statusCode: response.status },
        );
    }

    async checkActiveSession() {
        return this.#request('GET', '/api/scraper/queue/current-session');
    }

    async getNextRole({ platforms = null } = {}) {
        // Per-platform queue model. Returns:
        //   { assignments: [
        //       { session_id, role: {...}, platforms: [...] },
        //       ...
        //   ] }
        // A single poll can yield multiple assignments — the backend
        // claims one pending pair per platform in this key's allowlist
        // across the entire queue, possibly spanning multiple roles.
        // Returns null if the queue has no claimable pairs for this
        // scraper (HTTP 204 → _empty marker from #request).
        //
        // `platforms` is an optional runtime filter from the
        // orchestrator's credential-availability pre-flight. When set,
        // the backend takes static_allowlist ∩ this list as the
        // effective allowlist for THIS claim only. Skips platforms
        // whose creds are out of stock without backend-config changes.
        let path = '/api/scraper/queue/next-role';
        if (Array.isArray(platforms) && platforms.length > 0) {
            path += `?platforms=${encodeURIComponent(platforms.join(','))}`;
        }
        const result = await this.#request('GET', path);
        return result._empty ? null : result;
    }

    async checkCredentialAvailability() {
        // Pre-flight before claiming a role. Returns leasable-credential
        // counts per active platform:
        //   { indeed: 2, linkedin: 1, glassdoor: 999, ... }
        // 999 means "no auth required for this platform". 0 means
        // exclude it from the next claim. See the backend's
        // /api/scraper-credentials/queue/availability docstring for
        // why this exists (spam-prevention on credential-starved
        // platforms).
        const url = `${this.apiUrl}/api/scraper-credentials/queue/availability`;
        const response = await requestWithRetry(url, {
            method: 'GET',
            headers: this.headers,
        });
        if (!response.ok) {
            throw new NetworkError(
                `Credential availability check → ${response.status} ${response.statusText}`,
                { statusCode: response.status },
            );
        }
        return response.json();
    }

    async submitJobs(sessionId, platform, jobs, status = 'success', errorMessage = null) {
        const body = {
            session_id: sessionId,
            platform,
            jobs,
        };
        if (status === 'failed') {
            body.status = 'failed';
            body.error_message = errorMessage;
        }
        return this.#request('POST', '/api/scraper/queue/jobs', body);
    }

    async completeSession(sessionId) {
        return this.#request('POST', '/api/scraper/queue/complete', { session_id: sessionId });
    }
}
