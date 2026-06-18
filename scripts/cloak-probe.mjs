// CloakBrowser proof-of-concept
//
// Launches the stealth Chromium and visits the same protected pages
// we've been getting blocked on (monster, glassdoor, indeed). For each
// site we log the final URL, page title, and a few signals that tell
// us whether the bot-detection wall was hit:
//   - is the URL still on a captcha/challenge host?
//   - does the page title look like a real search results page?
//   - are there >0 job-card-looking elements on the page?
//
// Headed (visible) so we can eyeball it on the first run. Switch
// HEADLESS=true to confirm headless works too.

import { launch } from 'cloakbrowser';

const HEADLESS = process.env.HEADLESS === 'true';
const HUMANIZE = process.env.HUMANIZE !== 'false'; // default on
const PROBES = [
    {
        name: 'monster',
        url: 'https://www.monster.com/jobs/search?q=Java+Developer&where=United+States&page=1&recency=last+week',
        successHint: '/jobs/search',
        blockHints: ['captcha-delivery.com', 'datadome', '/captcha/'],
        countSelector: 'a[href*="/job-openings/"], article[data-test="job-card"]',
    },
    {
        name: 'glassdoor',
        url: 'https://www.glassdoor.com/Job/jobs.htm?sc.keyword=Java+Developer&locT=N&locId=&jobType=&context=Jobs&sc.location=United+States&fromAge=7',
        successHint: '/Job/jobs.htm',
        blockHints: ['challenges.cloudflare.com', 'cf-chl', 'Just a moment'],
        countSelector: '[data-test="jobListing"], li[data-test="jobListing"]',
    },
    {
        name: 'indeed',
        url: 'https://www.indeed.com/jobs?q=Java+Developer&l=United+States&fromage=7&sort=date',
        successHint: '/jobs?',
        blockHints: ['challenges.cloudflare.com', 'cf-chl', 'verify you are human'],
        countSelector: 'a[data-jk], li[data-jk], .job_seen_beacon, [data-testid="job-card"]',
    },
    {
        name: 'linkedin-public',
        url: 'https://www.linkedin.com/jobs/search?keywords=Java%20Developer&location=United%20States',
        successHint: '/jobs/search',
        blockHints: ['/authwall', '/uas/login', 'Sign in'],
        countSelector: '[data-job-id], a[href*="/jobs/view/"]',
    },
    {
        name: 'browserscan',
        url: 'https://www.browserscan.net/bot-detection',
        successHint: 'bot-detection',
        blockHints: [],
        countSelector: 'body',
    },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function probe(browser, p) {
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    const t0 = Date.now();
    let result = { name: p.name, url: p.url };
    try {
        const resp = await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(5000); // settle, let lazy-loaded content fire
        result.status = resp?.status() ?? null;
        result.finalUrl = page.url();
        result.title = (await page.title()).slice(0, 120);

        // Body content sniff
        const bodyText = (await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '')) || '';
        result.bodyHead = bodyText.replace(/\s+/g, ' ').slice(0, 200);

        // Block-hint detection
        result.blocked = p.blockHints.some((h) =>
            result.finalUrl.toLowerCase().includes(h.toLowerCase()) ||
            result.title.toLowerCase().includes(h.toLowerCase()) ||
            bodyText.toLowerCase().includes(h.toLowerCase()));

        // Success-hint
        result.onTarget = result.finalUrl.includes(p.successHint);

        // Job card count
        try {
            result.cards = await page.evaluate((sel) => document.querySelectorAll(sel).length, p.countSelector);
        } catch { result.cards = -1; }
        result.tookMs = Date.now() - t0;
    } catch (e) {
        result.error = e.message?.slice(0, 200);
        result.tookMs = Date.now() - t0;
    } finally {
        try { await context.close(); } catch { /* noop */ }
    }
    return result;
}

(async () => {
    console.log(`\n=== CloakBrowser probe — headless=${HEADLESS} humanize=${HUMANIZE} ===\n`);

    const browser = await launch({
        headless: HEADLESS,
        humanize: HUMANIZE,
    });

    const results = [];
    for (const p of PROBES) {
        console.log(`→ ${p.name}`);
        const r = await probe(browser, p);
        results.push(r);
        console.log(`  finalUrl: ${r.finalUrl?.slice(0, 110) || r.error}`);
        console.log(`  title:    ${r.title || '-'}`);
        console.log(`  status:   ${r.status ?? '-'}    onTarget=${!!r.onTarget}    blocked=${!!r.blocked}    cards=${r.cards}`);
        if (r.bodyHead) console.log(`  body:     ${r.bodyHead}…`);
        console.log('');
    }

    console.log('=== SUMMARY ===');
    console.table(results.map((r) => ({
        site: r.name,
        status: r.status ?? '-',
        onTarget: r.onTarget ?? '-',
        blocked: r.blocked ?? '-',
        cards: r.cards ?? '-',
        ms: r.tookMs,
    })));

    await sleep(5000);
    await browser.close();
})().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
