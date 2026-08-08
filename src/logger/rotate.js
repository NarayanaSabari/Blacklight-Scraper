// Log rotation for a process whose log files it does not own.
//
// WHY THIS IS NOT `fs.rename`
// ---------------------------
// The daemon writes to stdout/stderr; `deploy/run-scraper.cmd` redirects both
// into C:\scraper\logs\*.log with `>>`. The file handles belong to the SHELL,
// not to node, and they stay open for the entire life of the supervisor loop.
// Renaming the file out from under an open Windows handle either fails or
// leaves the shell writing into a file nobody can find, and the daemon has no
// way to reopen the shell's descriptor afterwards.
//
// So this is logrotate's `copytruncate` strategy: copy the file aside, then
// truncate the original to zero. Because both handles are in APPEND mode,
// writes after the truncate resume at the new end of file - offset 0 - with no
// sparse gap. The known cost of copytruncate applies here too: anything
// written between the copy and the truncate is lost. That window is one
// copyFile of a bounded-size file, and the alternative measured on m1 was a
// 283 MB stdout.log that Defender re-scanned on a CPU-saturated host and that
// no operator could open.
//
// Rotation is in-process and interval-driven rather than done by the launcher
// at startup, because the thing that needs rotating is a process that had been
// up for 88 hours. A rotation that only happens on restart never fires on the
// host where it matters.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './index.js';

const log = createLogger('log-rotate');

const MB = 1024 * 1024;

export const DEFAULTS = Object.freeze({
    dir: 'logs',
    files: ['stdout.log', 'stderr.log'],
    maxMb: 100,
    keep: 3,
    intervalMs: 5 * 60_000,
});

function intFrom(raw, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Read rotation settings from the environment.
 *
 * `maxMb: 0` disables rotation entirely - an operator turning it off must not
 * be quietly re-enabled by a default.
 */
export function rotateConfig(env = process.env) {
    return {
        dir: env.LOG_DIR || DEFAULTS.dir,
        files: DEFAULTS.files,
        maxMb: intFrom(env.LOG_ROTATE_MAX_MB, DEFAULTS.maxMb),
        keep: intFrom(env.LOG_ROTATE_KEEP, DEFAULTS.keep),
        intervalMs: intFrom(env.LOG_ROTATE_INTERVAL_MS, DEFAULTS.intervalMs),
    };
}

/**
 * Archive name for a rotation. Sortable, so pruning is a plain lexical sort.
 * The stamp is passed in rather than read from the clock so a test can assert
 * on the exact name.
 */
export function archiveName(file, stamp) {
    return `${file}.${stamp.replace(/[:.]/g, '-')}`;
}

/** Delete all but the newest `keep` archives of `file`. Returns names removed. */
export async function pruneArchives(dir, file, keep) {
    let entries;
    try {
        entries = await fs.readdir(dir);
    } catch {
        return [];
    }
    const archives = entries.filter((e) => e.startsWith(`${file}.`)).sort();
    const doomed = keep > 0 ? archives.slice(0, Math.max(0, archives.length - keep)) : archives;
    const removed = [];
    for (const name of doomed) {
        try {
            await fs.rm(path.join(dir, name));
            removed.push(name);
        } catch (error) {
            // A file we cannot delete is a disk-space problem, not a reason to
            // abandon the rotation that just succeeded.
            log.warn('Could not prune log archive', { name, err: error.message });
        }
    }
    return removed;
}

/**
 * Rotate one file if it exceeds the threshold. Returns a result object rather
 * than throwing: rotation is best-effort housekeeping and must never take the
 * daemon down with it.
 *
 * @returns {Promise<{file: string, rotated: boolean, sizeBytes: number, archive?: string, error?: string}>}
 */
export async function rotateFile(dir, file, { maxMb, keep, stamp }) {
    const full = path.join(dir, file);
    let sizeBytes = 0;
    try {
        ({ size: sizeBytes } = await fs.stat(full));
    } catch {
        // No log file yet is the healthy state on a fresh host.
        return { file, rotated: false, sizeBytes: 0 };
    }
    if (maxMb <= 0 || sizeBytes < maxMb * MB) {
        return { file, rotated: false, sizeBytes };
    }

    const archive = archiveName(file, stamp);
    try {
        await fs.copyFile(full, path.join(dir, archive));
        await fs.truncate(full, 0);
    } catch (error) {
        log.warn('Log rotation failed', { file, err: error.message });
        return { file, rotated: false, sizeBytes, error: error.message };
    }

    await pruneArchives(dir, file, keep);
    log.info('Rotated log', { file, archive, sizeMb: Math.round(sizeBytes / MB) });
    return { file, rotated: true, sizeBytes, archive };
}

/** Run one rotation pass over every configured file. */
export async function rotateOnce(config, stamp = new Date().toISOString()) {
    const results = [];
    for (const file of config.files) {
        results.push(await rotateFile(config.dir, file, { ...config, stamp }));
    }
    return results;
}

/**
 * Start the rotation timer. Returns a stop function; returns null when
 * rotation is disabled so the caller can tell "off" from "running".
 */
export function startLogRotation(env = process.env) {
    const config = rotateConfig(env);
    if (config.maxMb <= 0 || config.intervalMs <= 0) {
        log.info('Log rotation disabled', { maxMb: config.maxMb, intervalMs: config.intervalMs });
        return null;
    }

    const tick = () => {
        rotateOnce(config).catch((error) =>
            log.warn('Log rotation pass failed', { err: error.message }),
        );
    };

    const timer = setInterval(tick, config.intervalMs);
    // Housekeeping must never be the reason the process stays alive during a
    // shutdown that is otherwise complete.
    timer.unref?.();
    tick();

    log.info('Log rotation started', {
        dir: config.dir,
        maxMb: config.maxMb,
        keep: config.keep,
        intervalMinutes: config.intervalMs / 60_000,
    });
    return () => clearInterval(timer);
}
