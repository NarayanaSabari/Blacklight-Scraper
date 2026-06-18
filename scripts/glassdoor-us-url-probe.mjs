// Quick follow-up: can the canonical SRCH URL force US results from a non-US IP?
import fs from 'node:fs';
import { launch } from 'cloakbrowser';
const log = (...a) => console.log('[us-probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "united-states" (13 chars) + "software-engineer" (17) → SRCH_IL.0,13_IN1_KO14,31
const US_URL = 'https://www.glassdoor.com/Job/united-states-software-engineer-jobs-SRCH_IL.0,13_IN1_KO14,31.htm?fromAge=7';

const browser = await launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York' })).newPage();
await page.goto(US_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(8000);
const shape = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.jobCard')];
    return {
        finalUrl: window.location.href.slice(0, 120),
        stayedOnCom: window.location.hostname === 'www.glassdoor.com',
        cardCount: cards.length,
        locations: cards.slice(0, 12).map((c) => c.querySelector('[data-test="emp-location"]')?.textContent?.trim() ?? '?'),
    };
});
log(JSON.stringify(shape, null, 2));
fs.writeFileSync('/tmp/glassdoor-us-forced.html', await page.content());
await browser.close().catch(() => {});
process.exit(0);
