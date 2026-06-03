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

// Parses an aria-label of the form "<Title> at <Company>" into title + company.
// Returns null on any malformed input — the caller treats null as a
// dom_changed signal (Monster split the label or renamed the pattern).
// We use a strict regex (not split(' at ')) to ban silent garbage.
export function parseAriaLabel(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).trim();
    if (!s) return null;
    const m = s.match(/^(.+?)\s+at\s+(.+)$/);
    if (!m) return null;
    const title = m[1].trim();
    const company = m[2].trim();
    if (!title || !company) return null;
    return { title, company };
}

// Builds the canonical job URL. Prefers a real anchor href (the card's
// own <a>); falls back to constructing one from the data-job-id UUID.
// Returns null if neither is present — caller skips the row.
export function constructJobUrl(realHref, jobId) {
    const h = realHref ? String(realHref).trim() : '';
    if (h) {
        if (h.startsWith('http://') || h.startsWith('https://')) return h;
        if (h.startsWith('/')) return `https://www.monster.com${h}`;
    }
    const id = jobId ? String(jobId).trim() : '';
    if (id) return `https://www.monster.com/job-openings/${id}`;
    return null;
}

// Parses location + posted-date from a card's innerText. Handles both
// the joined "Redmond, WA7 days ago" layout (the probe observed) and
// the split-by-newline layout.
export function parseLocationDate(text) {
    const s = String(text ?? '');
    // location: "City, ST" (two-letter US state) OR the literal "Remote"
    const locRe = /(Remote|[A-Z][a-zA-Z .'-]+,\s*[A-Z]{2})/;
    const dateRe = /(\d+\s+(?:hour|day|week|month|min(?:ute)?)s?\s+ago)/i;
    const lm = s.match(locRe);
    const dm = s.match(dateRe);
    return {
        location: lm ? lm[1].trim() : '',
        datePosted: dm ? dm[1].trim() : '',
    };
}

// Parses a salary / pay band from innerText. Matches single values and
// ranges, with optional "/ Year|Hour|Month" suffix. Returns "" when
// absent (Monster doesn't always display pay).
export function parsePay(text) {
    const s = String(text ?? '');
    const re = /(\$[\d,]+(?:\s*[–\-]\s*\$[\d,]+)?(?:\s*\/\s*(?:Year|Hour|Month))?)/i;
    const m = s.match(re);
    return m ? m[1].trim() : '';
}

// Flag a card as a sponsored / promoted insertion. Today's marker is
// the word "Promoted" appearing in the card body.
export function isPromoted(text) {
    return /\bpromoted\b/i.test(String(text ?? ''));
}

// Extracts a single card from a DOM Element (browser or jsdom). Returns:
//   - a structured row object on success
//   - { __domChanged: true, reason } when the aria-label format breaks
//     (caller aggregates these to throw DomChangedError when > 50% fail)
//   - null when the row should be skipped silently (e.g. button missing
//     data-job-id — likely a UI artifact, not an actual job card)
export function extractCardFromElement(card) {
    if (!card || typeof card.querySelector !== 'function') return null;
    const btn = card.querySelector('button[data-job-id], button[aria-label]');
    if (!btn) return null;
    const aria = btn.getAttribute('aria-label');
    if (!aria) return { __domChanged: true, reason: 'no_aria_label' };
    const parsed = parseAriaLabel(aria);
    if (!parsed) return { __domChanged: true, reason: 'aria_label_format' };
    const jobId = btn.getAttribute('data-job-id') || '';
    if (!jobId) return null;
    const realAnchor = card.querySelector('a[href*="/job-openings/"]');
    const realHref = realAnchor ? realAnchor.getAttribute('href') : '';
    const url = constructJobUrl(realHref, jobId);
    if (!url) return null;
    const text = (card.textContent || '').trim();
    const { location, datePosted } = parseLocationDate(text);
    return {
        title: parsed.title,
        company: parsed.company,
        location,
        datePosted,
        salary: parsePay(text),
        jobId,
        url,
        description: text.slice(0, 800),
        isPromoted: isPromoted(text),
    };
}

// Pure page-state classifier. Caller collects {url, bodyText, cardCount,
// sawApiResponse} from the page and asks: what happened?
//   results          → real results page, cards are extractable
//   empty_confirmed  → real "0 results" page (no false alarm)
//   soft_blocked     → DataDome interstitial / verify-human page
//   dom_changed      → page rendered but the cards we expect are absent
//   network_error    → response gate didn't fire, nothing positive to report
export function classifyMonsterPage({ url, bodyText, cardCount, sawApiResponse }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/captcha-delivery\.com/i.test(u) ||
        /datadome|verify you are human|ray id|access denied/i.test(t)) {
        return { state: 'soft_blocked', signal: u.includes('captcha-delivery') ? 'captcha-delivery redirect' : 'datadome body text' };
    }
    if (cardCount > 0) {
        return { state: 'results', signal: `cards=${cardCount}` };
    }
    if (/no jobs (found|match)/i.test(t)) {
        return { state: 'empty_confirmed', signal: 'no-jobs-found text' };
    }
    if (sawApiResponse) {
        return { state: 'dom_changed', signal: 'appsapi responded but 0 cards rendered and no empty-results text' };
    }
    return { state: 'network_error', signal: 'no appsapi response, no positive page signal' };
}

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
