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

    async getNextRole() {
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
        const result = await this.#request('GET', '/api/scraper/queue/next-role');
        return result._empty ? null : result;
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
