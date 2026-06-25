#!/usr/bin/env node
// One-time (or as-needed) manual LinkedIn login into the PERSISTENT stealth
// profile the scraper uses. Opens a HEADED CloakBrowser on the same on-disk
// profile directory the scraper launches; you log in by hand; the session
// (cookies, localStorage) persists across scraper runs and rotates organically
// — no per-run cookie injection from the credentials API.
//
// Legacy (no --account): single local profile
//   npm run linkedin:login
//
// Per-account (pool rotation): opens the pinned-fingerprint profile for <key>
//   npm run linkedin:login -- --account <profile_key>
//   npm run linkedin:login -- --account <profile_key> --proxy host:port:user:pass
//
// The profile dir defaults to ~/.blacklight-linkedin-profile; override with
// LINKEDIN_PROFILE_DIR (must match what the scraper uses).
import readline from 'readline';
import { launchPersistentContext } from 'cloakbrowser';
import { linkedInProfileDir, launchPersistentProfile } from '../scrapers/linkedin.js';
import { saveLinkedinCredential } from '../src/setup/linkedin-credential.js';

// Pure arg parser — exported for unit tests.
// Reads --account <key> and --proxy <value> from an argv array (no process.argv
// slicing — callers pass what they need). Unknown flags are silently ignored.
export function parseLoginArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    let profileKey = null;
    let proxy = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--account' && i + 1 < args.length) {
            profileKey = args[i + 1];
            i++;
        } else if (args[i] === '--proxy' && i + 1 < args.length) {
            proxy = args[i + 1];
            i++;
        }
    }
    return { profileKey, proxy };
}

async function main() {
    const { profileKey, proxy } = parseLoginArgs(process.argv.slice(2));

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
    await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Press Enter when logged in... ', () => { rl.close(); resolve(); });
    });

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
        if (!result.saved) {
            process.exit(1);
        }
    }
}

// Only run when invoked directly (not when imported by tests).
const _isMain = process.argv[1] &&
    (await import('url')).fileURLToPath(import.meta.url) === process.argv[1];
if (_isMain) {
    main().catch((err) => { console.error('linkedin:login failed:', err); process.exit(1); });
}
