#!/usr/bin/env node
// One-time (or as-needed) manual LinkedIn login into the PERSISTENT stealth
// profile the scraper uses. Opens a HEADED CloakBrowser on the same on-disk
// profile directory the scraper launches; you log in by hand; the session
// (cookies, localStorage) persists across scraper runs and rotates organically
// — no per-run cookie injection from the credentials API.
//
// Fully interactive — run `npm run linkedin:login` and answer the prompts:
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
import { launchPersistentContext } from 'cloakbrowser';
import { linkedInProfileDir, launchPersistentProfile } from '../scrapers/linkedin.js';
import { saveLinkedinCredential } from '../src/setup/linkedin-credential.js';
import { defaultAsk } from '../src/setup/io.js';

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
        const { profileKey, proxy } = await promptConfig(ask);

        let context;
        if (profileKey) {
            // Per-account path: pinned fingerprint + per-account profile dir + proxy.
            // launchPersistentProfile reads LINKEDIN_HEADLESS; when unset (the
            // normal operator case) it launches HEADED — exactly what we want.
            console.log(`Opening CloakBrowser persistent profile for account: ${profileKey}`);
            if (proxy) console.log(`  Routing through proxy: ${proxy}`);
            context = await launchPersistentProfile({ profileKey, proxy });
        } else {
            // Legacy path: single local profile, byte-identical to the pre-rotation
            // manual-login D1b model.
            const userDataDir = linkedInProfileDir();
            console.log(`Opening CloakBrowser persistent profile: ${userDataDir}`);
            context = await launchPersistentContext({
                userDataDir,
                headless: false,
                humanize: true,
                viewport: { width: 1366, height: 900 },
                locale: 'en-US',
                timezoneId: 'America/New_York',
            });
        }

        const page = context.pages()[0] || await context.newPage();
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

        console.log('\nLog in to LinkedIn in the opened browser window.');
        console.log('When you reach your feed (logged in), return here and press Enter to save + close.\n');
        await ask('Press Enter when logged in...');

        // Pull the session cookies from the logged-in profile BEFORE closing, so we
        // can verify the login and register the local `linkedin` credential the
        // scraper's per-scrape lease needs. Without it, scrapes fail with
        // "No LinkedIn credential available from API" despite a valid profile.
        let cookies = [];
        try {
            cookies = await context.cookies();
        } catch (err) {
            console.warn(`Could not read cookies from the profile: ${err.message}`);
        }
        await context.close();
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
