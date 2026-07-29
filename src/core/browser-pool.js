// Drop-in replacement for cloakbrowser's `launch` / `launchPersistentContext`
// that takes a session seat first (see ./license-pool.js for why).
//
// Every scraper imports its launcher from here instead of from 'cloakbrowser',
// so each launch automatically leases a licence key, and the seat is held for
// exactly as long as the browser lives. That turns the orchestrator's parallel
// platform scraping from "N browsers launch, N-1 get killed" into "N browsers
// run when N keys are configured, and queue politely when they aren't".

import * as cloakbrowser from 'cloakbrowser';
import { getLicensePool } from './license-pool.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('browser-pool');

let _launcher = cloakbrowser;
// Test seam: swap in a fake launcher so tests never start a real browser.
export function __setLauncherForTest(launcher) { _launcher = launcher ?? cloakbrowser; }

// Release the seat when the browser/context closes — whatever else happens.
// Wrapping close() keeps every existing call site unchanged; they already close
// what they open, so the seat follows the object's own lifetime.
function releaseOnClose(target, lease) {
    if (!target || typeof target.close !== 'function') {
        // Nothing to hang the release on; free the seat now rather than leak it.
        lease.release();
        return target;
    }
    const close = target.close.bind(target);
    target.close = async (...args) => {
        try {
            return await close(...args);
        } finally {
            lease.release();   // idempotent, so a second close() is harmless
        }
    };
    return target;
}

async function withSeat(name, run) {
    const pool = getLicensePool();
    const before = pool.stats();
    if (before.inUse >= before.seats) {
        log.info(`${name}: all CloakBrowser seats busy, waiting`, before);
    }
    const lease = await pool.acquire();
    let target;
    try {
        target = await run(lease.key);
    } catch (e) {
        lease.release();       // a failed launch must not hold a seat hostage
        throw e;
    }
    return releaseOnClose(target, lease);
}

// `licenseKey` is only set when the lease actually carries one — passing an
// explicit null would override cloakbrowser's own env/file resolution.
const withKey = (options, key) => (key ? { ...options, licenseKey: key } : { ...options });

export function launch(options = {}) {
    return withSeat('launch', (key) => _launcher.launch(withKey(options, key)));
}

export function launchPersistentContext(options = {}) {
    return withSeat('launchPersistentContext', (key) => _launcher.launchPersistentContext(withKey(options, key)));
}
