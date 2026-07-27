// Local spool for undeliverable job submissions (SCR-15).
//
// submitJobs/completeSession are exempt from the HTTP circuit breaker
// (client.js) because failing them loses already-scraped work, not just
// delays a claim. But retries still run out eventually — a sustained
// backend outage, not just a blip. When that happens, this module writes
// the payload to disk so it is recoverable (manual replay / a future
// backfill script) instead of being dropped on the floor.
//
// One file per undeliverable submission — plain JSON, human-inspectable.
// `results/` is already gitignored, so `results/spool/` needs no new
// .gitignore entry. Override the location with SPOOL_DIR for tests or
// alternate deployments.

import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger/index.js';

const log = createLogger('submit-spool');

const DEFAULT_SPOOL_DIR = path.join('results', 'spool');

function spoolDir() {
    return process.env.SPOOL_DIR || DEFAULT_SPOOL_DIR;
}

function safeSegment(value) {
    return String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/**
 * Persist an undeliverable submitJobs payload to the spool directory and
 * log at ERROR with a distinct `scraper_alert` so it surfaces on
 * dashboards/alerts rather than only in a local file.
 *
 * @param {object} payload
 * @param {string} payload.sessionId
 * @param {string} payload.platform
 * @param {Array}  payload.jobs
 * @param {string} payload.status
 * @param {string|null} [payload.errorMessage]
 * @param {string} payload.deliveryError - message from the failed HTTP call
 * @returns {Promise<string|null>} the spool file path, or null if the
 *   write itself failed (best-effort — never throws into the caller).
 */
export async function spoolUndeliverableSubmission(payload) {
    const dir = spoolDir();
    const filename = `${Date.now()}_${safeSegment(payload.sessionId)}_${safeSegment(payload.platform)}.json`;
    const filePath = path.join(dir, filename);

    const record = {
        spooledAt: new Date().toISOString(),
        sessionId: payload.sessionId,
        platform: payload.platform,
        status: payload.status,
        errorMessage: payload.errorMessage ?? null,
        deliveryError: payload.deliveryError,
        jobs: payload.jobs,
    };

    try {
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
        log.error('Submit could not be delivered — spooled locally for recovery', {
            sessionId: payload.sessionId,
            platform: payload.platform,
            jobCount: Array.isArray(payload.jobs) ? payload.jobs.length : 0,
            err: payload.deliveryError,
            spoolPath: filePath,
            scraper_alert: 'submit_undeliverable',
        });
        return filePath;
    } catch (writeError) {
        // Spooling is a last-resort safety net; a disk failure here must
        // not mask the original delivery failure or crash the caller.
        // Still log loudly — this is the worst case (work genuinely lost).
        log.error('Failed to spool undeliverable submission — work is lost', {
            sessionId: payload.sessionId,
            platform: payload.platform,
            err: payload.deliveryError,
            spoolWriteErr: writeError.message,
            scraper_alert: 'submit_undeliverable_and_unspooled',
        });
        return null;
    }
}
