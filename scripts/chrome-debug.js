#!/usr/bin/env node
// Launches Chrome with a remote debugging port so the LinkedIn scraper
// can connect over CDP. Idempotent — if a Chrome is already listening
// on the target port, this script is a no-op and prints guidance.
//
// Usage (from Job-Scraper/):
//   npm run chrome:login
//
// Env overrides (all optional):
//   CHROME_PATH           — absolute path to the Chrome binary
//                           (defaults to the platform's standard install location)
//   CDP_PORT              — remote debugging port (default: 9222)
//   CHROME_DEBUG_PROFILE  — user-data-dir path (default: ~/chrome-debug-profile)
//   CHROME_DEBUG_URL      — URL to open on launch (default: linkedin.com/feed)
//
// Why a separate profile: the --remote-debugging-port flag is ignored by
// Chrome if the target user-data-dir is already in use by a normal Chrome
// session. Keeping the scraper's Chrome in its own profile directory lets
// you run your regular Chrome and the scraper Chrome side-by-side.

import { spawn } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';

const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE_DIR = process.env.CHROME_DEBUG_PROFILE
    || path.join(os.homedir(), 'chrome-debug-profile');
const TARGET_URL = process.env.CHROME_DEBUG_URL || 'https://www.linkedin.com/feed/';

function resolveChromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    if (process.platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    if (process.platform === 'win32') {
        return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    }
    return '/usr/bin/google-chrome';
}

function isCdpReady(port) {
    return new Promise((resolve) => {
        const req = http.get(
            { host: '127.0.0.1', port, path: '/json/version', timeout: 1500 },
            (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function waitForCdp(port, maxMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        if (await isCdpReady(port)) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

async function main() {
    if (await isCdpReady(PORT)) {
        console.log(`✓ Chrome already running on port ${PORT}`);
        console.log(`  Profile dir: ${PROFILE_DIR}`);
        console.log();
        console.log('If you need to log in:');
        console.log('  1. Focus the existing Chrome window');
        console.log('  2. Or open a new tab and go to linkedin.com/feed');
        console.log();
        console.log('To force-restart Chrome:');
        console.log(`  pkill -f "chrome-debug-profile" && npm run chrome:login`);
        return;
    }

    const chromeBin = resolveChromePath();
    console.log('Starting Chrome with remote debugging...');
    console.log(`  binary:   ${chromeBin}`);
    console.log(`  port:     ${PORT}`);
    console.log(`  profile:  ${PROFILE_DIR}`);
    console.log(`  opens:    ${TARGET_URL}`);

    const child = spawn(
        chromeBin,
        [
            `--remote-debugging-port=${PORT}`,
            `--user-data-dir=${PROFILE_DIR}`,
            TARGET_URL,
        ],
        { detached: true, stdio: 'ignore' },
    );
    child.on('error', (err) => {
        console.error();
        console.error(`✗ Failed to spawn Chrome: ${err.message}`);
        console.error(`  Tried binary: ${chromeBin}`);
        console.error('  Tips:');
        console.error('    - Install Google Chrome if missing');
        console.error('    - Or set CHROME_PATH to your Chrome binary path');
        process.exit(1);
    });
    child.unref();

    console.log();
    console.log('Waiting for Chrome to become reachable on CDP port...');
    if (!(await waitForCdp(PORT, 10_000))) {
        console.error(`✗ Chrome did not respond on port ${PORT} within 10 seconds`);
        console.error('  The process may have crashed or the port may be blocked.');
        process.exit(1);
    }

    console.log(`✓ Chrome ready on port ${PORT}`);
    console.log();
    console.log('Next steps:');
    console.log('  1. Log into LinkedIn in the Chrome window that just opened');
    console.log('  2. If LinkedIn shows a security challenge, solve it manually');
    console.log('  3. Verify you reach linkedin.com/feed without redirect');
    console.log('  4. Keep the window open and run:');
    console.log('       npm start                      # full fleet');
    console.log('     or');
    console.log(`       curl -X POST http://localhost:3001/scrape \\`);
    console.log(`         -H "Content-Type: application/json" \\`);
    console.log(`         -d '{"platform":"linkedin","jobTitle":"DevOps Engineer","location":"california"}'`);
    console.log();
    console.log('The profile at', PROFILE_DIR, 'persists cookies across restarts,');
    console.log('so subsequent launches will remember your LinkedIn session.');
}

main().catch((err) => {
    console.error('chrome-debug: unhandled error');
    console.error(err);
    process.exit(1);
});
