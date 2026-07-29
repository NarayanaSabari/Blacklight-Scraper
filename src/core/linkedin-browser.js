// Launching a LinkedIn persistent stealth profile.
//
// Survives the removal of the DOM scraper because two things still need it: the
// one-time operator login (`npm run linkedin:login`) and the RSC template
// capture (`npm run linkedin:rsc-template`). The RSC scraper itself only reads
// cookies out of the profile and never drives a page.
//
// The clipboard grant/init hooks the DOM scraper needed for its "Copy link to
// post" permalink resolver are gone: the RSC transport reads permalinks straight
// out of the payload.

import { launchPersistentContext } from './browser-pool.js';
import { createLogger } from '../logger/index.js';
import { parseProxyLine } from './proxy-pool.js';
import { profileDirFor, fingerprintSeedFor, fingerprintPlatform } from './linkedin-profile.js';

const log = createLogger('linkedin-browser');
const logProgress = (_scope, msg) => log.info(msg);

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
    // so these override the random default. The platform tracks the HOST OS
    // (fingerprintPlatform) so a Mac presents a native Mac device and a Windows
    // box a native Windows one. Legacy (no profileKey) left as-is.
    if (profileKey) {
        opts.args = [
            ...(opts.args ?? []),
            `--fingerprint=${fingerprintSeedFor(profileKey)}`,
            `--fingerprint-platform=${fingerprintPlatform()}`,
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
    // "Copy link to post" (the only post-permalink source in LinkedIn's Jul-2026
    // DOM) writes to the clipboard — grant read/write so resolvePostUrlViaMenu
    // can read it back. Best-effort (unit-test launcher fakes have no grant).
    try {
        await context.grantPermissions?.(
            ['clipboard-read', 'clipboard-write'], { origin: 'https://www.linkedin.com' });
    } catch { /* non-fatal */ }
    // Capture copied permalinks even when headless (clipboard.readText fails
    // without a focused clipboard). Best-effort.
    try { await context.addInitScript?.(CLIPBOARD_CAPTURE_INIT); } catch { /* non-fatal */ }
    logProgress('LinkedIn', '✅ CloakBrowser persistent profile ready');
    return context;
}
