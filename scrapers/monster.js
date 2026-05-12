// Monster Job Scraper Module
//
// Switched from raw-HTTP-against-Monster's-internal-API to browser-DOM
// scraping via CloakBrowser. Reason: Monster's API (appsapi.monster.io)
// is fronted by DataDome which flags any non-browser request within
// ~12-24h, requiring constant cookie + clientid rotation. CloakBrowser's
// stealth Chromium passes DataDome cleanly — the only thing we need is
// a homepage warmup, then the search URL renders normally.
//
// Trade-off: scrape is slower (multi-second page navigation per page vs
// sub-second API call) but stable. The 100-jobs-per-role ceiling we had
// from the API is roughly the same as the DOM ceiling, just paginated
// via &page=N.

import { launch } from 'cloakbrowser';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';

const log = createLogger('monster');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// First-touch on /jobs/search returns 403 from DataDome on a brand-new
// session. A brief visit to monster.com first establishes cookies and
// lets the subsequent search-page navigation through.
async function warmup(page) {
    log.info('Warmup: visiting monster.com homepage');
    const resp = await page.goto('https://www.monster.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
    });
    await sleep(3000 + Math.random() * 2000);
    log.info(`Warmup complete (status ${resp?.status() ?? '?'})`);
}

async function extractJobsFromCurrentPage(page) {
    return page.evaluate(() => {
        // Monster job cards anchor to /job-openings/<id>. The anchor's
        // ancestor <article> (or fallback container) carries the
        // displayed title, company, location, and time-posted info.
        const cards = Array.from(document.querySelectorAll('a[href*="/job-openings/"]'));
        const seen = new Set();
        const results = [];
        for (const a of cards) {
            const href = a.href;
            if (!href || seen.has(href)) continue;
            seen.add(href);

            const container = a.closest('article, [data-test*="JobCard"], li, div[role="article"]') || a.parentElement || a;
            const fullText = (container.innerText || '').trim();
            const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);

            // Most Monster cards lay out as:
            //   line 0: <Job Title>
            //   line 1: <Company Name>
            //   line 2: <Location>  (sometimes plus "Remote" tag)
            //   line 3: <Time posted, e.g. "2 days ago">
            // Plus extra noise (save button labels, salary banners).
            const title = lines[0] || a.getAttribute('aria-label') || a.innerText.trim();
            const company = lines[1] || '';
            const locationStr = lines[2] || '';
            const datePosted = lines.find((l) => /\b(day|hour|week|min)/i.test(l)) || '';

            results.push({
                title,
                company,
                location: locationStr,
                url: href,
                datePosted,
                description: fullText.slice(0, 1000),
            });
        }
        return results;
    });
}

export async function scrapeMonster(jobTitle, location, sessionId = null) {
    void sessionId; // CloakBrowser anonymous launches don't need credentials.
    log.info(`Searching for "${jobTitle}" in "${location}"`);

    log.info('🚀 Launching CloakBrowser stealth Chromium...');
    // humanize: true is REQUIRED for monster — DataDome scores the
    // behavioral signals (timing, mouse curves, scroll patterns) in
    // addition to fingerprints. headless without humanize returns 403
    // on monster.com's homepage too. Confirmed via warmup probe.
    const browser = await launch({ headless: true, humanize: true });

    try {
        const context = await browser.newContext({
            viewport: { width: 1366, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
        const page = await context.newPage();

        await warmup(page);

        const maxJobs = 100;
        const maxPages = 5;
        const seenUrls = new Set();
        const allJobs = [];
        let consecutiveEmptyPages = 0;

        for (let pageNum = 1; pageNum <= maxPages && allJobs.length < maxJobs; pageNum++) {
            const searchUrl =
                `https://www.monster.com/jobs/search` +
                `?q=${encodeURIComponent(jobTitle)}` +
                `&where=${encodeURIComponent(location)}` +
                `&page=${pageNum}` +
                `&recency=last+week` +
                `&so=m.s.sh`;
            log.info(`Fetching page ${pageNum}: ${searchUrl}`);

            const resp = await page.goto(searchUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 45000,
            });
            await sleep(4000 + Math.random() * 2000);

            if (resp && resp.status() >= 400) {
                throw new Error(`Search page returned ${resp.status()} on page ${pageNum}`);
            }

            const rawJobs = await extractJobsFromCurrentPage(page);
            let newCount = 0;
            for (const j of rawJobs) {
                if (!j.url || seenUrls.has(j.url)) continue;
                seenUrls.add(j.url);

                allJobs.push(normalizeJobData({
                    title: j.title,
                    url: j.url,
                    description: j.description,
                    datePosted: j.datePosted,
                    hiringOrganization: j.company,
                    jobLocation: j.location,
                }, 'Monster'));
                newCount++;
                if (allJobs.length >= maxJobs) break;
            }
            log.info(`Page ${pageNum}: ${rawJobs.length} cards on page, ${newCount} new unique, total: ${allJobs.length}`);

            if (newCount === 0) {
                consecutiveEmptyPages++;
                if (consecutiveEmptyPages >= 2) {
                    log.info('No new jobs across 2 consecutive pages — search exhausted.');
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
            }
        }

        const jobsToReturn = allJobs.slice(0, maxJobs);
        log.info(`Completed! Found ${jobsToReturn.length} unique jobs`);
        return jobsToReturn;
    } finally {
        try { await browser.close(); } catch { /* already closed */ }
    }
}
