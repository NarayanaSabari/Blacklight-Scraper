// LinkedIn Scraper — CloakBrowser persistent stealth profile
//
// Auth model (persistent-session D1b, manual-login): the operator logs in
// ONCE via `npm run linkedin:login` into an on-disk CloakBrowser profile.
// scrapeLinkedIn borrows a page per role from the long-lived LinkedInSession
// (one warm context for the whole process); the logged-in session lives in
// the profile and rotates organically — no per-run cookie injection. A
// credential is still leased as a slot/lock + email/password re-login
// fallback (performLogin). Earlier models — CDP-attach to a manual Chrome,
// then CloakBrowser + per-run API-cookie injection — are both superseded.
// (`launchWithCookies`/`loadCookies` remain for the optional cookie-seed path
//  but are unused on the persistent-profile scrape path.)
//
// Scroll behaviour: LinkedIn A/B tests two DOMs. LEGACY scrolls at the
// window level; NEW puts the feed inside a scrollable <main> and the
// document scrollHeight stays pinned. We scroll the inner <main> when
// it's the actual scroll root, else fall back to window scroll.

import os from 'os';
import path from 'path';
import { launch, launchPersistentContext } from 'cloakbrowser';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { parseProxyLine } from '../src/core/proxy-pool.js';
import { getCredentialsAPIClient } from '../src/api/credentials.js';
import { getLinkedInSession } from '../src/scrapers/linkedin-session.js';
import { getMetrics } from '../src/metrics/registry.js';
import { assertNotBlocked } from '../src/core/block-detection.js';
import { DomChangedError, BlockedError, AuthError, NetworkError } from '../src/core/errors.js';
import * as linkedinCooldown from '../src/core/linkedin-cooldown.js';

// Flag-gated hardening (audit L1/L2/D1). OFF (default/shipped) = byte-
// identical to today's LinkedIn scraper (empirically: 100 posts/~193s
// with valid cookies). SCRAPER_STRICT_EMPTY=true per-host activates:
// a block/checkpoint throws (→ cooldown + 'blocked'/'dom_changed'
// metric) instead of a silent successful 0-post scrape.
const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true';
// A logged-out COOKIE credential is recoverable, not a permanent burn:
// bench-and-rotate so out-of-band / another session's write-back can
// revive it. (Was a permanent 0-min burn after a CONFIG.email crash.)
const COOKIES_EXPIRED_COOLDOWN_MIN = 60;

const log = createLogger('linkedin');
const logProgress = (_scope, msg) => log.info(msg);

// Phase 3b — Task B: local↔pool cooldown reconciliation. Pure decision for
// what a SINGLE account's AuthError (cookies expired / auth-wall) should do to
// the PLATFORM-WIDE local cooldown marker:
//  • LOCAL mode (isLocal === true — the live single-account box): write the
//    marker. This is PR #310 storm-protection: with one account there is no
//    other account to rotate to, so a dead session must pause the platform or
//    the orchestrator fires dozens of concurrent instant-fail scrapes.
//  • REMOTE mode (isLocal === false): do NOT write the platform marker. The
//    pool cools just this ACCOUNT (lease.reportFailure) so the next lease
//    rotates to a healthy account. The platform-wide marker is reserved for
//    pool-exhausted (204) / pool-unreachable (Task A) — i.e. genuinely no
//    account left to rotate to.
// Fail-safe: anything other than a positive remote signal (isLocal !== false)
// keeps the live local behavior so storm-protection is never silently dropped.
export function authFailCooldownPlan({ isLocal } = {}) {
    return { writePlatformMarker: isLocal !== false };
}

// Anti-bot pacing knobs (env-tunable, read once at module load). Mirrors
// env.js::toInt discipline — absent/garbage → default; never throws.
export function readPacingConfig(env = process.env) {
    const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
    return {
        maxScrolls: int(env.LINKEDIN_MAX_SCROLLS, 60),
        noProgressStop: int(env.LINKEDIN_NOPROGRESS_STOP, 4),
        scrollPacing: {
            min: int(env.LINKEDIN_SCROLL_MIN_MS, 2500),
            max: int(env.LINKEDIN_SCROLL_MAX_MS, 5000),
            pauseEvery: int(env.LINKEDIN_SCROLL_PAUSE_EVERY, 6),
            pauseMin: int(env.LINKEDIN_SCROLL_PAUSE_MIN_MS, 8000),
            pauseMax: int(env.LINKEDIN_SCROLL_PAUSE_MAX_MS, 15000),
        },
    };
}

// Anti-bot: choose exactly ONE query variant per browser session.
// Uniformly random so repeated orchestrator cycles cover all variants
// and the query pattern is less predictable. Pure (rng injectable).
export function pickSessionQuery(queries, rng = Math.random) {
    if (!Array.isArray(queries) || queries.length === 0) return null;
    const i = Math.min(queries.length - 1, Math.max(0, Math.floor(rng() * queries.length)));
    return queries[i];
}

// Human-like scroll pacing: a jittered base delay, plus a longer
// "reading pause" every `pauseEvery` scrolls. Pure (rng injectable).
export function nextScrollDelay(scrollIndex, rng, cfg) {
    const r = typeof rng === 'function' ? rng : Math.random;
    const { min, max, pauseEvery, pauseMin, pauseMax } = cfg;
    if (scrollIndex > 0 && pauseEvery > 0 && scrollIndex % pauseEvery === 0) {
        return Math.round(pauseMin + r() * (pauseMax - pauseMin));
    }
    return Math.round(min + r() * (max - min));
}

export function hasLiAt(jar) {
    return Array.isArray(jar) && jar.some(
        c => c && c.name === 'li_at' && typeof c.value === 'string' && c.value.length > 0
    );
}

// Pull the numeric activity id out of any blob containing
// `urn:li:activity:<digits>` (a post element's markup, a data-urn attr, a
// link). Returns '' when absent. Mirrors the in-page extractor regex so the
// contract is unit-tested.
export function extractActivityId(text) {
    const m = String(text ?? '').match(/urn:li:activity:(\d+)/);
    return m ? m[1] : '';
}

// Canonical LinkedIn post permalink from an activity id. '' for anything
// that isn't all digits (so a bad id never yields a broken URL).
export function activityPermalink(activityId) {
    return /^\d+$/.test(String(activityId ?? ''))
        ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
        : '';
}

// The job "source" URL must be the POST permalink — NEVER the author's
// `/in/` profile link (it looks like the posting *is* that person's page).
// Empty is better than wrong. Returns '' for blank or profile URLs.
export function postSourceUrl(postUrl) {
    const u = String(postUrl ?? '').trim();
    if (!u || u.includes('/in/')) return '';
    return u;
}

// Decode the post's activity id from the "Report post" link that LinkedIn
// renders inside the "···" control menu — its href carries
// `updateUrn=urn:li:activity:<id>` (URL-encoded). This is the post's OWN urn
// (not a comment/reaction), so it's a deterministic source for the permalink.
// '' when the href has no updateUrn.
export function activityIdFromMenuHref(href) {
    const m = decodeURIComponent(String(href ?? '')).match(/updateUrn=urn:li:activity:(\d+)/);
    return m ? m[1] : '';
}

// Configuration
export const CONFIG = {
    searchQuery: '',   // Will be built as a boolean query dynamically
    jobTitle: '',      // Will be set dynamically
    maxPosts: 100,
    scrollDelay: 2000,
    // LinkedIn credentials (fetched from API)
    email: null,
    password: null,
    credentialId: null,
    // Use search instead of feed for better job targeting
    useFeedInsteadOfSearch: false,  // Set to true to use feed (has URLs but less relevant)
    ...readPacingConfig(),
};

// Cookie-export tools emit `expirationDate` as either Unix seconds
// (number) or ISO 8601 (string). Math.floor on the string yields NaN
// which Playwright/CloakBrowser rejects.
function parseExpiry(raw) {
    if (raw === null || raw === undefined || raw === '') return undefined;
    if (typeof raw === 'number' && isFinite(raw)) return Math.floor(raw);
    if (typeof raw === 'string') {
        const asNum = Number(raw);
        if (isFinite(asNum) && asNum > 0) return Math.floor(asNum);
        const ms = Date.parse(raw);
        if (!isNaN(ms)) return Math.floor(ms / 1000);
    }
    return undefined;
}

function loadCookies(credential) {
    const raw = Array.isArray(credential.credentials)
        ? credential.credentials
        : Array.isArray(credential.cookies)
            ? credential.cookies
            : [];
    return raw.map(c => {
        const out = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            // Playwright only accepts Strict|Lax|None. 'unspecified' (and
            // any other value) MUST fall back to 'Lax' — passing the raw
            // string through made addCookies reject it, silently dropping
            // ~40% of the cookie jar (live: 14/24 injected). Safe-by-default.
            sameSite: c.sameSite === 'no_restriction' ? 'None'
                : c.sameSite === 'strict' ? 'Strict'
                : c.sameSite === 'lax' ? 'Lax'
                : 'Lax',
        };
        const exp = parseExpiry(c.expirationDate);
        if (exp !== undefined) out.expires = exp;
        return out;
    });
}

// Launch CloakBrowser and create a context with the credential's
// cookies pre-injected. Per-cookie retry on bulk-add failure so one
// malformed entry doesn't break the whole batch.
export async function launchWithCookies(credential) {
    logProgress('LinkedIn', '🚀 Launching CloakBrowser stealth Chromium...');
    // Headed by default per operator requirement. LINKEDIN_HEADLESS=true
    // is an escape hatch for environments with no display (CI/servers).
    const browser = await launch({ headless: process.env.LINKEDIN_HEADLESS === 'true', humanize: true });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    const cookies = loadCookies(credential);
    let added = 0;
    if (cookies.length) {
        try {
            await context.addCookies(cookies);
            added = cookies.length;
        } catch (bulkErr) {
            logProgress('LinkedIn',
                `Bulk addCookies failed (${bulkErr.message}); falling back per-cookie`);
            for (const c of cookies) {
                try { await context.addCookies([c]); added++; } catch { /* skip bad */ }
            }
        }
    }
    logProgress('LinkedIn', `✅ CloakBrowser ready (${added}/${cookies.length} cookies injected)`);
    return { browser, context };
}

// On-disk persistent stealth profile directory. The operator logs in ONCE
// via `npm run linkedin:login`; the session (cookies, localStorage) lives
// here and rotates organically across runs — no per-run cookie injection.
export function linkedInProfileDir() {
    return process.env.LINKEDIN_PROFILE_DIR
        || path.join(os.homedir(), '.blacklight-linkedin-profile');
}

// Resolve the on-disk persistent-profile directory for a given account.
// Pure + deterministic. A falsy profileKey (null/undefined/'') → the legacy
// single fixed dir (byte-identical to the pre-rotation behavior). A truthy
// profileKey → a sibling per-account dir derived from the base
// (`<base>-<sanitized key>`). The key is sanitized so it can never inject a
// path separator or `..` traversal into the resolved path.
export function profileDirFor(profileKey) {
    const base = linkedInProfileDir();
    if (!profileKey) return base;
    const safe = String(profileKey).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '__');
    return `${base}-${safe}`;
}

// Deterministic CloakBrowser fingerprint seed per account. Same profile_key
// always maps to the same synthetic device, so the one-time login and every
// scrape present an IDENTICAL device to LinkedIn (CloakBrowser otherwise
// randomizes --fingerprint per launch — see config.js:184).
export function fingerprintSeedFor(profileKey) {
    const s = String(profileKey ?? 'default');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 10000 + (h % 90000);
}

// Launch the persistent stealth profile. Returns a Playwright BrowserContext
// directly (cloakbrowser.launchPersistentContext has no separate Browser
// handle — close the context to tear down).
//
// Default (no args / legacy local accounts): launches the single fixed
// `linkedInProfileDir()` with NO proxy — byte-identical to the manual-login
// D1b model. No cookie injection: the profile already holds the operator's
// logged-in session.
//
// Per-account (rotation, future A3 accounts): pass `{ profileKey, proxy }`.
// `profileKey` selects the per-account dir (profileDirFor); a truthy `proxy`
// (a URL string from the lease) is threaded into cloakbrowser as the
// `{ server }` proxy option so all traffic routes through the account's static
// proxy. The launcher is injectable (last arg) for unit tests so the option
// wiring is verifiable without a real browser.
export async function launchPersistentProfile({ profileKey = null, proxy = null } = {}, launcher = launchPersistentContext) {
    const userDataDir = profileDirFor(profileKey);
    logProgress('LinkedIn', `🚀 Launching CloakBrowser persistent profile (${userDataDir})...`);
    const opts = {
        userDataDir,
        headless: process.env.LINKEDIN_HEADLESS === 'true',
        humanize: true,
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    };
    // Pin a STABLE per-account device. Without this CloakBrowser randomizes the
    // fingerprint each launch (config.js:184) → LinkedIn sees a new device at
    // login and challenges. buildArgs dedups by flag key (defaults < user args),
    // so these override the random default. Legacy (no profileKey) left as-is.
    if (profileKey) {
        opts.args = [
            ...(opts.args ?? []),
            `--fingerprint=${fingerprintSeedFor(profileKey)}`,
            '--fingerprint-platform=windows',
        ];
    }
    // Only attach a proxy when one is actually present — absent proxy MUST
    // leave the launch options identical to the legacy path. Pool proxies are
    // stored as "host:port:user:pass"; parseProxyLine turns that into
    // Playwright's { server: "http://host:port", username, password }. A raw
    // colon string passed straight as { server } is an Invalid URL to the
    // browser. URL-form proxies (scheme://…) parse to null → pass through.
    if (proxy) {
        const rec = parseProxyLine(proxy);
        if (rec) {
            opts.proxy = { server: rec.server };
            if (rec.username) opts.proxy.username = rec.username;
            if (rec.password) opts.proxy.password = rec.password;
        } else {
            opts.proxy = { server: proxy };
        }
    }
    const context = await launcher(opts);
    logProgress('LinkedIn', '✅ CloakBrowser persistent profile ready');
    return context;
}

// Resolve a post's permalink by opening its "···" control menu and reading the
// activity id from the Report-post link (`updateUrn=urn:li:activity:<id>`). The
// activity URN isn't in the rendered DOM, so this per-post interaction is the
// reliable source. Best-effort: returns '' (→ empty url, never wrong) if the
// element/menu/link isn't found. Always closes the menu (Escape).
export async function resolvePostUrlViaMenu(page, hash) {
    if (!hash) return '';
    try {
        const el = await page.$(`main div[componentkey*="${hash}"]`);
        if (!el) return '';
        const btn = await el.$('button[aria-label^="Open control menu for post by"]');
        if (!btn) return '';
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click();
        let href = '';
        for (let i = 0; i < 12 && !href; i++) {
            href = await page.evaluate(() =>
                document.querySelector('a[href*="report-in-modal"][href*="updateUrn"]')?.getAttribute('href') || '');
            if (!href) await new Promise(r => setTimeout(r, 150));
        }
        await page.keyboard.press('Escape').catch(() => {});
        return activityIdFromMenuHref(href);
    } catch { return ''; }
}

/**
 * Build a LinkedIn boolean search query.
 * 
 * LinkedIn content search supports: "exact phrase", AND, OR, NOT, parentheses.
 * 
 * Examples:
 *   jobTitle="DevOps Engineer"
 *   => "DevOps Engineer" AND (c2c OR W2 OR 1099)
 * 
 *   jobTitle="Product Owner"
 *   => "Product Owner" AND (c2c OR W2 OR 1099)
 * 
 *   jobTitle="SRE"
 *   => "SRE" AND (c2c OR W2 OR 1099)
 * 
 * @param {string} jobTitle - The job title/role to search for
 * @returns {string} LinkedIn boolean search query string
 */
export function buildBooleanSearchQuery(jobTitle) {
    const titlePart = `"${jobTitle}"`;

    // Pattern: "Job Title" AND (c2c OR W2 OR 1099)
    return `${titlePart} AND (c2c OR W2 OR 1099)`;
}

// Helper: Wait function
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Random delay
const randomDelay = (min, max) => wait(min + Math.random() * (max - min));

// (CDP helpers — isChromeRunning, startChromeWithDebugging,
// connectToChrome — removed when this scraper moved to CloakBrowser.
// See launchWithCookies() above.)

// Pure page-state classifier — distinguishes a real results page from a
// genuine empty search vs an auth-wall / challenge, so a block can be
// made loud instead of silently reported as a successful 0-post scrape.
// Uses the LIVE May-2026 componentkey signal (the old container check
// in navigateToSearch keyed off pre-2026 selectors and false-alarmed on
// every healthy run). Pure + junk-safe. Order: challenge → auth_wall →
// results → no_results → unknown.
export function linkedinPageState(html, url, title) {
    const h = typeof html === 'string' ? html : '';
    const u = typeof url === 'string' ? url : '';
    const t = typeof title === 'string' ? title : '';
    const hay = (h + ' ' + t).toLowerCase();
    if (h.includes('challenge-platform') || h.includes('cf-chl-')
        || /just a moment|attention required/i.test(t)) return 'challenge';
    if (/\/login|\/uas\/login|\/checkpoint|\/authwall|session_redirect/.test(u)) return 'auth_wall';
    if (h.includes('componentkey="expanded')
        || h.includes('feed-shared-update-v2')
        || h.includes('reusable-search__result-container')
        || h.includes('scaffold-finite-scroll')) return 'results';
    if (/no results found|try searching for|we couldn.t find|no results for/i.test(hay)) return 'no_results';
    return 'unknown';
}

// Helper: Check if a URL indicates an unauthenticated/login page
function isLoginPage(url) {
    return url.includes('/login') || 
           url.includes('/uas/login') || 
           url.includes('/checkpoint/lg/') ||
           url.includes('/authwall') ||
           url.includes('session_redirect');
}

// Helper: Check if a URL indicates an authenticated page
function isAuthenticatedPage(url) {
    return (url.includes('/feed') || 
            url.includes('/mynetwork') || 
            url.includes('/search/results') ||
            url.includes('/in/') ||
            url.includes('/jobs')) &&
           !isLoginPage(url);
}

// A cookie-only leased credential has no email/password — attempting a
// password login iterates `CONFIG.email` (undefined) → "not iterable"
// crash → permanent credential burn. This gate prevents that.
export function canPasswordLogin(cred) {
    return !!cred
        && typeof cred.email === 'string' && cred.email.length > 0
        && typeof cred.password === 'string' && cred.password.length > 0;
}

// LinkedIn cookie-auth doesn't settle instantly: navigating to /feed/ can bounce
// through a sign-in interstitial for 5–10s before the session hydrates and lands
// back on the feed. Override the wait window with LINKEDIN_AUTH_SETTLE_MS (ms).
export function authSettleTimeoutMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_AUTH_SETTLE_MS ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : 15000;
}

// Poll for the authenticated URL across the settle window instead of checking
// ONCE after a fixed delay. A still-redirecting page must NOT be misread as
// "cookies expired" — that wrongly cools a healthy cookie-only account (prod
// 2026-06-25: the 3–5s fixed check fired before LinkedIn's redirect settled).
// Returns true the instant the feed settles; false only after the full window.
export async function waitForAuthenticated(page, {
    timeoutMs = authSettleTimeoutMs(),
    pollMs = 1000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
} = {}) {
    const deadline = now() + timeoutMs;
    for (;;) {
        if (isAuthenticatedPage(page.url())) return true;
        if (now() >= deadline) return false;
        await sleep(pollMs);
    }
}

async function ensureLoggedIn(page) {
    logProgress('LinkedIn', '🔐 Verifying authentication status...');

    // Navigate to feed to reliably check login state
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Poll for the redirect to settle (up to ~15s) rather than checking once
    // after a fixed 3–5s wait — LinkedIn's cookie session can take 5–10s to
    // hydrate and bounce /feed/ → /login → back to /feed/. Checking too early
    // misreads a mid-redirect page as "cookies expired" and cools the account.
    const authed = await waitForAuthenticated(page);
    logProgress('LinkedIn', `   URL after feed navigation settled: ${page.url()}`);

    // If we landed on the feed, we're logged in
    if (authed) {
        logProgress('LinkedIn', '✅ Already logged in (verified via feed navigation)');
        return true;
    }

    // §5: a cookie-only credential cannot password-login. Fail typed &
    // recoverable instead of crashing on `for (const c of CONFIG.email)`.
    // CONFIG.{email,password} are set from the leased credential in
    // scrapeLinkedIn (~1218-1219) before navigateToSearch runs;
    // performLogin already reads the same module CONFIG.
    if (!canPasswordLogin(CONFIG)) {
        throw new AuthError(
            'LinkedIn session not authenticated and credential has no password to log in with (cookies expired/rotated)',
            { platform: 'linkedin' });
    }
    logProgress('LinkedIn', '🔑 Not logged in, performing login...');
    await performLogin(page);
    return true;
}

async function performLogin(page) {
    // §5 (defense-in-depth): a cookie-only credential cannot password-login.
    // The ensureLoggedIn call site has its own pre-check, but navigateToSearch
    // (~:469) calls performLogin directly on a US-redirect-to-login retry —
    // fail typed & recoverable here too instead of crashing on
    // `for (let char of CONFIG.email)` (line ~340) → permanent cooldown:0.
    if (!canPasswordLogin(CONFIG)) {
        throw new AuthError(
            'LinkedIn session not authenticated and credential has no password to log in with (cookies expired/rotated)',
            { platform: 'linkedin' });
    }

    const currentUrl = page.url();

    // Navigate to login page if not already there
    if (!currentUrl.includes('/login') && !currentUrl.includes('/uas/login')) {
        logProgress('LinkedIn', '📍 Navigating to login page...');
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3000);
    }

    // Check if "Sign in using another account" button exists and click it
    try {
        const anotherAccountButton = await page.$('button.signin-other-account, button.artdeco-list__item.signin-other-account, .signin-other-account');
        if (anotherAccountButton) {
            const isVisible = await anotherAccountButton.isVisible();
            if (isVisible) {
                logProgress('LinkedIn', '🔘 Clicking "Sign in using another account" button...');
                await anotherAccountButton.click();
                await randomDelay(2000, 3000);
            }
        }
    } catch (error) {
        // Button not found, continue to email field
        logProgress('LinkedIn', '   No account selection page, proceeding to email field...');
    }

    // Fill email
    logProgress('LinkedIn', `📧 Entering email: ${CONFIG.email}`);
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('#username');
    await randomDelay(300, 600);
    
    // Clear any existing text in email field
    await page.evaluate(() => {
        const emailField = document.querySelector('#username');
        if (emailField) emailField.value = '';
    });
    
    // Select all and delete as backup
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await randomDelay(200, 400);
    
    // Type new email
    for (let char of CONFIG.email) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    await randomDelay(500, 1000);
    
    // Fill password
    logProgress('LinkedIn', '🔒 Entering password...');
    await page.click('#password');
    await randomDelay(300, 600);
    
    // Clear any existing text in password field
    await page.evaluate(() => {
        const passwordField = document.querySelector('#password');
        if (passwordField) passwordField.value = '';
    });
    
    // Select all and delete as backup
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await randomDelay(200, 400);
    
    // Type new password
    for (let char of CONFIG.password) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    await randomDelay(1000, 2000);
    
    // Click sign in button
    logProgress('LinkedIn', '🖱️  Clicking Sign in button...');
    const signInButton = await page.$('button[type="submit"]');
    if (signInButton) {
        await signInButton.click();
    } else {
        await page.keyboard.press('Enter');
    }
    
    // Wait for LinkedIn to process login and redirect
    logProgress('LinkedIn', '⏳ Waiting for login to complete...');
    
    // Wait for navigation away from login page (up to 15s)
    try {
        await page.waitForURL(url => !isLoginPage(url.toString()), { timeout: 15000 });
        logProgress('LinkedIn', '   Login redirect detected');
    } catch {
        logProgress('LinkedIn', '   Login redirect wait timed out, checking page state...');
    }
    
    await randomDelay(3000, 5000);
    
    // Check the result
    const finalUrl = page.url();
    logProgress('LinkedIn', `   Current URL: ${finalUrl}`);
    
    // First check: Are we successfully logged in? (on an authenticated page)
    if (isAuthenticatedPage(finalUrl)) {
        logProgress('LinkedIn', '✅ Login successful!');
        return true;
    }
    
    // Check for explicit error messages (only if still on login-related pages)
    if (isLoginPage(finalUrl)) {
        const hasError = await page.evaluate(() => {
            const errorText = document.body.innerText.toLowerCase();
            const hasErrorMessage = errorText.includes('wrong email or password') || 
                   errorText.includes('incorrect email or password') ||
                   errorText.includes("couldn't find a linkedin account") ||
                   errorText.includes('that password is incorrect');
            
            const hasErrorElement = document.querySelector('.alert-error, .error-message, .form__error') !== null;
            
            return hasErrorMessage || hasErrorElement;
        });
        
        if (hasError) {
            logProgress('LinkedIn', '❌ Wrong credentials detected on page!');
            throw new Error('Login failed: Invalid email or password');
        }
        
        // Still on login page but no error message = credentials likely wrong
        logProgress('LinkedIn', '❌ Still on login page - credentials likely wrong');
        throw new Error('Login failed: Invalid credentials (still on login page)');
    }
    
    // Check for security challenges/verification
    if (finalUrl.includes('/challenge') || finalUrl.includes('/checkpoint/challenge')) {
        logProgress('LinkedIn', '⚠️  Security challenge/verification required');
        throw new Error('Login failed: Security challenge detected - account may need verification');
    }
    
    // If we reached here and passed all checks, assume success
    logProgress('LinkedIn', '✅ Login successful - redirected to authenticated page');
    return true;
}

export async function navigateToSearch(page, query) {
    logProgress('LinkedIn', `🔍 Boolean Search Query: ${CONFIG.searchQuery}`);
    
    // Verify login by navigating to feed (this also establishes session)
    await ensureLoggedIn(page);
    
    // Choose between feed (with URLs) or search (filtered but less reliable URLs)
    if (CONFIG.useFeedInsteadOfSearch) {
        logProgress('LinkedIn', '✅ Using main feed (posts will have URLs)');
        logProgress('LinkedIn', `🔍 Filtering: ${CONFIG.searchQuery}`);
        // Stay on feed page (ensureLoggedIn already navigated to feed)
    } else {
        // Use the boolean search query directly in the URL
        const encodedQuery = encodeURIComponent(CONFIG.searchQuery);
        // Post recency filter. Default past-24h (override via LINKEDIN_DATE_POSTED:
        // past-24h | past-week | past-month). LinkedIn expects the array form,
        // e.g. datePosted=["past-24h"] → %5B%22past-24h%22%5D.
        const datePosted = process.env.LINKEDIN_DATE_POSTED || 'past-24h';
        const datePostedParam = encodeURIComponent(`["${datePosted}"]`);
        const contentSearchUrl = `https://www.linkedin.com/search/results/content/?datePosted=${datePostedParam}&keywords=${encodedQuery}&origin=FACETED_SEARCH&sid=*To`;
        
        logProgress('LinkedIn', `🔗 Navigating to content search page...`);
        logProgress('LinkedIn', `   Query: ${CONFIG.searchQuery}`);
        logProgress('LinkedIn', `   URL: ${contentSearchUrl}`);
        
        // Navigate directly to content search results
        await page.goto(contentSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await randomDelay(4000, 6000);
        
        // Check if LinkedIn redirected us to a login page (US behavior)
        const postNavUrl = page.url();
        if (isLoginPage(postNavUrl)) {
            logProgress('LinkedIn', '⚠️  Search page redirected to login (US LinkedIn behavior)');
            logProgress('LinkedIn', '🔑 Performing login and retrying search...');
            
            // Perform login
            await performLogin(page);
            await randomDelay(2000, 3000);
            
            // Retry the search navigation
            logProgress('LinkedIn', '🔄 Retrying content search navigation...');
            await page.goto(contentSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(4000, 6000);
            
            // If still redirected to login, try using the search bar from feed
            const retryUrl = page.url();
            if (isLoginPage(retryUrl)) {
                logProgress('LinkedIn', '⚠️  Still redirected to login after re-login');
                logProgress('LinkedIn', '🔄 Trying alternative: search from feed page...');
                
                // Go to feed first
                await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await randomDelay(3000, 5000);
                
                // Use the search bar on the feed page with the boolean query
                try {
                    const searchInput = await page.$('input.search-global-typeahead__input, input[placeholder*="Search"], input[role="combobox"]');
                    if (searchInput) {
                        logProgress('LinkedIn', `   Found search bar, typing boolean query: ${CONFIG.searchQuery}`);
                        await searchInput.click();
                        await randomDelay(500, 1000);
                        await searchInput.type(CONFIG.searchQuery, { delay: 50 });
                        await randomDelay(500, 1000);
                        await page.keyboard.press('Enter');
                        await randomDelay(3000, 5000);
                        
                        // Click on "Posts" filter tab to get content results
                        try {
                            const postsTab = await page.$('button[aria-label*="Posts"], a[href*="content"], button:has-text("Posts")');
                            if (postsTab) {
                                logProgress('LinkedIn', '   Clicking "Posts" filter tab...');
                                await postsTab.click();
                                await randomDelay(3000, 5000);
                            } else {
                                // Try clicking by text content
                                await page.evaluate(() => {
                                    const buttons = [...document.querySelectorAll('button, a')];
                                    const postsBtn = buttons.find(b => b.textContent.trim() === 'Posts');
                                    if (postsBtn) postsBtn.click();
                                });
                                await randomDelay(3000, 5000);
                            }
                        } catch (tabError) {
                            logProgress('LinkedIn', `   Could not find Posts tab: ${tabError.message}`);
                        }
                    } else {
                        logProgress('LinkedIn', '   Search bar not found, staying on feed page');
                    }
                } catch (searchError) {
                    logProgress('LinkedIn', `   Search bar approach failed: ${searchError.message}`);
                    logProgress('LinkedIn', '   Falling back to feed mode...');
                }
            }
        }
    }
    
    // Verify we're on the right page
    const currentUrl = page.url();
    logProgress('LinkedIn', `📍 Current URL: ${currentUrl}`);
    
    const isFeedPage = currentUrl.includes('/feed');
    const isSearchPage = currentUrl.includes('/search/results/content/');
    
    if (isFeedPage) {
        logProgress('LinkedIn', '✅ On main feed page (posts will include URLs)');
    } else if (isSearchPage) {
        logProgress('LinkedIn', '✅ On content search results page');
        logProgress('LinkedIn', '⚠️  Post URLs not available from search (use feed mode instead)');
    } else {
        logProgress('LinkedIn', '⚠️  Unexpected page, continuing anyway...');
    }
    
    // Check what's on the page
    const pageInfo = await page.evaluate(() => {
        return {
            title: document.title,
            hasResults: document.querySelector('.search-results-container, .scaffold-finite-scroll') !== null,
            hasFeed: document.querySelector('.feed-shared-update-v2, #main') !== null,
            bodyPreview: document.body.innerText.substring(0, 300)
        };
    });
    
    logProgress('LinkedIn', `📄 Page title: ${pageInfo.title}`);
    logProgress('LinkedIn', `📊 Has results container: ${pageInfo.hasResults || pageInfo.hasFeed}`);

    if (pageInfo.bodyPreview.includes('No results') || pageInfo.bodyPreview.includes('Try searching for')) {
        logProgress('LinkedIn', '⚠️  No results found for this search query');
    }

    // If we reach here without ANY recognizable container, the browser
    // is on something we don't understand — captcha challenge, expired
    // session redirect, partial render, etc. Save a snapshot so the
    // operator can see "browser is open but I see nothing".
    if (!pageInfo.hasResults && !pageInfo.hasFeed) {
        logProgress('LinkedIn',
            '⚠️  No recognizable LinkedIn container on page — likely a redirect / challenge / login');
        await dumpDebugSnapshot(page, 'no-container');
    }

    // D1/L2: the hasResults/hasFeed check above keys off pre-May-2026
    // selectors and false-positives on every healthy run — it cannot
    // tell a real block from a good page. In STRICT mode, classify the
    // page off the LIVE signal and throw on a genuine block/auth-wall so
    // it is loud (cooldown + classified metric) instead of flowing to a
    // silent successful 0-post scrape. OFF = legacy behavior untouched.
    if (STRICT) {
        const html = await page.content().catch(() => '');
        const state = linkedinPageState(html, page.url(), pageInfo.title);
        if (state === 'challenge') {
            assertNotBlocked({ status: null, finalUrl: page.url(), title: pageInfo.title, html, platform: 'linkedin' });
        }
        if (state === 'auth_wall') {
            throw new AuthError('LinkedIn auth-wall / checkpoint after search navigation (cookies likely expired)', { platform: 'linkedin' });
        }
    }
}

// Save a screenshot + page snapshot of the current LinkedIn state to disk.
// Operator-facing diagnostic for the "browser is open but I can't see anything"
// class of issue — e.g. session expired silently, LinkedIn redirected to a
// security checkpoint, search returned a soft "no results" view, or
// the page got stuck on a loading state.
async function dumpDebugSnapshot(page, label) {
    // Hardened ordering: dump the cheap text artifact (URL/title/body
    // preview) FIRST. On hung pages, page.screenshot() can stall up to
    // 30s waiting for fonts and then time out — operator-visible mini
    // PC log showed exactly this:
    //   "could not write debug snapshot: page.screenshot: Timeout 30000ms
    //    exceeded — waiting for fonts to load"
    // The previous wrapper put both calls in one try-block, so a
    // screenshot timeout also dropped the text dump. Now they're
    // independent: text always lands, screenshot is best-effort with
    // a short timeout.
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'results');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const png = path.join(dir, `linkedin-debug-${label}-${stamp}.png`);
    const txt = path.join(dir, `linkedin-debug-${label}-${stamp}.txt`);

    // 1. Text snapshot — almost always succeeds because evaluate() only
    //    needs the JS context, not a rendered/painted frame. Adds a few
    //    structured signals so the operator can tell "blank page" from
    //    "auth wall" from "captcha" without opening the screenshot.
    let meta = null;
    try {
        meta = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            bodyPreview: (document.body?.innerText || '').slice(0, 1500),
            articles: document.querySelectorAll('article').length,
            feedUpdates: document.querySelectorAll('.feed-shared-update-v2').length,
            authPromptsDetected: /sign in|join now|verify it.s you|something went wrong/i.test(
                document.body?.innerText || '',
            ),
        }));
        fs.writeFileSync(
            txt,
            [
                `url: ${meta.url}`,
                `title: ${meta.title}`,
                `articles: ${meta.articles}`,
                `feedUpdates: ${meta.feedUpdates}`,
                `authPromptsDetected: ${meta.authPromptsDetected}`,
                '',
                '--- visible text (first 1500 chars) ---',
                meta.bodyPreview,
            ].join('\n'),
        );
        logProgress('LinkedIn', `🩺 Debug text:   ${txt}`);
        logProgress('LinkedIn', `   url=${meta.url}`);
        logProgress('LinkedIn', `   title="${meta.title}"`);
        logProgress('LinkedIn',
            `   articles=${meta.articles} feedUpdates=${meta.feedUpdates} ` +
            `authPromptsDetected=${meta.authPromptsDetected}`);
    } catch (err) {
        logProgress('LinkedIn', `   (text dump failed: ${err.message})`);
    }

    // 2. Screenshot — best-effort with a short timeout. Default 30s
    //    waits for fonts and stalls the whole scraper when the page is
    //    on a hung loading state. Cap at 5s; skip fullPage so we don't
    //    pay the layout-stable wait either.
    try {
        await page.screenshot({ path: png, fullPage: false, timeout: 5000 });
        logProgress('LinkedIn', `🩺 Debug screenshot: ${png}`);
    } catch (err) {
        const firstLine = (err.message || '').split('\n')[0];
        logProgress('LinkedIn', `   (screenshot skipped: ${firstLine})`);
    }
}

export async function extractPosts(page, maxPosts, opts = {}) {
    logProgress('LinkedIn', `📦 Extracting up to ${maxPosts} posts...`);

    const isFeedMode = CONFIG.useFeedInsteadOfSearch;
    const keywords = CONFIG.searchQuery.toLowerCase().split(' ');

    if (isFeedMode) {
        logProgress('LinkedIn', `   📋 Boolean Query: ${CONFIG.searchQuery}\n`);
    } else {
        logProgress('LinkedIn', '   Note: Only extracting CONTENT posts (not people/jobs/companies)\n');
    }
    
    // Debug: probe the new LinkedIn structure (May 2026+). The legacy
    // class-based selectors (.feed-shared-update-v2, .reusable-search__*,
    // .entity-result) all return 0 on the current DOM. We now key off
    // componentkey attributes — keep the legacy probes here for
    // observability so a future regression jumps out in the logs.
    const debugInfo = await page.evaluate(() => {
        const selectors = {
            // NEW (May 2026+) — what we actually use:
            'main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]':
                document.querySelectorAll('main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]').length,
            'main div[componentkey^="expanded"]':
                document.querySelectorAll('main div[componentkey^="expanded"]').length,
            'main div[componentkey]':
                document.querySelectorAll('main div[componentkey]').length,
            // LEGACY — expected to be 0 now; non-zero means LinkedIn rolled back:
            '.feed-shared-update-v2': document.querySelectorAll('.feed-shared-update-v2').length,
            '[data-urn*="activity:"]': document.querySelectorAll('[data-urn*="activity:"]').length,
            '.reusable-search__result-container': document.querySelectorAll('.reusable-search__result-container').length,
        };

        // Sample HTML from a post container (new selector first, legacy fallback).
        const sampleElement =
            document.querySelector('main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]')
            || document.querySelector('main div[componentkey^="expanded"]')
            || document.querySelector('.feed-shared-update-v2, .reusable-search__result-container');
        const sampleHTML = sampleElement
            ? sampleElement.outerHTML.substring(0, 500)
            : 'No elements found';

        return { selectors, sampleHTML };
    });
    
    logProgress('LinkedIn', '\n🔍 DEBUG INFO - Elements found on page:');
    Object.entries(debugInfo.selectors).forEach(([selector, count]) => {
        logProgress('LinkedIn', `   ${count > 0 ? '✓' : '✗'} ${selector}: ${count}`);
    });
    logProgress('LinkedIn', '\n📄 Sample HTML (first element):');
    logProgress('LinkedIn', 'Sample HTML: ' + debugInfo.sampleHTML.substring(0, 300) + '...\n');
    
    const allPosts = [];
    const seenIds = new Set();
    const seenContentHashes = new Set(); // Track content to avoid duplicates
    let scrollAttempts = 0;
    const maxScrolls = CONFIG.maxScrolls;
    let noNewPostsCount = 0;
    
    while (allPosts.length < maxPosts && scrollAttempts < maxScrolls) {
        scrollAttempts++;
        logProgress('LinkedIn', `📜 Scroll ${scrollAttempts}/${maxScrolls} - Posts found: ${allPosts.length}`);
        
        // FIRST: Expand all "see more" buttons in the current viewport
        await page.evaluate(() => {
            // Find and click all "see more" buttons to expand truncated content
            const seeMoreButtons = document.querySelectorAll(
                'button[aria-label*="see more"], ' +
                'button.feed-shared-inline-show-more-text__button, ' +
                '.feed-shared-inline-show-more-text button, ' +
                'button.see-more, ' +
                'button[data-test-id="see-more-button"], ' +
                '.update-components-text__see-more-less-toggle, ' +
                'button.update-components-text__see-more-less-toggle'
            );
            
            seeMoreButtons.forEach(button => {
                try {
                    if (button.offsetParent !== null) { // Check if visible
                        button.click();
                    }
                } catch (e) {
                    // Ignore click errors
                }
            });
        });
        
        // Wait a moment for content to expand
        await randomDelay(500, 800);
        
        // THEN: Extract posts from current viewport
        //
        // LinkedIn rewrote their content-search DOM (verified May 2026):
        //   - `data-urn` / `data-id` attributes: gone
        //   - All `.feed-shared-update-v2` / `.update-components-*` /
        //     `.reusable-search__result-container` class names: gone
        //   - CSS classes are now hashed CSS-module garbage (`_8284c9ef …`)
        //
        // What survives — what we now key off of:
        //   - Post containers are `main div[componentkey^="expanded"]...` —
        //     for content search, each post wrapper carries
        //     componentkey="expanded<HASH>FeedType_FLAGSHIP_SEARCH".
        //     (Confirmed 24 elements / 12 unique posts on a real page.)
        //   - Each post renders TWICE (virtual-scroll buffer), so we
        //     dedupe by the hash inside this evaluate() pass.
        //   - Author profile link: `a[href*="/in/"]` (appears 3× per post).
        //   - Author name: split that link's innerText on " • " (drops the
        //     "• 3rd+" connection-degree suffix).
        //   - Post body text: the full innerText is shaped like
        //       "Feed post {Author} • 3rd+ {tagline} {age} • Follow {body}…"
        //     so a `split(' • Follow ')[1]` gives us a clean body.
        //   - Time-ago is now plain text ("5d", "3h"); no `<time>` element.
        //   - Permalink: not in the card. Selectors targeting
        //     /feed/update/, /posts/, urn:li:activity all return 0. We
        //     leave postUrl empty; downstream code already tolerates it.
        const posts = await page.evaluate((config) => {
            const isSearchPage = window.location.href.includes('/search/results/content/');

            // LinkedIn A/B-tests two DOM layouts. Some accounts see the
            // NEW DOM (componentkey-based, May 2026), others still see
            // the LEGACY DOM (class-based: .feed-shared-update-v2 etc.).
            // We try the new selector first; if it returns 0 elements
            // we fall back to extracting from the legacy DOM.
            const SEARCH_SELECTOR = 'main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]';
            const FALLBACK_SELECTOR = 'main div[componentkey^="expanded"]';
            const LEGACY_SEARCH_SELECTOR = '.reusable-search__result-container, .feed-shared-update-v2';
            const LEGACY_FEED_SELECTOR = '.feed-shared-update-v2';

            let postElements = document.querySelectorAll(
                isSearchPage ? SEARCH_SELECTOR : FALLBACK_SELECTOR
            );
            if (postElements.length === 0) {
                postElements = document.querySelectorAll(FALLBACK_SELECTOR);
            }
            let useLegacyDOM = postElements.length === 0;
            if (useLegacyDOM) {
                postElements = document.querySelectorAll(
                    isSearchPage ? LEGACY_SEARCH_SELECTOR : LEGACY_FEED_SELECTOR
                );
            }

            const results = [];
            const debugInfo = { sampleLinks: [], foundIds: [], dom: useLegacyDOM ? 'legacy' : 'new' };
            const seenInRun = new Set(); // per-page dedup (each post renders 2x)

            // ─── LEGACY DOM extractor (pre-May 2026 class-based layout) ───
            // Runs when componentkey selectors find nothing — typically when
            // the user's LinkedIn account is on the old A/B-test branch.
            if (useLegacyDOM) {
                postElements.forEach((element, index) => {
                    try {
                        if (element.querySelector('a[href*="/jobs/view/"]')) return;

                        // Post ID: prefer data-urn (activity:NNN), else hash from links
                        let postId = null;
                        const containerUrn = element.getAttribute('data-urn');
                        if (containerUrn && containerUrn.includes('activity:')) {
                            const m = containerUrn.match(/activity:([^:,\s)]+)/);
                            if (m) postId = m[1];
                        }
                        if (!postId) {
                            const inner = element.querySelectorAll('[data-urn], [data-id]');
                            for (const el of inner) {
                                const urn = el.getAttribute('data-urn') || el.getAttribute('data-id');
                                if (urn && urn.includes('activity:')) {
                                    const m = urn.match(/activity:([^:,\s)]+)/);
                                    if (m) { postId = m[1]; break; }
                                }
                            }
                        }
                        if (!postId) {
                            const links = element.querySelectorAll('a[href]');
                            for (const link of links) {
                                const href = link.getAttribute('href') || '';
                                const m = href.match(/(?:activity[:-])(\d{19})/);
                                if (m) { postId = m[1]; break; }
                            }
                        }
                        if (!postId) postId = 'post_' + Math.random().toString(36).slice(2, 11);
                        if (seenInRun.has(postId)) return;
                        seenInRun.add(postId);

                        // Author name (try several legacy selectors)
                        let authorName = '';
                        for (const sel of [
                            '.update-components-actor__name',
                            '.feed-shared-actor__name',
                            '.update-components-actor__title',
                            'span.update-components-actor__name span[aria-hidden="true"]',
                            'span[dir="ltr"]',
                        ]) {
                            const el = element.querySelector(sel);
                            const t = el?.textContent?.trim();
                            if (t && t.length > 2) { authorName = t; break; }
                        }

                        // Author profile URL
                        let authorProfileUrl = '';
                        for (const sel of [
                            '.update-components-actor__container a[href*="/in/"]',
                            '.feed-shared-actor a[href*="/in/"]',
                            'a.app-aware-link[href*="/in/"]',
                        ]) {
                            const a = element.querySelector(sel);
                            if (a?.href?.includes('/in/')) { authorProfileUrl = a.href.split('?')[0]; break; }
                        }

                        // Post content
                        let postContent = '';
                        for (const sel of [
                            '.feed-shared-update-v2__description',
                            '.update-components-text',
                            '.feed-shared-text',
                            '.update-components-update-v2__commentary',
                            '.feed-shared-update-v2__commentary',
                            '.feed-shared-inline-show-more-text',
                            'div[dir="ltr"]',
                        ]) {
                            const el = element.querySelector(sel);
                            const t = el?.textContent?.trim();
                            if (t && t.length > 20) { postContent = t; break; }
                        }

                        // Timestamp
                        let timestamp = '';
                        for (const sel of [
                            '.update-components-actor__sub-description',
                            '.feed-shared-actor__sub-description',
                            'time',
                            '[datetime]',
                        ]) {
                            const el = element.querySelector(sel);
                            if (el) {
                                timestamp = el.getAttribute('datetime') || el.textContent?.trim() || '';
                                if (timestamp) break;
                            }
                        }

                        // Post URL — try timestamp link, then dedicated selectors
                        let postUrl = '';
                        const tsLink = element.querySelector(
                            '.update-components-actor__sub-description a, ' +
                            '.feed-shared-actor__sub-description a, ' +
                            'time a, ' +
                            'a.app-aware-link[href*="activity"]'
                        );
                        if (tsLink?.href?.includes('activity')) {
                            postUrl = tsLink.href.split('?')[0];
                        }
                        if (!postUrl && postId && !postId.startsWith('post_')) {
                            postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${postId}`;
                        }

                        if (debugInfo.foundIds.length === 0) {
                            debugInfo.foundIds.push({
                                postId: postId.slice(0, 30),
                                hasUrl: !!postUrl,
                                author: authorName,
                                contentLen: postContent.length,
                            });
                        }

                        const contentHash = postContent.substring(0, 100) + authorName;
                        if (authorName && postContent && postContent.length > 20) {
                            results.push({
                                id: postId,
                                author: authorName,
                                authorProfileUrl,
                                content: postContent,
                                timestamp,
                                postUrl,
                                contentLength: postContent.length,
                                contentHash,
                            });
                        }
                    } catch (e) { /* skip */ }
                });
                return { results, debugInfo };
            }
            // ─── NEW DOM extractor (componentkey-based, May 2026+) ───

            postElements.forEach((element, index) => {
                try {
                    // Skip job cards (different componentkey naming on those,
                    // but defensive check in case any leak through).
                    if (element.querySelector('a[href*="/jobs/view/"]')) return;

                    // Extract post id from the componentkey attribute.
                    //   expanded<HASH>FeedType_FLAGSHIP_SEARCH  →  <HASH>
                    const compKey = element.getAttribute('componentkey') || '';
                    const postId = compKey
                        .replace(/^expanded/, '')
                        .replace(/FeedType_[A-Z_]+$/, '');
                    if (!postId || seenInRun.has(postId)) return;
                    seenInRun.add(postId);

                    // Debug capture (first hit only)
                    if (index === 0 && results.length === 0) {
                        const sampleLinks = Array.from(element.querySelectorAll('a[href]')).slice(0, 8);
                        debugInfo.sampleLinks = sampleLinks.map(l => l.getAttribute('href'));
                        debugInfo.elementInfo = {
                            componentkey: compKey.slice(0, 100),
                            extractedPostId: postId.slice(0, 40),
                        };
                    }

                    // Author profile link
                    const authorEl = element.querySelector('a[href*="/in/"]');
                    const authorProfileUrl = authorEl ? authorEl.href.split('?')[0] : '';

                    // Author name: prefer the link's text (split off the
                    // "• 3rd+" suffix). If that's empty, fall back to the
                    // "Open control menu for post by X" button's aria-label.
                    let authorName = '';
                    if (authorEl) {
                        const linkText = (authorEl.innerText || '').trim();
                        authorName = linkText.split('•')[0].trim();
                    }
                    if (!authorName) {
                        const ctlBtn = element.querySelector('button[aria-label^="Open control menu for post by"]');
                        if (ctlBtn) {
                            authorName = (ctlBtn.getAttribute('aria-label') || '')
                                .replace(/^Open control menu for post by\s+/i, '')
                                .trim();
                        }
                    }

                    // Body text — split on " • Follow " (the boundary
                    // between the header strip and the user-authored
                    // body). If that pattern's absent, scan for the
                    // longest <span dir="ltr"> / <p> / <div lang> child.
                    const fullText = (element.innerText || '').trim();
                    let postContent = '';
                    const followSplit = fullText.split(/\s+•\s+Follow\s+/);
                    if (followSplit.length > 1) {
                        postContent = followSplit.slice(1).join(' • Follow ').trim();
                    } else {
                        const candidates = element.querySelectorAll('span[dir="ltr"], p, div[lang]');
                        let best = '';
                        for (const c of candidates) {
                            const t = (c.innerText || '').trim();
                            if (t.length > best.length) best = t;
                        }
                        postContent = best;
                    }
                    // Trim trailing engagement noise that follows the body
                    // (likes/comments counters appear after the body in
                    // innerText). Cut at the first " · " separator that's
                    // followed by digits or "Like"/"Comment"/"Repost".
                    postContent = postContent.replace(
                        /\s+(?:Like|Comment|Repost|Send)\s+.*$/s, ''
                    ).trim();

                    // Time-ago: ends the header strip just before " • Follow".
                    // Pattern: "...{tagline} 5d • Follow {body}". Pull the
                    // last \d+[smhdwy] token before the " • Follow " split.
                    let timestamp = '';
                    const headerStrip = followSplit[0] || fullText;
                    const timeMatch = headerStrip.match(/(\d+[smhdwy])\s*$/);
                    if (timeMatch) {
                        timestamp = timeMatch[1];
                    }

                    // Permalink: find the post's activity URN (a data-urn
                    // attribute, else anywhere in the element markup) and build
                    // the canonical permalink. Fall back to an explicit
                    // update/posts link. NEVER use the author /in/ link here —
                    // that points at a person, not the post.
                    let activityId = '';
                    const urnHost = element.querySelector('[data-urn*="urn:li:activity:"]');
                    const urnAttr = element.getAttribute('data-urn')
                        || (urnHost && urnHost.getAttribute('data-urn'))
                        || '';
                    let urnMatch = urnAttr.match(/urn:li:activity:(\d+)/);
                    if (!urnMatch) urnMatch = element.outerHTML.match(/urn:li:activity:(\d+)/);
                    if (urnMatch) activityId = urnMatch[1];

                    let postUrl = '';
                    if (activityId) {
                        postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
                    } else {
                        const updateLink = element.querySelector(
                            'a[href*="/feed/update/"], a[href*="/posts/"], a[href*="urn:li:activity"]'
                        );
                        if (updateLink?.href) postUrl = updateLink.href.split('?')[0];
                    }
                    const activityUrn = activityId ? `urn:li:activity:${activityId}` : '';

                    // Track for debug on first successful extraction
                    if (debugInfo.foundIds.length === 0) {
                        debugInfo.foundIds.push({
                            postId: postId.slice(0, 30),
                            hasUrl: !!postUrl,
                            author: authorName,
                            contentLen: postContent.length,
                        });
                    }

                    // Content hash for cross-cycle dedup (the outer scroll
                    // loop dedupes across scroll iterations).
                    const contentHash = postContent.substring(0, 100) + authorName;

                    if (authorName && postContent && postContent.length > 20) {
                        results.push({
                            id: postId,
                            author: authorName,
                            authorProfileUrl,
                            content: postContent,
                            timestamp,
                            postUrl,
                            activityUrn,
                            contentLength: postContent.length,
                            contentHash,
                        });
                    }
                } catch (e) {
                    // Skip invalid posts
                }
            });

            return { results, debugInfo };
        }, CONFIG);
        
        // Log debug info for first scroll
        if (scrollAttempts === 1 && posts.debugInfo) {
            logProgress('LinkedIn', '\n🔍 DEBUG - First post analysis:');
            logProgress('LinkedIn', 'Element info: ' + JSON.stringify(posts.debugInfo.elementInfo));
            logProgress('LinkedIn', '\nSample links from first post:');
            posts.debugInfo.sampleLinks?.forEach((link, i) => {
                logProgress('LinkedIn', `  ${i + 1}. ${link?.substring(0, 80)}`);
            });
            logProgress('LinkedIn', '\nID extraction results: ' + JSON.stringify(posts.debugInfo.foundIds));
            logProgress('LinkedIn', '');
        }
        
        // Use the results array from the returned object
        const extractedPosts = posts.results || posts;
        
        // Add new posts with deduplication
        let newPostsCount = 0;
        for (const post of extractedPosts) {
            // Check both ID and content hash to avoid duplicates
            const isDuplicateById = seenIds.has(post.id);
            const isDuplicateByContent = seenContentHashes.has(post.contentHash);

            // Only add if not duplicate and we haven't reached max
            if (!isDuplicateById && !isDuplicateByContent && allPosts.length < maxPosts) {
                seenIds.add(post.id);
                seenContentHashes.add(post.contentHash);

                // Remove contentHash before adding to final results
                const { contentHash, ...postWithoutHash } = post;
                allPosts.push(postWithoutHash);
                newPostsCount++;

                // Resolve this post's permalink NOW, while its element is fresh
                // in the DOM (it was just scrolled into view). Best-effort.
                if (typeof opts.onNewPost === 'function') {
                    await opts.onNewPost(postWithoutHash);
                }
            }
        }
        
        if (newPostsCount > 0) {
            logProgress('LinkedIn', `   ✓ Found ${newPostsCount} new posts (total: ${allPosts.length})`);
            // Log sample URLs from first post
            if (allPosts.length === newPostsCount) {
                const firstPost = allPosts[0];
                logProgress('LinkedIn', `   📎 Sample URLs:`);
                logProgress('LinkedIn', `      Author: ${firstPost.authorProfileUrl ? '✓' : '✗'} ${firstPost.authorProfileUrl || 'Not found'}`);
                logProgress('LinkedIn', `      Post: ${firstPost.postUrl ? '✓' : '✗'} ${firstPost.postUrl || 'Not found'}`);
            }
            noNewPostsCount = 0;
            if (typeof opts.onAuthenticatedBatch === 'function') {
                try {
                    const jar = await page.context().cookies();
                    await opts.onAuthenticatedBatch(jar);
                } catch (_capErr) {
                    // best-effort — never throws into the scroll loop
                }
            }
        } else {
            noNewPostsCount++;
            logProgress('LinkedIn', `   ⚠️  No new posts found (${noNewPostsCount} scrolls without new content)`);
        }

        // Stop early once no new posts for CONFIG.noProgressStop
        // consecutive scrolls (default 4, env LINKEDIN_NOPROGRESS_STOP;
        // was a hard-coded 15, then 5) — avoids wasting 30-45s scrolling
        // when LinkedIn has genuinely run out of results.
        if (noNewPostsCount >= CONFIG.noProgressStop) {
            logProgress('LinkedIn', `   ℹ️  No new posts for ${CONFIG.noProgressStop} scrolls, stopping...`);
            break;
        }

        // Scroll to the bottom — LinkedIn's intersection observer only
        // fires at the bottom edge of the scroll root. The NEW DOM
        // (A/B test variant) puts the feed inside a scrollable <main>
        // and the document.documentElement scrollHeight stays pinned
        // at viewport height — scrolling the window does nothing in
        // that case. So we detect the actual scroll root and drive it.
        // LEGACY DOM has main.scrollHeight ≈ main.clientHeight, so the
        // window-scroll branch is taken.
        await page.evaluate(() => {
            const main = document.querySelector('main');
            if (main && main.scrollHeight > main.clientHeight + 50) {
                main.scrollTop = main.scrollHeight;
            } else {
                window.scrollTo(0, document.documentElement.scrollHeight);
            }
        });

        await wait(nextScrollDelay(scrollAttempts, Math.random, CONFIG.scrollPacing));
    }

    if (allPosts.length === 0) {
        logProgress('LinkedIn', '\n⚠️  WARNING: No posts extracted!');
        logProgress('LinkedIn', '   This could mean:');
        logProgress('LinkedIn', '   1. Not on content search results page');
        logProgress('LinkedIn', '   2. LinkedIn changed their HTML structure');
        logProgress('LinkedIn', '   3. No results for this search query');
        logProgress('LinkedIn', '   4. Content is not loading (check browser window)');
        logProgress('LinkedIn', '   5. Cookies may have expired — refresh credentials in centralD');
        // Save what the browser is actually showing so the operator can
        // see "blank window" vs "captcha challenge" vs "session expired".
        await dumpDebugSnapshot(page, 'no-posts');
    } else if (allPosts.length < 5) {
        // Suspiciously few results — also dump so we can diagnose whether
        // LinkedIn truly has only a handful matching the query, or whether
        // we're stuck on a partial render / soft block.
        logProgress('LinkedIn', `   (only ${allPosts.length} posts — saving debug snapshot for review)`);
        await dumpDebugSnapshot(page, 'few-posts');
    }

    return allPosts;
}

async function analyzePosts(posts) {
    logProgress('LinkedIn', '\n📊 Analyzing posts...');
    
    const jobPosts = posts.filter(post => {
        const content = post.content.toLowerCase();
        const isJobRelated = 
            content.includes('hiring') ||
            content.includes('job') ||
            content.includes('position') ||
            content.includes('looking for') ||
            content.includes('join our team') ||
            content.includes('apply') ||
            content.includes('engineer') ||
            content.includes('developer');
        
        return isJobRelated;
    });
    
    logProgress('LinkedIn', `✅ Total posts extracted: ${posts.length}`);
    logProgress('LinkedIn', `✅ Job-related posts: ${jobPosts.length}`);
    logProgress('LinkedIn', `✅ Other posts: ${posts.length - jobPosts.length}`);
    
    return {
        all: posts,
        jobRelated: jobPosts
    };
}



// Export function for UnifiedJobScraper
//
// `options.searchQueries` (optional) is an array of pre-built LinkedIn
// boolean search queries — typically 3 AI-generated variants supplied by
// the backend's AIRoleNormalizationService and shipped through the queue
// payload. Anti-bot pacing: exactly ONE uniformly-random variant is run
// per browser session (LinkedIn invalidates the automated session after
// ~1 query); coverage of the remaining variants accrues across repeated
// orchestrator cycles. When absent, falls back to the legacy
// single-template `"<role>" AND (c2c OR W2 OR 1099)`.
export async function scrapeLinkedIn(jobTitle, location, sessionId = null, options = {}) {
    logProgress('LinkedIn', '🚀 LinkedIn Post Scraper (CloakBrowser + cookie auth)\n');
    logProgress('LinkedIn', '='.repeat(50));

    // Override CONFIG with parameters (location is ignored, search uses only jobTitle)
    CONFIG.jobTitle = jobTitle;

    // Build the query list. Prefer caller-supplied AI variants; fall
    // back to the legacy single boolean template.
    const aiQueries = Array.isArray(options.searchQueries) && options.searchQueries.length > 0
        ? options.searchQueries
        : null;
    // Anti-bot: run exactly ONE query per browser session — LinkedIn
    // invalidates the automated session after ~1 query. A uniformly-
    // random variant gives all variants coverage across repeated cycles.
    const chosen = pickSessionQuery(aiQueries) ?? buildBooleanSearchQuery(jobTitle);
    const chosenIdx = aiQueries ? aiQueries.indexOf(chosen) : -1;
    const queriesToRun = [chosen];
    CONFIG.searchQuery = queriesToRun[0]; // for downstream compatibility (logs, dumpDebugSnapshot)

    logProgress('LinkedIn', `   Job Title: "${jobTitle}"`);
    if (aiQueries) {
        logProgress('LinkedIn', `   🎲 Variant [${chosenIdx + 1}/${aiQueries.length}] selected for this session: ${chosen}`);
    } else {
        logProgress('LinkedIn', `   Boolean Query (legacy template): ${CONFIG.searchQuery}\n`);
    }
    
    // Persistent-session model (D1b): the LinkedInSession singleton holds
    // ONE long-lived CloakBrowser context + credential lease for the whole
    // process. We borrow a fresh page (tab) per role via withPage and never
    // close the browser here — it stays warm so LinkedIn keeps the session
    // alive and cookies rotate in place, instead of cold-launching +
    // re-injecting a decaying cookie export every role.
    const session = getLinkedInSession();
    try {
        return await session.withPage(sessionId, async (page, lease) => {
        // Use the lease captured for THIS borrower, not the shared singleton
        // session.lease — a sibling concurrent scrape's reestablish() can null
        // session._lease mid-flight (prod 2026-06-16: "Cannot read ... credential"
        // crashes once the backend started handing out concurrent LinkedIn roles).
        const credential = lease?.credential;
        if (!credential) {
            throw new NetworkError('LinkedIn session lease unavailable (concurrent re-establish) — role will retry', { platform: 'linkedin' });
        }
        // Print credential info (mask password)
        logProgress('LinkedIn', `✅ Credential in use:`);
        logProgress('LinkedIn', `   📧 Email: ${credential.email}`);
        logProgress('LinkedIn', `   🔒 Password: ${'*'.repeat(credential.password?.length || 8)}`);
        logProgress('LinkedIn', `   🆔 Credential ID: ${credential.id}`);

        CONFIG.email = credential.email;
        CONFIG.password = credential.password;
        CONFIG.credentialId = credential.id;
        
        // Anti-bot pacing: `queriesToRun` holds exactly ONE variant, so
        // this loop iterates once per session. The cross-query
        // accumulation/dedup machinery (and the qi>0 inter-query delay)
        // is retained intact but effectively single-pass — it stays
        // correct if the one-variant policy is ever relaxed.
        const seenIdsAcrossQueries = new Set();
        const posts = [];
        const perQueryYield = []; // [{ query, queryIndex, found, added }]

        // Mid-scrape cookie capture (handoff 2026-05-20 §4): stash the
        // freshest jar that still has li_at, captured *during* a successful
        // results batch (not at close — by then LinkedIn may have
        // invalidated li_at server-side).
        let latestAuthenticatedJar = null;
        const onAuthenticatedBatch = (jar) => {
            if (hasLiAt(jar)) latestAuthenticatedJar = jar;
        };

        // Resolve each new post's permalink via its "···" menu (the activity
        // URN isn't in the rendered DOM). Called per post during extraction,
        // while the element is fresh. Best-effort — empty url, never wrong.
        const onNewPost = async (post) => {
            if (post.postUrl) return;
            const act = await resolvePostUrlViaMenu(page, post.id);
            if (act) {
                post.activityUrn = `urn:li:activity:${act}`;
                post.postUrl = activityPermalink(act);
            }
        };

        for (let qi = 0; qi < queriesToRun.length; qi++) {
            if (posts.length >= CONFIG.maxPosts) {
                logProgress('LinkedIn',
                    `🛑 Reached maxPosts=${CONFIG.maxPosts}; skipping remaining ${queriesToRun.length - qi} query(ies).`);
                break;
            }

            const q = queriesToRun[qi];
            CONFIG.searchQuery = q;
            if (qi > 0) {
                // 8-12s buffer between queries — empirically enough to
                // avoid LinkedIn's "you're searching too fast" throttle
                // on the same logged-in session.
                logProgress('LinkedIn', `\n⏳ Inter-query delay before query [${qi + 1}/${queriesToRun.length}]...`);
                await randomDelay(8000, 12000);
            }
            logProgress('LinkedIn',
                `\n🔎 Query [${qi + 1}/${queriesToRun.length}]: ${q}`);

            await navigateToSearch(page, q);

            // Earliest authenticated capture (handoff 2026-05-20 §3a): the
            // moment navigateToSearch returns we're provably on /search/results/
            // content/... and authenticated; on a flagged account LinkedIn can
            // revoke li_at during the scroll loop, so grab the jar *before*
            // extractPosts begins scrolling. The per-batch capture inside
            // extractPosts still runs — latestAuthenticatedJar holds whichever
            // good capture was most recent. Best-effort, never throws.
            try {
                await onAuthenticatedBatch(await page.context().cookies());
            } catch (_preScrollCapErr) {
                // swallow — capture is best-effort, the per-batch hook is the backstop
            }

            const remainingBudget = CONFIG.maxPosts - posts.length;
            const queryPosts = await extractPosts(page, remainingBudget, { onAuthenticatedBatch, onNewPost });

            // Dedup by id — same post can match multiple queries.
            // Tag with the query that found it for downstream tracing.
            let added = 0;
            for (const p of queryPosts) {
                if (p.id && seenIdsAcrossQueries.has(p.id)) continue;
                if (p.id) seenIdsAcrossQueries.add(p.id);
                posts.push({ ...p, queryUsed: q, queryIndex: qi });
                added++;
                if (posts.length >= CONFIG.maxPosts) break;
            }
            perQueryYield.push({ query: q, queryIndex: qi, found: queryPosts.length, added });
            logProgress('LinkedIn',
                `   query [${qi + 1}] → found ${queryPosts.length}, ${added} new (running total: ${posts.length})`);
        }

        logProgress('LinkedIn', '\n📊 Per-query yield:');
        const metrics = getMetrics();
        perQueryYield.forEach(({ queryIndex, found, added }) => {
            logProgress('LinkedIn', `   [${queryIndex + 1}] found=${found}, added=${added}`);
            metrics.recordLinkedInQueryYield(queryIndex, added);
        });

        // Analyze posts
        const analyzed = await analyzePosts(posts);

        logProgress('LinkedIn', '\n✨ Scraping completed successfully!');
        logProgress('LinkedIn', `📊 Found ${analyzed.jobRelated.length} job-related posts`);
        
        // Helper: hash string for fallback jobId
        function hashString(str) {
            let hash = 5381;
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) + hash) + str.charCodeAt(i);
            }
            return 'h' + (hash >>> 0).toString(36);
        }

        // Helper: parse ISO date or return undefined
        function parseISODate(val) {
            if (!val) return undefined;
            // Accept ISO or YYYY-MM-DD
            if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val;
            // Try to parse relative dates (e.g., '2d ago') as today
            if (/ago$/.test(val)) return new Date().toISOString().slice(0, 10);
            return undefined;
        }

        // Helper: Clean text - remove extra whitespace, newlines, special characters
        function cleanText(text) {
            if (!text) return '';
            return text
                .replace(/\s+/g, ' ')  // Replace multiple whitespace with single space
                .replace(/[\r\n\t]/g, ' ')  // Replace newlines and tabs with space
                .replace(/[^\x20-\x7E]/g, '')  // Remove non-printable characters
                .trim();
        }

        const normalizedPosts = analyzed.all.map(post => {
            // Required fields: title, company, location, description, job_url, external_job_id
            
            // Extract clean company name from author (remove LinkedIn badges and extra text)
            let companyName = cleanText(post.author || '');
            
            // Remove LinkedIn badge indicators like "• 1st", "• 2nd", "• 3rd+", "Premium", "Follows"
            companyName = companyName
                .replace(/\s*•\s*(1st|2nd|3rd\+?|Premium|Follows?)\s*/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            
            // Handle duplicated names (sometimes LinkedIn duplicates the author name)
            // If the name appears twice with possible whitespace between, take only the first occurrence
            const nameParts = companyName.split(/\s+/);
            if (nameParts.length > 2) {
                // Check if first half equals second half (duplicated)
                const mid = Math.floor(nameParts.length / 2);
                const firstHalf = nameParts.slice(0, mid).join(' ');
                const secondHalf = nameParts.slice(mid).join(' ');
                if (firstHalf === secondHalf || secondHalf.startsWith(firstHalf)) {
                    companyName = firstHalf;
                }
            }
            
            // Final cleanup
            companyName = companyName.trim();
            if (!companyName) companyName = 'LinkedIn Post Author';
            
            // Clean title - use first 200 chars of content (not truncated)
            let title = cleanText(post.content || '').substring(0, 200);
            if (!title) title = 'LinkedIn Job Post';
            
            // Clean description
            const desc = cleanText(post.content || '') || 'N/A';
            
            // Job source URL = the POST permalink ONLY. Prefer the extracted
            // permalink; else rebuild from the activity URN. NEVER fall back to
            // the author /in/ profile — a profile link misleadingly looks like
            // the posting is that person's page. Empty is better than wrong.
            const url = postSourceUrl(post.postUrl)
                || activityPermalink(extractActivityId(post.activityUrn || post.postUrl));
            
            // Generate unique job ID
            let jobId = post.id;
            if (!jobId || typeof jobId !== 'string' || jobId.length > 40) {
                jobId = url ? hashString(url) : hashString(title + companyName + location);
            }
            const postedDate = parseISODate(post.timestamp);

            const jobObj = {
                title,
                company: companyName,
                location: location || '',
                description: desc,
                url,
                jobId,
                postId: post.id,
                activityUrn: post.activityUrn,
                author: post.author,
                authorProfile: post.authorProfileUrl,
                timestamp: post.timestamp,
                engagement: post.engagement,
                isJobRelated: post.isJobRelated,
                // Pass through which AI search-query variant produced
                // this post — useful downstream for measuring per-query
                // yield and for tuning the prompt.
                queryUsed: post.queryUsed,
                queryIndex: post.queryIndex,
            };
            if (postedDate) jobObj.postedDate = postedDate;
            return normalizeJobData(jobObj, 'LinkedIn');
        });

        // L1: 0 posts is NOT automatically success. In STRICT mode, if
        // nothing was extracted and the page didn't positively show a
        // LinkedIn "no results" state, treat it as a suspected silent
        // block / DOM change and fail loudly (classified metric +
        // cooldown via the catch below) rather than reportSuccess([]).
        let emptyConfirmed = false;
        if (normalizedPosts.length === 0) {
            const html = await page.content().catch(() => '');
            const state = linkedinPageState(html, page.url(), await page.title().catch(() => ''));
            emptyConfirmed = state === 'no_results';
            if (STRICT && !emptyConfirmed) {
                throw new DomChangedError(
                    `LinkedIn returned 0 posts and no "no results" marker (page state: ${state}) — suspected silent block / DOM change`,
                    { platform: 'linkedin' },
                );
            }
        }

        // Per-role liveness against the held lease. Persistent session
        // stays warm; no per-role cookie write-back (no per-role browser
        // close means no close-time poison to work around).
        await lease?.reportSuccess?.(`Scraped ${normalizedPosts.length} posts successfully`);

        // BaseScraper (Plan 1A) accepts Array OR { jobs, emptyConfirmed }.
        // emptyConfirmed only when LinkedIn positively showed no-results;
        // behavior-neutral for the jobs payload when OFF.
        return { jobs: normalizedPosts, emptyConfirmed: emptyConfirmed && normalizedPosts.length === 0 };

        });
    } catch (error) {
        logProgress('LinkedIn', '\n❌ Error: ' + error.message);
        logProgress('LinkedIn', 'Stack trace: ' + error.stack);

        // Persistent-session failure policy (design §5): decouple the ROLE
        // outcome from the CREDENTIAL outcome.
        //  • AuthError → the credential is dead: cool it down AND tear the
        //    session down so the next role re-establishes with a fresh lease.
        //  • Blocked / DomChanged / other → the credential is fine, only this
        //    role failed: keep the warm session, do NOT cool the credential.
        // Always re-throw so BaseScraper records + classifies the role.
        if (error instanceof AuthError) {
            logProgress('LinkedIn', '📤 Auth-wall / cookies expired — cooldown + reestablishing session...');
            // Phase 3b — Task B: only the LIVE single-account (LOCAL) box writes
            // the PLATFORM-WIDE cooldown marker on a single account's auth-fail.
            // In REMOTE mode the pool has other accounts, so a single dead
            // account just gets cooled via reportFailure (below) and the next
            // lease rotates onto a healthy one — writing the platform marker
            // would needlessly pause ALL of LinkedIn. The platform marker is
            // reserved for pool-exhausted / pool-unreachable (#acquireLease).
            //
            // LOCAL rationale (UNCHANGED, PR #310): without the marker a queue
            // full of LinkedIn roles makes the orchestrator fire dozens of
            // concurrent scrapes that all instant-fail with "session lease
            // unavailable (concurrent re-establish)" — ~5,000 fast-fails over
            // 12h observed 2026-06-21. Recovery is manual: `npm run linkedin:login`.
            const { writePlatformMarker } = authFailCooldownPlan({ isLocal: session.isLocal });
            if (writePlatformMarker) {
                try {
                    linkedinCooldown.writeCooldownMarker({
                        writeFile: linkedinCooldown.defaultWriteFile(),
                        rename: linkedinCooldown.defaultRename(),
                        now: new Date(),
                        cooldownMs: linkedinCooldown.cooldownMs(),
                        path: linkedinCooldown.cooldownPath(),
                    });
                    log.warn('LinkedIn auth dead — platform cooled down; run `npm run linkedin:login` to recover', {
                        platform: 'linkedin',
                        scraper_alert: 'linkedin_auth_cooldown',
                        cooldownMin: Math.round(linkedinCooldown.cooldownMs() / 60000),
                    });
                } catch (cdErr) {
                    logProgress('LinkedIn', `   cooldown write failed: ${cdErr.message}`);
                }
            } else {
                log.info('LinkedIn account auth-fail in REMOTE mode — cooling the account only (pool will rotate), no platform pause', {
                    platform: 'linkedin',
                });
            }
            try {
                await session.lease?.reportFailure(`Auth/cookies expired: ${error.message}`, COOKIES_EXPIRED_COOLDOWN_MIN);
            } catch (repErr) {
                logProgress('LinkedIn', `   reportFailure failed: ${repErr.message}`);
            }
            try {
                await session.reestablish(sessionId);
            } catch (reErr) {
                logProgress('LinkedIn', `   session reestablish failed: ${reErr.message}`);
            }
        } else if (error instanceof BlockedError) {
            logProgress('LinkedIn', '📤 BLOCKED / challenge — role failed, keeping warm session...');
        } else if (error instanceof DomChangedError) {
            logProgress('LinkedIn', '📤 DOM change / suspected silent block — role failed, keeping warm session...');
        } else {
            logProgress('LinkedIn', '⚠️  Scrape error — role failed, keeping warm session...');
        }
        throw error;
    }
}


