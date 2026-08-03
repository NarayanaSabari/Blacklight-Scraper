#!/usr/bin/env node
// One-time (or as-needed) manual LinkedIn login into the PERSISTENT stealth
// profile the scraper uses. Opens a HEADED CloakBrowser on the same on-disk
// profile directory the scraper launches; you log in by hand; the session
// (cookies, localStorage) persists across scraper runs and rotates organically
// — no per-run cookie injection from the credentials API.
//
// Fully interactive — run `npm run linkedin:login` and answer the prompts:
//   • CloakBrowser licence key — asked ONLY when none is configured. Free, and
//     it upgrades the stealth binary from Chromium v146 to v150; without it
//     LinkedIn's login tends to serve an unsolvable reCAPTCHA loop. The command
//     also updates the cloakbrowser package itself when a newer one exists.
//   • Account / profile key — blank for the default single profile, or a
//     profile_key to open the pinned-fingerprint per-account profile.
//   • Proxy (only asked WHEN a profile key is given) — host:port:user:pass to
//     route the login through, or blank for direct.
//
// Why the proxy is gated behind a profile key: the scraper only applies a proxy
// on the per-account path (linkedin-session.js: perAccount = !!profile_key). A
// proxy entered without a profile key would be used at LOGIN but ignored at
// SCRAPE — logging in through a proxy IP and then scraping from the host IP
// trips LinkedIn's "confirm it's you" challenge (login IP ≠ scrape IP).
//
// The profile dir defaults to ~/.blacklight-linkedin-profile; override with
// LINKEDIN_PROFILE_DIR (must match what the scraper uses).
import {
    resolveLoginProfileDir, openLoginBrowser, captureSession, closeLoginBrowser,
} from '../src/core/linkedin-login-flow.js';
import { saveLinkedinCredential } from '../src/setup/linkedin-credential.js';
import { defaultAsk } from '../src/setup/io.js';
import { cloakbrowserPreflight } from '../src/setup/cloakbrowser-preflight.js';

// Collect the login config interactively. `ask` is injected (the EOF-safe
// prompt from src/setup/io.js in production; a fake in tests). No browser or
// network here. The proxy question is ONLY asked when a profile key was
// entered — see the gating rationale in the file header.
export async function promptConfig(ask) {
    const acct = await ask('Account / profile key (blank = default single profile):');
    const profileKey = acct && String(acct).trim() ? String(acct).trim() : null;
    let proxy = null;
    if (profileKey) {
        const px = await ask('Proxy host:port:user:pass (blank = direct):');
        proxy = px && String(px).trim() ? String(px).trim() : null;
    }
    return { profileKey, proxy };
}

async function main() {
    const ask = defaultAsk();
    try {
        // Before opening any window: make sure CloakBrowser is current and
        // licensed. An unlicensed CloakBrowser runs Chromium v146 against a
        // v150 world, which is what makes LinkedIn's login serve an
        // unsolvable reCAPTCHA loop. See src/setup/cloakbrowser-preflight.js.
        await cloakbrowserPreflight({ ask, cwd: process.cwd() });

        const { profileKey, proxy } = await promptConfig(ask);

        // resolveLoginProfileDir is the SAME resolver the scraper itself uses
        // (profileDirFor) — this print is exactly where the login will land.
        const userDataDir = resolveLoginProfileDir({ profileKey });
        if (profileKey) {
            // Per-account path: pinned fingerprint + per-account profile dir + proxy.
            // openLoginBrowser reads LINKEDIN_HEADLESS; when unset (the normal
            // operator case) it launches HEADED — exactly what we want.
            console.log(`Opening CloakBrowser persistent profile for account: ${profileKey} (${userDataDir})`);
            if (proxy) console.log(`  Routing through proxy: ${proxy}`);
        } else {
            // Legacy path: single local profile, byte-identical to the pre-rotation
            // manual-login D1b model.
            console.log(`Opening CloakBrowser persistent profile: ${userDataDir}`);
        }
        const { context, page } = await openLoginBrowser({ profileKey, proxy });

        // A navigation failure here used to be swallowed silently, leaving the
        // operator staring at a blank browser with no idea why. Surface it —
        // the browser is still usable, the operator can navigate manually.
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' })
            .catch((err) => console.warn(`Could not navigate to the LinkedIn login page: ${err.message}`));

        console.log('\nLog in to LinkedIn in the opened browser window.');
        console.log('When you reach your feed (logged in), return here and press Enter to save + close.\n');
        await ask('Press Enter when logged in...');

        // Pull the session cookies from the logged-in profile BEFORE closing, so we
        // can verify the login and register the local `linkedin` credential the
        // scraper's per-scrape lease needs. Without it, scrapes fail with
        // "No LinkedIn credential available from API" despite a valid profile.
        const { cookies, error: captureError } = await captureSession({ context });
        if (captureError) {
            console.warn(`Could not read cookies from the profile: ${captureError}`);
        }
        await closeLoginBrowser({ context });
        console.log('Profile saved. The scraper will reuse this logged-in session.');

        if (profileKey) {
            // Per-account: print next-step message for the operator.
            // The credential is marked 'available' via centralD (Task 11) —
            // no backend POST here (that endpoint is Task 10).
            console.log(`\nAccount ${profileKey} logged in — mark it 'available' in centralD (Credentials) to put it back in rotation.`);
        } else {
            // Legacy path: save the local credential as before.
            const result = saveLinkedinCredential({ cwd: process.cwd(), cookies });
            if (!result.saved) return 1;
        }
        return 0;
    } finally {
        ask.close();
    }
}

// Only run when invoked directly (not when imported by tests).
const _isMain = process.argv[1] &&
    (await import('url')).fileURLToPath(import.meta.url) === process.argv[1];
if (_isMain) {
    main()
        .then((code) => process.exit(code ?? 0))
        .catch((err) => { console.error('linkedin:login failed:', err); process.exit(1); });
}
