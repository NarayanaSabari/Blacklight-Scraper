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
import { BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';

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
        if (h.startsWith('//')) return `https:${h}`;
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

// Inspects the body of a Monster appsapi search-jobs POST response.
// Returns one of:
//   'has-jobs'      → response has at least one job in any known result array
//   'empty-payload' → known result key present but empty, OR body empty/nullish
//   'unparseable'   → JSON.parse threw
//   'unknown-shape' → parses to an object but no known result key is present
// The classifier uses this to distinguish a DataDome empty-payload soft-block
// from a real DOM change (cards missing because Monster renamed the selector).
export function inspectAppsapiBody(text) {
    if (text === null || text === undefined || text === '') return 'empty-payload';
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return 'unparseable'; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'unknown-shape';
    }
    const known = [
        parsed.jobResults,
        parsed.jobs,
        parsed.results,
        parsed.searchResults?.jobs,
    ];
    let anyKeyPresent = false;
    for (const v of known) {
        if (Array.isArray(v)) {
            anyKeyPresent = true;
            if (v.length > 0) return 'has-jobs';
        }
    }
    return anyKeyPresent ? 'empty-payload' : 'unknown-shape';
}

// Pure page-state classifier. Caller collects {url, bodyText, cardCount,
// sawApiResponse, apiResponseInspection} from the page and asks: what happened?
//   results          → real results page, cards are extractable
//   empty_confirmed  → real "0 results" page (no false alarm)
//   soft_blocked     → DataDome interstitial / verify-human page
//   dom_changed      → page rendered but the cards we expect are absent
//   network_error    → response gate didn't fire, nothing positive to report
export function classifyMonsterPage({ url, bodyText, cardCount, sawApiResponse, apiResponseInspection }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/captcha-delivery\.com/i.test(u) ||
        /datadome|verify you are human|ray id|access denied/i.test(t)) {
        return { state: 'soft_blocked', signal: u.includes('captcha-delivery') ? 'captcha-delivery redirect' : 'datadome body text' };
    }
    if (apiResponseInspection === 'empty-payload' && cardCount === 0 && !/no jobs (found|match)/i.test(t)) {
        return { state: 'soft_blocked', signal: 'appsapi returned empty payload (DataDome silent suppress)' };
    }
    if (cardCount > 0) {
        return { state: 'results', signal: `cards=${cardCount}` };
    }
    if (/no jobs (found|match)/i.test(t)) {
        return { state: 'empty_confirmed', signal: 'no-jobs-found text' };
    }
    if (apiResponseInspection === 'has-jobs' && cardCount === 0) {
        return { state: 'dom_changed', signal: 'appsapi has jobs but 0 cards rendered (likely selector rename)' };
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

const CONFIG = {
    MAX_PAGES: 5,
    MAX_JOBS: 100,
    MIN_PAGE_SPACING_MS: 3000,
    MAX_PAGE_SPACING_MS: 5000,
    NAV_TIMEOUT_MS: 30000,
    API_RESPONSE_TIMEOUT_MS: 15000,
    CARD_SELECTOR_TIMEOUT_MS: 5000,
};

export function searchUrl(jobTitle, location, pageNum) {
    return `https://www.monster.com/jobs/search` +
        `?q=${encodeURIComponent(jobTitle)}` +
        `&where=${encodeURIComponent(location)}` +
        `&page=${pageNum}`;
}

export async function scrapeMonster(jobTitle, location, sessionId = null) {
    void sessionId;
    log.info(`Searching for "${jobTitle}" in "${location}"`);
    log.info('🚀 Launching CloakBrowser stealth Chromium...');
    const browser = await launch({ headless: true, humanize: true });
    const allJobs = [];
    let collectedAnything = false;
    try {
        const context = await browser.newContext({
            viewport: { width: 1366, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
        const page = await context.newPage();
        await warmup(page);

        const seen = new Set();
        let consecutiveEmpty = 0;

        for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES && allJobs.length < CONFIG.MAX_JOBS; pageNum++) {
            const url = searchUrl(jobTitle, location, pageNum);
            log.info(`Fetching page ${pageNum}: ${url}`);

            // Gate the navigation on the appsapi POST as our "page is alive" signal.
            // waitForResponse is set up BEFORE goto so we don't miss the early fire.
            const apiResponsePromise = page.waitForResponse(
                (r) => r.url().includes('/jobs-svx-service/v2/monster/search-jobs/') && r.request().method() === 'POST',
                { timeout: CONFIG.API_RESPONSE_TIMEOUT_MS },
            ).then(() => true).catch(() => false);
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT_MS });
            } catch (e) {
                if (allJobs.length >= 1) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new NetworkError(`Monster page.goto failed: ${e.message}`, { platform: 'monster', cause: e });
            }
            const sawApiResponse = await apiResponsePromise;

            // Soft-wait for cards to render (best effort — classifier owns the verdict).
            await page.waitForSelector('article[data-testid="JobCard"]', { timeout: CONFIG.CARD_SELECTOR_TIMEOUT_MS }).catch(() => {});

            const probe = await page.evaluate(() => ({
                bodyText: (document.body?.innerText || '').slice(0, 4000),
                cardCount: document.querySelectorAll('article[data-testid="JobCard"]').length,
            }));
            const verdict = classifyMonsterPage({
                url: page.url(),
                bodyText: probe.bodyText,
                cardCount: probe.cardCount,
                sawApiResponse,
            });
            log.info(`Page ${pageNum} classified: ${verdict.state} (${verdict.signal})`);

            if (verdict.state === 'soft_blocked') {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new BlockedError(`Monster blocked: ${verdict.signal}`, { platform: 'monster', kind: 'datadome' });
            }
            if (verdict.state === 'dom_changed') {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(`Monster DOM changed: ${verdict.signal}`, { platform: 'monster' });
            }
            if (verdict.state === 'network_error') {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new NetworkError(`Monster page didn't load: ${verdict.signal}`, { platform: 'monster' });
            }
            if (verdict.state === 'empty_confirmed') {
                consecutiveEmpty++;
                if (consecutiveEmpty >= 2) break;
                await sleep(CONFIG.MIN_PAGE_SPACING_MS + Math.random() * (CONFIG.MAX_PAGE_SPACING_MS - CONFIG.MIN_PAGE_SPACING_MS));
                continue;
            }

            // results — extract.
            const raw = await page.evaluate(() => {
                function extractInPage(card) {
                    const btn = card.querySelector('button[data-job-id], button[aria-label]');
                    if (!btn) return null;
                    const aria = btn.getAttribute('aria-label');
                    if (!aria) return { __domChanged: true, reason: 'no_aria_label' };
                    const m = aria.trim().match(/^(.+?)\s+at\s+(.+)$/);
                    if (!m) return { __domChanged: true, reason: 'aria_label_format' };
                    const title = m[1].trim(); const company = m[2].trim();
                    const jobId = btn.getAttribute('data-job-id') || '';
                    if (!title || !company || !jobId) return null;
                    const a = card.querySelector('a[href*="/job-openings/"]');
                    const realHref = a ? a.getAttribute('href') : '';
                    return {
                        title, company, jobId, realHref,
                        text: (card.innerText || card.textContent || '').trim().slice(0, 4000),
                    };
                }
                const cards = [...document.querySelectorAll('article[data-testid="JobCard"]')];
                return cards.map(extractInPage);
            });

            // Aggregate domChanged + finish parsing in Node (so the pure helpers stay testable)
            let cardDomChanged = 0;
            let newCount = 0;
            for (const r of raw) {
                if (!r) continue;
                if (r.__domChanged) { cardDomChanged++; continue; }
                const builtUrl = constructJobUrl(r.realHref, r.jobId);
                if (!builtUrl || seen.has(builtUrl)) continue;
                seen.add(builtUrl);
                const { location: loc, datePosted } = parseLocationDate(r.text);
                allJobs.push(normalizeJobData({
                    title: r.title,
                    hiringOrganization: r.company,
                    jobLocation: loc,
                    url: builtUrl,
                    datePosted,
                    salary: parsePay(r.text),
                    description: r.text.slice(0, 800),
                    isPromoted: isPromoted(r.text),
                }, 'Monster'));
                newCount++;
                if (allJobs.length >= CONFIG.MAX_JOBS) break;
            }
            collectedAnything = collectedAnything || allJobs.length > 0;

            if (cardDomChanged > 0 && cardDomChanged >= Math.ceil(raw.length / 2)) {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(`Monster aria-label format changed (${cardDomChanged}/${raw.length} cards)`, { platform: 'monster' });
            }

            log.info(`Page ${pageNum}: ${raw.length} cards, ${newCount} new unique, total: ${allJobs.length}`);
            if (newCount === 0) consecutiveEmpty++; else consecutiveEmpty = 0;
            if (consecutiveEmpty >= 2) break;

            await sleep(CONFIG.MIN_PAGE_SPACING_MS + Math.random() * (CONFIG.MAX_PAGE_SPACING_MS - CONFIG.MIN_PAGE_SPACING_MS));
        }

        log.info(`Completed! Found ${allJobs.length} unique jobs`);
        if (allJobs.length === 0) {
            return { jobs: [], emptyConfirmed: true };
        }
        return allJobs;
    } finally {
        try { await browser.close(); } catch { /* already closed */ }
    }
}
