// DataDome session loader for Monster.
//
// Background — why this exists
// -----------------------------
// Monster's API sits behind DataDome (https://datadome.co). Every request
// must carry an `x-datadome-clientid` header + a valid `datadome` cookie.
// DataDome scores reputation per (clientid, cookie, IP) — once a client
// solves the in-page captcha, that triple is "cleared" and API calls go
// through cleanly (we observed `x-datadome-isbot: null`, 200 OK in 1.6s).
//
// Why this is config-driven (not browser-driven)
// ----------------------------------------------
// We tried two browser-based approaches first:
//   1. Stealth Playwright — DataDome detected the browser fingerprint and
//      held us on the captcha interstitial indefinitely.
//   2. Camoufox — bypassed DataDome on a fresh client, but its reputation
//      degraded within minutes of repeated automated sessions, making it
//      unreliable in production.
//
// The reliable path is a manually-cleared session: a human solves the
// captcha in their real browser (or via an SSH SOCKS proxy through the
// scraper's static IP, for the VM case), exports the cookies + clientid
// into `config/credentials.json`, and the scraper uses them for API calls.
//
// Refresh model
// -------------
// - We load the session once at module import + cache it for the process
//   lifetime. No disk read per scrape.
// - We watch `config/credentials.json` for changes. When the operator
//   refreshes cookies (DevTools-export or via bin/refresh-monster-session),
//   the running scraper picks up the new values within seconds — no
//   restart required.
// - The session is bound to the IP that solved the captcha. Local laptop
//   sessions don't translate to the VM and vice versa; each environment
//   needs its own credentials.json.
//
// Trade-offs
// ----------
// - Cookie expires (DataDome cookies typically live ~hours to ~24h). When
//   the API starts returning 403, monster.js falls back mid-scrape to the
//   legacy hardcoded-clientid path so the scrape doesn't fail outright;
//   the operator should re-export cookies promptly to restore 100% mode.

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger/index.js';

const log = createLogger('datadome');

const CREDENTIALS_PATH = path.join(process.cwd(), 'config', 'credentials.json');

// In-memory cache. `null` means "loaded from disk and confirmed absent",
// distinct from `undefined` which means "not yet loaded".
let cachedSession = undefined;

function buildSessionFromConfig(monster) {
    if (!monster || !monster.cookies || !monster.datadomeClientId) return null;
    const cookieHeader = Object.entries(monster.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    return {
        headers: {
            accept: 'application/json',
            'accept-language': monster.acceptLanguage || 'en-US,en;q=0.9',
            'content-type': 'application/json; charset=UTF-8',
            origin: 'https://www.monster.com',
            priority: 'u=1, i',
            referer: 'https://www.monster.com/',
            'sec-ch-ua': monster.secChUa,
            'sec-ch-ua-mobile': monster.secChUaMobile,
            'sec-ch-ua-platform': monster.secChUaPlatform,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'cross-site',
            'user-agent': monster.userAgent,
            'x-datadome-clientid': monster.datadomeClientId,
            cookie: cookieHeader,
        },
        clientIdPreview: monster.datadomeClientId.slice(0, 16) + '…',
        cookieCount: Object.keys(monster.cookies).length,
        loadedAt: Date.now(),
    };
}

function reloadFromDisk() {
    try {
        const json = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
        const next = buildSessionFromConfig(json?.monster);
        const prev = cachedSession;
        cachedSession = next;

        if (next && (!prev || prev.clientIdPreview !== next.clientIdPreview)) {
            log.info('Loaded manual Monster DataDome session', {
                clientId: next.clientIdPreview,
                cookieCount: next.cookieCount,
            });
        } else if (!next && prev) {
            log.warn('Monster session cleared from credentials.json — falling back to legacy path');
        }
        return next;
    } catch (err) {
        // ENOENT is normal in environments without a credentials file —
        // monster.js will fall back to legacy without complaining. Other
        // errors (parse, permissions) deserve a warning.
        if (err.code !== 'ENOENT') {
            log.warn('Could not load credentials.json for Monster session', { err: err.message });
        }
        cachedSession = null;
        return null;
    }
}

// fs.watch is fine for our needs — credentials.json is small and only
// changes when an operator refreshes cookies. We coalesce burst events
// (editors often emit 2-3 events per save) by debouncing for 250ms.
let watcher = null;
let debounceTimer = null;
function startWatcher() {
    if (watcher) return;
    try {
        watcher = fs.watch(CREDENTIALS_PATH, { persistent: false }, (eventType) => {
            if (eventType !== 'change') return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                log.info('credentials.json changed — reloading Monster session');
                reloadFromDisk();
            }, 250);
        });
        watcher.on('error', (err) => {
            log.warn('credentials watcher error (giving up on hot-reload)', {
                err: err.message,
            });
        });
    } catch (err) {
        // Common when the file doesn't exist yet — the scraper still works,
        // just without hot-reload. Operator can restart to pick up changes.
        if (err.code !== 'ENOENT') {
            log.warn('Failed to start credentials watcher', { err: err.message });
        }
    }
}

/**
 * Load the manually-cleared Monster session, or null if not configured.
 * Cached + hot-reloaded — safe to call on every scrape.
 *
 * @returns {{ headers: Record<string,string>, clientIdPreview: string, cookieCount: number, loadedAt: number } | null}
 */
export function loadMonsterSession() {
    if (cachedSession === undefined) reloadFromDisk();
    return cachedSession;
}

// Eager bootstrap so the first scrape doesn't pay the disk read.
reloadFromDisk();
startWatcher();
