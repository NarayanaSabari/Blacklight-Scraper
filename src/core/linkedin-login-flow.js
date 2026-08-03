// Reusable core of the LinkedIn manual-login flow, shared by the interactive
// CLI (`npm run linkedin:login`, scripts/linkedin-login.js) and the control
// panel's two-step login (src/panel/linkedin-login-controller.js).
//
// Kept deliberately free of any console/ask/HTTP concerns — those differ
// between the two callers. This module only knows how to open the persistent
// profile, read cookies out of it, and prove (by navigating) whether the
// resulting session is actually alive.
//
// A dead LinkedIn session makes scrapeLinkedInRsc report
// `{ jobs: [], emptyConfirmed: true }` — a POSITIVE "no results" assertion
// that the backend takes as "role genuinely has nothing", not "retry me". A
// login that "succeeds" but leaves a dead cookie jar is therefore the worst
// failure mode here, which is why validateSession() is not optional in the
// panel flow.

import { launchPersistentContext } from './browser-pool.js';
import { launchPersistentProfile } from './linkedin-browser.js';
import { linkedInProfileDir, profileDirFor } from './linkedin-profile.js';

const FEED_URL = 'https://www.linkedin.com/feed/';
// A landing URL under any of these paths means the cookies did NOT get us
// past auth, regardless of what `li_at` looks like.
const LOGGED_OUT_PATH_RE = /\/(login|checkpoint|authwall)(\/|$|\?)/i;

// The SAME resolver the scraper itself uses (profileDirFor), so the login
// flow and the runtime scrape can never disagree about where a given
// account's profile lives. A falsy profileKey resolves to the legacy single
// default dir — identical to linkedInProfileDir().
export function resolveLoginProfileDir({ profileKey } = {}) {
    return profileDirFor(profileKey || null);
}

/**
 * Launch the headed persistent-profile browser and return a handle
 * `{ context, page }`. Mirrors the branching that has always lived in
 * scripts/linkedin-login.js: a profileKey gets the pinned-fingerprint +
 * proxy per-account path; no profileKey gets the legacy single-profile path.
 *
 * `deps.legacyLauncher` / `deps.profileLauncher` are injection seams for
 * tests — production defaults to the real launchers, which lease a
 * CloakBrowser seat through src/core/browser-pool.js exactly like every
 * other browser launch in this codebase.
 */
export async function openLoginBrowser({ profileKey = null, proxy = null } = {}, deps = {}) {
    const legacyLauncher = deps.legacyLauncher ?? launchPersistentContext;
    const profileLauncher = deps.profileLauncher ?? launchPersistentProfile;

    const context = profileKey
        ? await profileLauncher({ profileKey, proxy })
        : await legacyLauncher({
            userDataDir: linkedInProfileDir(),
            headless: false,
            humanize: true,
            viewport: { width: 1366, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
    const page = context.pages()[0] || await context.newPage();
    return { context, page };
}

/**
 * Read cookies from the LIVE context, before closing it. Never throws — a
 * read failure comes back as `{ cookies: [], error }` so the caller can
 * decide what to do (the CLI warns and continues; the panel folds it into a
 * failed verdict).
 */
export async function captureSession({ context }) {
    try {
        const cookies = await context.cookies();
        return { cookies, error: null };
    } catch (err) {
        return { cookies: [], error: err.message };
    }
}

/**
 * Prove the captured session is actually alive by navigating to the feed.
 * A redirect to /login, /checkpoint, or /authwall means the cookies are
 * dead even if `li_at` is present. Never throws — a navigation failure
 * itself is a fail verdict, not an exception.
 */
export async function validateSession({ page }) {
    try {
        await page.goto(FEED_URL, { waitUntil: 'domcontentloaded' });
    } catch (err) {
        return { ok: false, reason: 'navigation_failed', error: err.message, finalUrl: null };
    }
    const finalUrl = typeof page.url === 'function' ? page.url() : null;
    if (!finalUrl) {
        return { ok: false, reason: 'unknown_url', error: null, finalUrl: null };
    }
    if (LOGGED_OUT_PATH_RE.test(finalUrl)) {
        return { ok: false, reason: 'redirected_to_login', error: null, finalUrl };
    }
    return { ok: true, reason: null, error: null, finalUrl };
}

/**
 * Close the browser context. Releasing the CloakBrowser seat is NOT this
 * module's job — src/core/browser-pool.js already wraps `close()` to
 * release the lease, so calling it here is enough; the caller doesn't need
 * to know a seat was ever involved.
 */
export async function closeLoginBrowser({ context } = {}) {
    if (context && typeof context.close === 'function') {
        await context.close();
    }
}
