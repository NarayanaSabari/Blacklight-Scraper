#!/usr/bin/env node
// One-time (or as-needed) manual Indeed login into the PERSISTENT stealth
// profile the scraper uses. Opens a HEADED CloakBrowser on the same on-disk
// profile directory scrapeIndeed launches; you log in by hand; the session
// (cookies incl. cf_clearance, localStorage) persists across scraper runs and
// rotates organically — no per-run cookie injection from the credentials API.
//
//   npm run indeed:login
//
// The profile dir defaults to ~/.blacklight-indeed-profile; override with
// INDEED_PROFILE_DIR (must match what the scraper uses). Once logged in,
// scrapeIndeed automatically uses this profile for full pagination.
import readline from 'readline';
import { launchPersistentContext } from 'cloakbrowser';
import { indeedProfileDir } from '../scrapers/indeed.js';

async function main() {
    const userDataDir = indeedProfileDir();
    console.log(`Opening CloakBrowser persistent profile: ${userDataDir}`);
    const context = await launchPersistentContext({
        userDataDir,
        headless: false,
        humanize: true,
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://secure.indeed.com/account/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

    console.log('\nLog in to Indeed in the opened browser window.');
    console.log('When you reach your logged-in account (you can see your profile / saved jobs),');
    console.log('return here and press Enter to save + close.\n');
    await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Press Enter when logged in... ', () => { rl.close(); resolve(); });
    });

    await context.close();
    console.log('Profile saved. scrapeIndeed will reuse this logged-in session for full pagination.');
}

main().catch((err) => { console.error('indeed:login failed:', err); process.exit(1); });
