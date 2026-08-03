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

import { mkdir, readdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import { createLogger } from '../logger/index.js';

const log = createLogger('submit-spool');

const DEFAULT_SPOOL_DIR = path.join('results', 'spool');

// A file older than this is backlog, not evidence that delivery is failing NOW.
const DEFAULT_ACTIVE_WINDOW_MS = 15 * 60_000;

function spoolDir() {
    return process.env.SPOOL_DIR || DEFAULT_SPOOL_DIR;
}

/**
 * Describe the spool so an alert can tell "delivery is failing right now" from
 * "there is an old backlog nobody has drained".
 *
 * The panel reported "backend delivery is failing" purely because the
 * directory was non-empty, so on 2026-08-03 it warned continuously while
 * Indeed submissions were being accepted — the alert and reality disagreed
 * for 34 hours and the real problem (nothing drains the spool) stayed hidden.
 *
 * @param {object} [opts]
 * @param {number} [opts.activeWindowMs] treat files newer than this as live failures
 * @param {number} [opts.now] injectable clock for tests
 * @returns {Promise<{count:number, recent:number, oldest:string|null,
 *   newest:string|null, deliveryFailingNow:boolean, backlog:boolean}>}
 */
export async function spoolStats(opts = {}) {
    const dir = spoolDir();
    const activeWindowMs = opts.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
    const now = opts.now ?? Date.now();

    let names;
    try {
        names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
        // No spool directory at all is the healthy steady state.
        return { count: 0, recent: 0, oldest: null, newest: null, deliveryFailingNow: false, backlog: false };
    }

    let recent = 0;
    let oldestMs = null;
    let newestMs = null;
    for (const name of names) {
        let mtimeMs;
        try { ({ mtimeMs } = await stat(path.join(dir, name))); }
        catch { continue; }
        if (now - mtimeMs <= activeWindowMs) recent += 1;
        if (oldestMs === null || mtimeMs < oldestMs) oldestMs = mtimeMs;
        if (newestMs === null || mtimeMs > newestMs) newestMs = mtimeMs;
    }

    return {
        count: names.length,
        recent,
        oldest: oldestMs === null ? null : new Date(oldestMs).toISOString(),
        newest: newestMs === null ? null : new Date(newestMs).toISOString(),
        // Only true when something failed inside the active window.
        deliveryFailingNow: recent > 0,
        // Undrained work sitting on disk — a different problem, different fix.
        backlog: names.length > recent,
    };
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
// NOTE: `spoolSnapshot()` used to live here and returned only
// `{ count, oldest }`. It has been folded into `spoolStats()` above, which is
// a strict superset. Keeping two functions scanning the same directory was
// how the panel ended up alerting on "count > 0" — a condition that is true
// for a stale backlog nobody has drained, not just for a live outage.
