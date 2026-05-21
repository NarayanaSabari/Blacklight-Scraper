#!/usr/bin/env node
// One-time (or as-needed) manual LinkedIn login into the PERSISTENT stealth
// profile the scraper uses. Opens a HEADED CloakBrowser on the same on-disk
// profile directory the scraper launches; you log in by hand; the session
// (cookies, localStorage) persists across scraper runs and rotates organically
// — no per-run cookie injection from the credentials API.
//
//   npm run linkedin:login
//
// The profile dir defaults to ~/.blacklight-linkedin-profile; override with
// LINKEDIN_PROFILE_DIR (must match what the scraper uses).
import readline from 'readline';
import { launchPersistentContext } from 'cloakbrowser';
import { linkedInProfileDir } from '../scrapers/linkedin.js';

async function main() {
    const userDataDir = linkedInProfileDir();
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
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

    console.log('\nLog in to LinkedIn in the opened browser window.');
    console.log('When you reach your feed (logged in), return here and press Enter to save + close.\n');
    await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Press Enter when logged in... ', () => { rl.close(); resolve(); });
    });

    await context.close();
    console.log('Profile saved. The scraper will reuse this logged-in session.');
}

main().catch((err) => { console.error('linkedin:login failed:', err); process.exit(1); });
