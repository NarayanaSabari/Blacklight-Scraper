// CloakBrowser concurrent-session seats, one per licence key.
//
// CloakBrowser enforces its session limit PER LICENCE KEY, globally — not per
// process. Verified 2026-07-28: launching 2 browsers on one key leaves 1 alive
// and kills the other with "Target page, context or browser has been closed";
// 3 leaves 1. Two separate OS processes collide the same way, so process
// isolation is no escape. cloakbrowser's own error 76 says it plainly: "session
// limit reached for your plan."
//
// That matters because the orchestrator scrapes every platform of a role in
// parallel (src/queue/orchestrator.js), so a host whose allowlist holds four
// browser platforms was launching four browsers and losing three of them on
// every assignment.
//
// Passing a DIFFERENT `licenseKey` per launch gives each browser its own seat
// (verified: 2 keys → 2 concurrent browsers, both fine). This pool hands out
// those keys as leases, one at a time, and queues callers when every seat is
// taken — so parallel scraping is bounded instead of self-destructive.
//
// Config (keys NEVER committed): a git-ignored `config/cloakbrowser-keys.txt`,
// one key per line, or env CLOAKBROWSER_LICENSE_KEYS (comma/newline separated).
// No config → ONE seat carrying a null key, which lets cloakbrowser fall back to
// its own env/file resolution while still serialising launches.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../logger/index.js';

const log = createLogger('license-pool');

const DEFAULT_FILE = 'config/cloakbrowser-keys.txt';
const DEFAULT_LOCK_RETRY_MS = 250;
const DEFAULT_LOCK_DIR = '.blacklight-cloakbrowser-seats';
const DEFAULT_INCOMPLETE_LOCK_GRACE_MS = 5_000;
const MAX_CLEANUP_RETRY_MS = 5_000;
const MAX_CLEANUP_ATTEMPTS = 6;

// ─── Seat-leak backstop (2026-08-03 incident) ───────────────────────────────
// Both seats sat leased for ~26 hours while `waiting` climbed to 576, which
// starved every browser platform (dice/techfetch/linkedin/glassdoor/monster).
// Indeed kept working only because it uses the HTTP API and never takes a seat.
//
// The leak is NOT a missing release path — dice/techfetch close their browser
// in a `finally`. It is that the orchestrator ABANDONS a scrape after its own
// ~10 min timeout while the underlying promise keeps running: nothing cancels
// it, so the `finally` is never reached and the seat is held forever. A
// `browser.close()` that HANGS does the same thing (the try/catch around it
// catches errors, not hangs).
//
// So the backstop cannot live in the callers. A seat held longer than any
// healthy scrape (measured: dice 32-81s, techfetch ~108s) is reclaimed here.
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;      // 5 min ≫ slowest healthy scrape
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
// Starvation signal: the deadlock's exact shape was "every seat busy AND
// callers queued", sustained. Nothing alerted on it for a day.
const DEFAULT_STARVATION_MS = 10 * 60_000;

function positiveIntFromEnv(env, name, fallback) {
    const raw = env?.[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number.parseInt(String(raw), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function lockDirectory(env = process.env) {
    const configured = env?.CLOAKBROWSER_LICENSE_LOCK_DIR;
    return configured && String(configured).trim()
        ? String(configured)
        : path.join(os.homedir(), DEFAULT_LOCK_DIR);
}

function lockName(key) {
    const value = key === null ? 'implicit-seat' : String(key);
    return crypto.createHash('sha256').update(value).digest('hex');
}

function retryMs(env) {
    const raw = env?.CLOAKBROWSER_LICENSE_LOCK_RETRY_MS;
    if (raw === undefined || raw === null || raw === '') return DEFAULT_LOCK_RETRY_MS;
    const value = Number.parseInt(String(raw), 10);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_LOCK_RETRY_MS;
}

function incompleteLockGraceMs(env) {
    const rawMs = env?.CLOAKBROWSER_LICENSE_LOCK_INCOMPLETE_GRACE_MS;
    if (rawMs !== undefined && rawMs !== null && rawMs !== '') {
        const value = Number.parseInt(String(rawMs), 10);
        if (Number.isFinite(value) && value > 0) return value;
    }
    const rawSeconds = env?.CLOAKBROWSER_LICENSE_LOCK_INCOMPLETE_GRACE_SEC;
    if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== '') {
        const value = Number.parseInt(String(rawSeconds), 10);
        if (Number.isFinite(value) && value > 0) return value * 1000;
    }
    return DEFAULT_INCOMPLETE_LOCK_GRACE_MS;
}

function parsePid(raw) {
    const value = String(raw ?? '');
    if (!/^[1-9]\d*\n$/.test(value)) return null;
    const pid = Number(value.slice(0, -1));
    return Number.isSafeInteger(pid) ? pid : null;
}

// One key per line; blanks and `#` comments ignored.
export function parseKeyLine(line) {
    const s = String(line ?? '').trim();
    if (!s || s.startsWith('#')) return null;
    return s;
}

export function loadLicenseKeys(env = process.env, deps = {}) {
    const readFileSync = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'));
    const existsSync = deps.existsSync ?? ((p) => fs.existsSync(p));
    let raw = '';
    if (env.CLOAKBROWSER_LICENSE_KEYS && String(env.CLOAKBROWSER_LICENSE_KEYS).trim()) {
        raw = String(env.CLOAKBROWSER_LICENSE_KEYS).replace(/,/g, '\n');
    } else {
        const file = env.CLOAKBROWSER_LICENSE_KEYS_FILE || DEFAULT_FILE;
        if (existsSync(file)) {
            try { raw = readFileSync(file); } catch { raw = ''; }
        }
    }
    const seen = new Set();
    const out = [];
    for (const key of raw.split('\n').map(parseKeyLine)) {
        if (key && !seen.has(key)) { seen.add(key); out.push(key); }
    }
    return out;
}

export class LicensePool {
    constructor(keys = [], options = {}) {
        // No keys configured still means ONE seat: cloakbrowser resolves the key
        // itself from env or ~/.cloakbrowser/license.key, and serialising on a
        // single seat is what stops concurrent launches killing each other.
        this._fs = options.fs ?? fs;
        this._process = options.process ?? process;
        this._pid = options.pid ?? this._process.pid ?? process.pid;
        this._env = options.env ?? process.env;
        const lockDir = options.lockDir ?? lockDirectory(this._env);
        this._seats = (keys.length ? keys : [null]).map((key) => ({
            key,
            busy: false,
            lockPath: path.join(lockDir, `${lockName(key)}.lock`),
            lockHeld: false,
            cleanupTimer: null,
            cleanupAttempt: 0,
            cleanupWarned: false,
            // Fencing token. Incremented on every reclaim so a late release
            // from a timed-out holder cannot free the seat its successor now
            // owns — without this the TTL backstop would cause double-frees,
            // which is worse than the leak it fixes.
            epoch: 0,
            leasedAt: null,
            leaseLabel: null,
        }));
        this._now = options.now ?? (() => Date.now());
        this._leaseTtlMs = options.leaseTtlMs
            ?? positiveIntFromEnv(this._env, 'CLOAKBROWSER_LEASE_TTL_MS', DEFAULT_LEASE_TTL_MS);
        this._sweepIntervalMs = options.sweepIntervalMs
            ?? positiveIntFromEnv(this._env, 'CLOAKBROWSER_LEASE_SWEEP_MS', DEFAULT_SWEEP_INTERVAL_MS);
        this._starvationMs = options.starvationMs
            ?? positiveIntFromEnv(this._env, 'CLOAKBROWSER_STARVATION_MS', DEFAULT_STARVATION_MS);
        this._starvingSince = null;
        this._starvationWarned = false;
        this._reclaimed = 0;
        this._sweepTimer = null;
        if (options.autoSweep !== false) this._startSweep();
        this._waiters = [];
        this._locking = options.locking ?? true;
        this._lockDir = lockDir;
        this._lockDirReady = false;
        this._lockRetryMs = retryMs(this._env);
        this._incompleteLockGraceMs = incompleteLockGraceMs(this._env);
        this._retryTimer = null;
        this._draining = false;
        this._lockError = null;
        this._lockWarningLogged = false;
    }

    get size() { return this._seats.length; }

    acquire(label = null) {
        if (this._lockError) return Promise.reject(this._lockError);
        return new Promise((resolve, reject) => {
            this._waiters.push({ resolve, reject, label });
            this._drain();
        });
    }

    _canFallback() {
        return this._seats.length === 1 && this._seats[0].key === null;
    }

    _disableLocking(error) {
        this._locking = false;
        if (!this._lockWarningLogged) {
            this._lockWarningLogged = true;
            log.warn('CloakBrowser seat lock unavailable; using in-process-only fallback', {
                reason: error?.code || error?.name || 'unknown',
            });
        }
    }

    _ensureLockDir() {
        if (!this._locking || this._lockDirReady) return;
        try {
            this._fs.mkdirSync(this._lockDir, { recursive: true, mode: 0o700 });
            this._lockDirReady = true;
        } catch (error) {
            if (this._canFallback()) {
                this._disableLocking(error);
                return;
            }
            throw error;
        }
    }

    _isAlive(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            this._process.kill(pid, 0);
            return true;
        } catch (error) {
            return error?.code === 'EPERM';
        }
    }

    _removeLock(seat) {
        try { this._fs.unlinkSync(seat.lockPath); }
        catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }

    _incompleteLockExpired(seat) {
        try {
            const stat = this._fs.statSync(seat.lockPath);
            return Date.now() - stat.mtimeMs >= this._incompleteLockGraceMs;
        } catch {
            return false;
        }
    }

    _tryLock(seat) {
        if (!this._locking) return true;
        this._ensureLockDir();
        if (!this._locking) return true;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            let fd;
            try {
                fd = this._fs.openSync(seat.lockPath, 'wx', 0o600);
                this._fs.writeSync(fd, `${this._pid}\n`);
                this._fs.fsyncSync(fd);
                this._fs.closeSync(fd);
                fd = undefined;
                seat.lockHeld = true;
                return true;
            } catch (error) {
                if (fd !== undefined) {
                    try { this._fs.closeSync(fd); } catch {}
                    try { this._removeLock(seat); } catch (cleanupError) {
                        if (this._canFallback()) {
                            this._disableLocking(cleanupError);
                            return true;
                        }
                        throw cleanupError;
                    }
                }
                if (error?.code !== 'EEXIST') {
                    if (this._canFallback()) {
                        this._disableLocking(error);
                        return true;
                    }
                    throw error;
                }

                let ownerPid;
                try {
                    ownerPid = parsePid(this._fs.readFileSync(seat.lockPath, 'utf8'));
                } catch (readError) {
                    if (readError?.code === 'ENOENT') continue;
                    if (this._canFallback()) {
                        this._disableLocking(readError);
                        return true;
                    }
                    throw readError;
                }
                if (ownerPid !== null && this._isAlive(ownerPid)) return false;
                if (ownerPid === null && !this._incompleteLockExpired(seat)) return false;
                try { this._removeLock(seat); }
                catch (removeError) {
                    if (removeError?.code === 'ENOENT') continue;
                    if (this._canFallback()) {
                        this._disableLocking(removeError);
                        return true;
                    }
                    throw removeError;
                }
            }
        }
        return false;
    }

    _scheduleRetry() {
        if (this._retryTimer || !this._waiters.length) return;
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._drain();
        }, this._lockRetryMs);
    }

    _drain() {
        if (this._draining) return;
        this._draining = true;
        try {
            for (const seat of this._seats) {
                if (!this._waiters.length) break;
                if (seat.busy) continue;
                seat.busy = true;
                let locked;
                try { locked = this._tryLock(seat); }
                catch (error) {
                    seat.busy = false;
                    this._lockError = error;
                    for (const waiter of this._waiters.splice(0)) waiter.reject(error);
                    break;
                }
                if (!locked) {
                    seat.busy = false;
                    continue;
                }
                const waiter = this._waiters.shift();
                waiter.resolve(this._lease(seat, waiter.label));
            }
            if (this._waiters.length && this._seats.some((seat) => !seat.busy)) this._scheduleRetry();
        } finally {
            this._draining = false;
        }
    }

    _lease(seat, label = null) {
        let released = false;
        const epoch = seat.epoch;      // fencing token, see seat.epoch
        const now = this._now;
        seat.leasedAt = now();
        seat.leaseLabel = label;
        return {
            key: seat.key,
            get age() { return seat.epoch === epoch && seat.leasedAt !== null ? now() - seat.leasedAt : 0; },
            release: () => {
                if (released) return;   // idempotent: a double release must not free a seat twice
                released = true;
                // The seat may have been force-reclaimed and re-leased while
                // this holder was hung. Releasing then would free somebody
                // else's seat.
                if (seat.epoch !== epoch) {
                    log.warn('Late release from a reclaimed CloakBrowser seat — ignored', {
                        key: seat.key ? `${String(seat.key).slice(0, 12)}…` : null,
                        leaseEpoch: epoch,
                        seatEpoch: seat.epoch,
                    });
                    return;
                }
                this._releaseSeat(seat);
            },
        };
    }

    /**
     * Force-reclaim any seat leased longer than the TTL, and emit a starvation
     * alert when every seat is busy with callers queued for too long.
     *
     * Deliberately does NOT try to kill the browser that leaked the seat — we
     * cannot know it is safe to, and CloakBrowser's limit is server-side
     * anyway. Freeing the local seat lets queued work proceed; a genuinely
     * orphaned remote session ages out on its own.
     */
    sweep() {
        const now = this._now();
        for (const seat of this._seats) {
            if (!seat.busy || seat.leasedAt === null) continue;
            const heldMs = now - seat.leasedAt;
            if (heldMs < this._leaseTtlMs) continue;
            log.error('CloakBrowser seat exceeded lease TTL — force-reclaiming', {
                key: seat.key ? `${String(seat.key).slice(0, 12)}…` : null,
                heldMs,
                ttlMs: this._leaseTtlMs,
                label: seat.leaseLabel,
                scraper_alert: 'cloakbrowser_seat_reclaimed',
            });
            seat.epoch += 1;           // invalidate the hung holder's lease
            seat.leasedAt = null;
            seat.leaseLabel = null;
            this._reclaimed += 1;
            this._releaseSeat(seat);
        }
        this._checkStarvation(now);
        return this._reclaimed;
    }

    _checkStarvation(now = this._now()) {
        const { seats, inUse, waiting } = this.stats();
        const starving = waiting > 0 && inUse >= seats;
        if (!starving) {
            if (this._starvationWarned) {
                log.info('CloakBrowser seat starvation cleared', this.stats());
            }
            this._starvingSince = null;
            this._starvationWarned = false;
            return false;
        }
        if (this._starvingSince === null) this._starvingSince = now;
        const forMs = now - this._starvingSince;
        if (forMs >= this._starvationMs && !this._starvationWarned) {
            this._starvationWarned = true;
            // This is the exact signature of the 2026-08-03 outage: free == 0
            // with a climbing queue, sustained. Nothing watched for it.
            log.error('CloakBrowser seats starved — every seat busy with callers queued', {
                seats, inUse, waiting, forMs,
                scraper_alert: 'cloakbrowser_seats_starved',
            });
        }
        return this._starvationWarned;
    }

    _startSweep() {
        if (this._sweepTimer) return;
        const timer = setInterval(() => {
            try { this.sweep(); }
            catch (error) { log.warn('CloakBrowser seat sweep failed', { err: error?.message }); }
        }, this._sweepIntervalMs);
        timer.unref?.();
        this._sweepTimer = timer;
    }

    stopSweep() {
        if (!this._sweepTimer) return;
        clearInterval(this._sweepTimer);
        this._sweepTimer = null;
    }

    _releaseSeat(seat) {
        if (!seat.lockHeld) {
            this._free(seat);
            return;
        }
        try {
            this._removeLock(seat);
            seat.lockHeld = false;
            seat.cleanupAttempt = 0;
            this._free(seat);
        } catch (error) {
            this._scheduleCleanup(seat, error);
        }
    }

    _scheduleCleanup(seat, error) {
        if (!seat.cleanupWarned) {
            seat.cleanupWarned = true;
            log.warn('Failed to remove CloakBrowser seat lock; retrying', {
                reason: error?.code || error?.name || 'unknown',
            });
        }
        if (seat.cleanupTimer || seat.cleanupAttempt >= MAX_CLEANUP_ATTEMPTS) return;
        const delay = Math.min(this._lockRetryMs * (2 ** Math.min(seat.cleanupAttempt, 5)), MAX_CLEANUP_RETRY_MS);
        seat.cleanupAttempt += 1;
        const timer = setTimeout(() => {
            seat.cleanupTimer = null;
            this._releaseSeat(seat);
        }, delay);
        timer.unref?.();
        seat.cleanupTimer = timer;
    }

    _free(seat) {
        seat.busy = false;
        seat.leasedAt = null;
        seat.leaseLabel = null;
        this._drain();
    }

    stats() {
        const now = this._now();
        const held = this._seats
            .filter((s) => s.busy && s.leasedAt !== null)
            .map((s) => now - s.leasedAt);
        const inUse = this._seats.filter((s) => s.busy).length;
        return {
            seats: this._seats.length,
            inUse,
            free: this._seats.length - inUse,
            waiting: this._waiters.length,
            // Surfaced on /panel so the deadlock signature is visible without
            // reading logs: a climbing oldestLeaseMs with free === 0 is a leak.
            oldestLeaseMs: held.length ? Math.max(...held) : 0,
            reclaimed: this._reclaimed,
            starved: this._starvationWarned,
        };
    }

    // Read-only detail for the control panel. `leasedKeys` reports the key
    // string for each busy seat ('implicit' for the no-key fallback seat) —
    // never the key material itself beyond what's already in config, and
    // this process only ever holds the keys it was configured with.
    snapshot() {
        const leasedSeats = this._seats.filter((s) => s.busy);
        return {
            total: this._seats.length,
            leased: leasedSeats.length,
            free: this._seats.length - leasedSeats.length,
            waiting: this._waiters.length,
            leasedKeys: leasedSeats.map((s) => (s.key === null ? 'implicit' : s.key)),
        };
    }
}

let _singleton = null;
export function getLicensePool() {
    if (!_singleton) {
        const keys = loadLicenseKeys();
        _singleton = new LicensePool(keys);
        log.info('CloakBrowser session seats', {
            seats: _singleton.size,
            source: keys.length ? 'licence keys' : 'implicit (no keys configured)',
        });
    }
    return _singleton;
}
export function __resetLicensePoolForTest() { _singleton = null; }
