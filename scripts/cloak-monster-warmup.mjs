// Test if a warmup visit to monster.com homepage unblocks the
// search-results page that returned 403 on direct-touch.

import { launch } from 'cloakbrowser';
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
    const browser = await launch({ headless: false, humanize: true });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    const page = await context.newPage();

    // Step 1: warmup
    console.log('→ visiting monster.com homepage…');
    const h = await page.goto('https://www.monster.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(7000);
    console.log(`  homepage status=${h?.status()} url=${page.url()} title="${(await page.title()).slice(0,80)}"`);

    // Step 2: search
    console.log('→ navigating to search…');
    const s = await page.goto(
        'https://www.monster.com/jobs/search?q=Java+Developer&where=United+States&page=1&recency=last+week',
        { waitUntil: 'domcontentloaded', timeout: 45000 },
    );
    await sleep(8000);
    console.log(`  search status=${s?.status()} url=${page.url()} title="${(await page.title()).slice(0,80)}"`);

    const stats = await page.evaluate(() => {
        const sel = (s) => document.querySelectorAll(s).length;
        return {
            bodyHead: (document.body?.innerText || '').slice(0, 300).replace(/\s+/g, ' '),
            jobCards_a: sel('a[href*="/job-openings/"]'),
            jobCards_article: sel('article'),
            jobCards_li: sel('main li, [data-test*="job"]'),
            anyDatadome: document.body?.innerText?.toLowerCase().includes('captcha') || false,
        };
    });
    console.log('\n=== RESULT ===');
    console.log(`body head: ${stats.bodyHead.slice(0, 200)}…`);
    console.log(`a[/job-openings/]: ${stats.jobCards_a}`);
    console.log(`<article>:         ${stats.jobCards_article}`);
    console.log(`main li:           ${stats.jobCards_li}`);
    console.log(`captcha keyword:   ${stats.anyDatadome}`);

    await sleep(20000);
    await browser.close();
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
