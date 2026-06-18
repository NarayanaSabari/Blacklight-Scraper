// Monster DataDome warm-up: opens a REAL (headed) browser window on a sticky
// proxy IP, using a persistent profile. You solve the "verify you are human"
// captcha by hand; DataDome then mints a valid `datadome` cookie bound to that
// IP + profile. The Monster scraper reuses the SAME profile + sticky IP
// (MONSTER_PROFILE_DIR) so it rides that trusted session past DataDome.
//
//   npm run monster:warm           # opens the window; solve the captcha
//   MONSTER_PROFILE_DIR=<dir> npm run monster:warm   # custom profile path
//
// Then scrape with:  MONSTER_PROFILE_DIR=<same dir> node ...getScraper('monster')
import os from 'node:os';
import { launchPersistentContext } from 'cloakbrowser';
import { getProxyPool } from '../src/core/proxy-pool.js';

const PROFILE = process.env.MONSTER_PROFILE_DIR || `${os.homedir()}/.blacklight-monster-profile`;
const SOLVE_MINUTES = Number.parseInt(process.env.MONSTER_WARM_MINUTES, 10) || 8;
const proxy = getProxyPool().sticky(Number.parseInt(process.env.MONSTER_STICKY_INDEX, 10) || 0);

console.log(`\n🌐 Opening Monster in a real browser window.`);
console.log(`   profile : ${PROFILE}`);
console.log(`   exit IP : ${proxy?.server || 'DIRECT — no proxy configured (warming your own IP!)'}`);
console.log(`   → In the window, solve the "verify you are human" captcha. I'll detect when jobs load (up to ${SOLVE_MINUTES} min).\n`);

const context = await launchPersistentContext({
    userDataDir: PROFILE,
    headless: false, // MUST be headed so you can interact
    humanize: true,
    geoip: true,
    ...(proxy ? { proxy } : {}),
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
});
const page = context.pages()[0] || await context.newPage();
try {
    await page.goto('https://www.monster.com/jobs/search?q=DevOps+Engineer&where=&page=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) { console.log('nav note:', e.message); }

const deadline = Date.now() + SOLVE_MINUTES * 60_000;
let solved = false;
while (Date.now() < deadline) {
    // "Warmed" = the page rendered PAST DataDome. That includes Monster's normal
    // "no jobs found" empty-results page (a filter artifact, not a block) — NOT
    // just job cards. Only a live captcha/challenge means not-yet-solved.
    const st = await page.evaluate(() => {
        const cards = document.querySelectorAll('article[data-testid="JobCard"], button[data-job-id]').length;
        const txt = document.body?.innerText || '';
        const loaded = cards > 0 || /no jobs found|search results for|jobs found/i.test(txt);
        const blocked = /verify you are human|complete the security check|access denied|unusual activity/i.test(txt)
            || location.href.includes('captcha-delivery');
        return { cards, loaded, blocked };
    }).catch(() => ({ loaded: false, blocked: false }));
    if (st.loaded && !st.blocked) { solved = true; break; }
    await page.waitForTimeout(3000);
}

if (solved) {
    const dd = (await context.cookies()).find((c) => /datadome/i.test(c.name));
    console.log(`\n✅ Captcha cleared — Monster job cards rendered. datadome cookie: ${dd ? 'PRESENT' : 'none'}.`);
    console.log(`   Profile saved to ${PROFILE}. The scraper can now reuse it:`);
    console.log(`   MONSTER_PROFILE_DIR=${PROFILE} (sticky IP ${proxy?.server || 'direct'})\n`);
    await page.waitForTimeout(4000); // let cookies flush to disk
} else {
    console.log(`\n⏱️  Timed out after ${SOLVE_MINUTES} min — captcha not solved (no job cards). Re-run when ready.\n`);
}
await context.close();
process.exit(solved ? 0 : 1);
