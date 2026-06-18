// Quick follow-up: does TechFetch anonymous search submit return results?
import fs from 'node:fs';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());

const log = (...a) => console.log('[anon-probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();

await page.goto('https://www.techfetch.com/js/js_s_jobs.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(2500);
await page.waitForSelector('#txtKeyword', { timeout: 8000 });
await page.fill('#txtKeyword', 'java developer');
log('submitting anonymous search...');
await page.click('input[type="submit"], button[type="submit"], #btnSearch');
await sleep(6000);

const shape = await page.evaluate(() => ({
    url: window.location.href.replace(/[?#].*$/, ''),
    redirectedToLogin: /login/i.test(window.location.href),
    jobRows: document.querySelectorAll('[id*="_divJob"]').length,
    hasLoadJobsFn: typeof window.LoadJobs === 'function',
    firstTitle: document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a')?.textContent?.trim()?.slice(0, 60) ?? null,
    firstHref: document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a')?.href?.slice(0, 110) ?? null,
    bodySnippet: (document.body?.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
}));
log('post-submit:', shape);

if (shape.jobRows > 0) {
    const cardHtml = await page.evaluate(() => document.querySelector('[id*="_divJob"]')?.outerHTML?.slice(0, 6000) ?? null);
    if (cardHtml) { fs.writeFileSync('/tmp/techfetch-card.html', cardHtml); log('saved /tmp/techfetch-card.html'); }
    fs.writeFileSync('/tmp/techfetch-list.html', await page.content());
    log('saved /tmp/techfetch-list.html');

    // try detail page anonymously
    if (shape.firstHref) {
        const d = await (await browser.contexts())[0].newPage();
        await d.goto(shape.firstHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        const dShape = await d.evaluate(() => ({
            url: window.location.href.replace(/[?#].*$/, ''),
            redirectedToLogin: /login/i.test(window.location.href),
            bytes: document.documentElement.outerHTML.length,
            hasDesc: !!document.querySelector('[id*="divDesc"], [id*="lblDesc"], [id*="JobDesc"], span#lblSpecSkill'),
        }));
        log('anonymous detail page:', dShape);
        if (!dShape.redirectedToLogin) { fs.writeFileSync('/tmp/techfetch-detail.html', await d.content()); log('saved /tmp/techfetch-detail.html'); }
    }

    // pagination
    const prevHref = shape.firstHref;
    await page.evaluate(() => { if (typeof window.LoadJobs === 'function') window.LoadJobs('/js/ajs_job_list.aspx?From=2'); });
    let swapped = false;
    try {
        await page.waitForFunction((prev) => {
            const a = document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a');
            return a && a.href !== prev;
        }, prevHref, { timeout: 12000 });
        swapped = true;
    } catch { /* */ }
    log('anonymous page-2 swap:', swapped);
}

await browser.close().catch(() => {});
process.exit(0);
