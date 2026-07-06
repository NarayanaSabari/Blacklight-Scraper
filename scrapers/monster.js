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

import { launch, launchPersistentContext } from 'cloakbrowser';
import { createLogger } from '../src/logger/index.js';
import { applyResourceBlocking } from '../src/core/resource-blocking.js';
import { getProxyPool } from '../src/core/proxy-pool.js';
import { stealthLaunchOptions } from '../src/core/launch-config.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { stripHtmlTags } from '../src/core/html.js';
import { BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
import {
    cooldownPath, cooldownMs, readCooldownMarker, writeCooldownMarker, isOnCooldown,
    defaultReadFile, defaultWriteFile, defaultRename,
} from '../src/core/monster-cooldown.js';

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
//   'empty-results' → known result key empty AND totalSize is 0/absent → GENUINE
//                     "0 results" (e.g. an obscure query that truly matches none)
//   'empty-payload' → empty/nullish body, OR known key empty but totalSize>0 →
//                     DataDome SUPPRESS (the API admits N jobs exist but returns
//                     an empty array). This is a block, NOT a real empty.
//   'unparseable'   → JSON.parse threw (e.g. a 403 captcha HTML/redirect body)
//   'unknown-shape' → parses to an object but no known result key is present
// The classifier uses this to tell a genuine empty from a DataDome suppress/block
// (the page renders "no jobs found" in BOTH cases, so page text can't be trusted).
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
    if (!anyKeyPresent) return 'unknown-shape';
    // Known result array present but empty. totalSize>0 means jobs DO exist and
    // were suppressed (DataDome) → treat as a block; totalSize 0/absent → genuine.
    const total = Number(parsed.totalSize);
    return Number.isFinite(total) && total > 0 ? 'empty-payload' : 'empty-results';
}

// Map one appsapi jobResult (schema.org JobPosting shape) → normalized job.
// The appsapi body IS the job data — far more robust than DOM-card scraping
// (which depends on React render timing + selector churn). Pure + testable.
export function mapAppsapiJobResult(r) {
    const jp = r?.jobPosting || r?.normalizedJobPosting;
    if (!jp?.title) return null;
    const addr = Array.isArray(jp.jobLocation) ? jp.jobLocation[0]?.address : null;
    const location = addr
        ? ([addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ') || addr.addressCountry || 'N/A')
        : 'N/A';
    const sal = (r.normalizedJobPosting || jp).baseSalary?.value;
    const cur = (r.normalizedJobPosting || jp).baseSalary?.currency || '';
    let salary = '';
    if (sal && (sal.minValue != null || sal.maxValue != null)) {
        const unit = sal.unitText ? ` / ${String(sal.unitText).toLowerCase()}` : '';
        salary = sal.minValue != null && sal.maxValue != null
            ? `${cur} ${sal.minValue}–${sal.maxValue}${unit}`.trim()
            : `${cur} ${sal.minValue ?? sal.maxValue}${unit}`.trim();
    }
    return normalizeJobData({
        jobId: r.jobId,
        title: jp.title,
        company: jp.hiringOrganization?.name || 'N/A',
        location,
        city: addr?.addressLocality || null,
        state: addr?.addressRegion || null,
        country: addr?.addressCountry || null,
        url: jp.url || (r.jobId ? `https://www.monster.com/job-openings/${r.jobId}` : 'N/A'),
        description: stripHtmlTags(jp.description || '') || 'N/A',
        datePosted: jp.datePosted || 'N/A',
        salary,
        salaryMin: sal?.minValue ?? null,
        salaryMax: sal?.maxValue ?? null,
        salaryCurrency: cur || null,
        salaryPeriod: sal?.unitText ? String(sal.unitText).toLowerCase() : null,
    }, 'Monster');
}

// Parse jobs straight from a Monster appsapi search-jobs response body.
export function parseAppsapiJobs(text) {
    let j; try { j = JSON.parse(text); } catch { return []; }
    const arr = j?.jobResults || j?.jobs || j?.results || j?.searchResults?.jobs;
    if (!Array.isArray(arr)) return [];
    return arr.map(mapAppsapiJobResult).filter(Boolean);
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
    if (cardCount > 0) {
        return { state: 'results', signal: `cards=${cardCount}` };
    }
    // The appsapi's own verdict is authoritative — the page renders "no jobs
    // found" on a DataDome suppress too, so page text alone can't be trusted.
    if (apiResponseInspection === 'empty-results') {
        return { state: 'empty_confirmed', signal: 'appsapi returned 0 results (totalSize 0 — genuine empty)' };
    }
    if (apiResponseInspection === 'has-jobs') {
        return { state: 'dom_changed', signal: 'appsapi has jobs but 0 cards rendered (likely selector rename)' };
    }
    if (apiResponseInspection === 'empty-payload' || apiResponseInspection === 'unparseable' || apiResponseInspection === 'unknown-shape') {
        // Suppressed/garbage appsapi body (incl. totalSize>0 with an empty array,
        // or a 403 captcha body) → DataDome block, EVEN IF the page shows "no
        // jobs found" (DataDome fakes that text). This is the masking-bug fix.
        return { state: 'soft_blocked', signal: `appsapi ${apiResponseInspection} + 0 cards (DataDome suppress/block)` };
    }
    // No appsapi verdict available (body unreadable) — fall back to page text.
    if (/no jobs (found|match)/i.test(t)) {
        return { state: 'empty_confirmed', signal: 'no-jobs-found text (no appsapi verdict)' };
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
    CARD_SELECTOR_TIMEOUT_MS: 12000,   // cards render via React several seconds AFTER the appsapi responds; 5s was too short → false "0 cards"
};

// Country-level / nationwide values that Monster's `where` can't geocode — these
// must map to an EMPTY where (nationwide search). Verified live: `where=United
// States` → appsapi 403 ("no jobs"); `where=` (empty) → appsapi 200 + 36 jobs.
const NATIONWIDE_LOCATION = /^(united states(?: of america)?|u\.?s\.?a?\.?|us|remote|anywhere|nationwide|worldwide)$/i;
export function searchUrl(jobTitle, location, pageNum) {
    const loc = String(location ?? '').trim();
    const where = (!loc || NATIONWIDE_LOCATION.test(loc)) ? '' : loc;
    return `https://www.monster.com/jobs/search` +
        `?q=${encodeURIComponent(jobTitle)}` +
        `&where=${encodeURIComponent(where)}` +
        `&page=${pageNum}`;
}

// Monster is DataDome-gated. A stealth browser (CloakBrowser) on a CLEAN IP
// DOES get the appsapi to return jobs — verified live (200 + 36 cards) — but
// DataDome is ~50/50 per attempt and blocks per-IP. So retry the whole scrape
// across rotating proxy IPs (cooling each blocked IP) until the appsapi returns
// jobs. With a healthy pool of CLEAN residential IPs, a few attempts → high
// success. NOTE: hammered/flagged IPs stay blocked — Monster needs FRESH IPs.
export async function scrapeMonster(jobTitle, location, sessionId = null, options = {}) {
    void sessionId;
    // Skip the cross-run cooldown gate in warmed-profile mode — the operator
    // deliberately warmed a sticky IP, so honour it even right after a block.
    if (!process.env.MONSTER_PROFILE_DIR) {
        const now = new Date();
        const marker = readCooldownMarker({
            readFile: defaultReadFile(),
            now,
            path: cooldownPath(),
        });
        if (isOnCooldown(marker, now)) {
            throw new BlockedError(
                `Monster IP cooldown active until ${marker.blockedUntil.toISOString()} — skipping scrape`,
                { platform: 'monster', kind: 'datadome-cooldown' },
            );
        }
    }
    const maxAttempts = Number.parseInt(process.env.MONSTER_MAX_ATTEMPTS, 10) || 4;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await scrapeMonsterOnce(jobTitle, location, options);
        } catch (e) {
            lastErr = e;
            // Retry on DataDome block (BlockedError) AND the "appsapi responded
            // but 0 cards" case (DomChangedError) — both are transient DataDome
            // render/score outcomes that a fresh attempt on a different IP clears.
            const retryable = e?.name === 'BlockedError' || e?.name === 'DomChangedError';
            if (!retryable || attempt >= maxAttempts) throw e;
            // Cool this IP so acquire() rotates to a different one, then retry
            // (DataDome is per-IP + ~50/50).
            try { getProxyPool().reportBlocked('monster'); } catch { /* best-effort */ }
            log.info(`Monster DataDome block (attempt ${attempt}/${maxAttempts}) — rotating IP + retrying`);
        }
    }
    throw lastErr;
}

// Open a Monster browser context. Default: a fresh stealth browser on a rotating
// pool IP. If MONSTER_PROFILE_DIR is set, reuse that PERSISTENT profile on a
// STICKY pool IP — so a manually-warmed datadome cookie (operator solved the
// DataDome captcha once in that profile dir) carries into the scrape. Returns
// { context, cleanup }.
async function openMonsterContext() {
    const profileDir = process.env.MONSTER_PROFILE_DIR;
    if (profileDir) {
        const proxy = getProxyPool().sticky(Number.parseInt(process.env.MONSTER_STICKY_INDEX, 10) || 0);
        log.info(`🔓 Using warmed Monster profile (${profileDir}) on sticky IP ${proxy?.server || 'direct'}`);
        const context = await launchPersistentContext({
            userDataDir: profileDir,
            headless: process.env.MONSTER_HEADLESS !== 'false',
            humanize: true,
            geoip: true,
            ...(proxy ? { proxy } : {}),
            viewport: { width: 1366, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
        return { context, cleanup: () => context.close() };
    }
    log.info('🚀 Launching CloakBrowser stealth Chromium...');
    const proxy = getProxyPool().acquire('monster');
    const browser = await launch(stealthLaunchOptions({ proxy }));
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    return { context, cleanup: () => browser.close() };
}

async function scrapeMonsterOnce(jobTitle, location, options = {}) {
    void options;
    log.info(`Searching for "${jobTitle}" in "${location}"`);
    const { context, cleanup } = await openMonsterContext();
    const allJobs = [];
    let collectedAnything = false;
    try {
        const warmedProfile = Boolean(process.env.MONSTER_PROFILE_DIR);
        // A warmed profile already holds the datadome cookie, so skip the homepage
        // warmup (an extra hit that can re-trigger DataDome) and resource-blocking
        // (aborting images is itself a bot signal). This matches the flow verified
        // to return 200 + jobs on a warmed profile.
        if (!warmedProfile) await applyResourceBlocking(context);
        const page = await context.newPage();
        if (!warmedProfile) await warmup(page);

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
            )
                .then(async (resp) => {
                    try { return { saw: true, body: await resp.text() }; }
                    catch { return { saw: true, body: null }; }
                })
                .catch(() => ({ saw: false, body: null }));
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.NAV_TIMEOUT_MS });
            } catch (e) {
                if (allJobs.length >= 1) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new NetworkError(`Monster page.goto failed: ${e.message}`, { platform: 'monster', cause: e });
            }
            const { saw: sawApiResponse, body: apiBody } = await apiResponsePromise;
            const apiResponseInspection = sawApiResponse && apiBody !== null
                ? inspectAppsapiBody(apiBody)
                : null;

            // PRIMARY: parse jobs straight from the appsapi JSON we just captured.
            // The body IS the job data — far more robust than scraping DOM cards,
            // which depend on React render timing + selector churn and produced
            // false "0 cards" (dom_changed) even on a clean IP. Fall through to
            // the DOM/classifier path only when the API body carries no jobs.
            if (apiResponseInspection === 'has-jobs') {
                let newCount = 0;
                for (const job of parseAppsapiJobs(apiBody)) {
                    const key = job?.job?.id || job?.core?.id || job?.core?.url || JSON.stringify(job).slice(0, 80);
                    if (seen.has(key)) continue;
                    seen.add(key); allJobs.push(job); newCount += 1;
                    if (allJobs.length >= CONFIG.MAX_JOBS) break;
                }
                collectedAnything = collectedAnything || allJobs.length > 0;
                log.info(`Page ${pageNum}: appsapi → ${newCount} new jobs (total ${allJobs.length})`);
                if (newCount === 0 || allJobs.length >= CONFIG.MAX_JOBS) break;
                continue;
            }

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
                apiResponseInspection,
            });
            log.info(`Page ${pageNum} classified: ${verdict.state} (${verdict.signal})`);

            if (verdict.state === 'soft_blocked') {
                writeCooldownMarker({
                    writeFile: defaultWriteFile(),
                    rename: defaultRename(),
                    now: new Date(),
                    cooldownMs: cooldownMs(),
                    path: cooldownPath(),
                });
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new BlockedError(`Monster blocked: ${verdict.signal}`, { platform: 'monster', kind: 'datadome' });
            }
            if (verdict.state === 'dom_changed') {
                if (collectedAnything) return { jobs: allJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(`Monster DOM changed: ${verdict.signal}`, { platform: 'monster' });
            }
            if (verdict.state === 'network_error') {
                // Mode B: DataDome silently suppressed the appsapi POST (page rendered fine but
                // /jobs-svx-service/.../search-jobs/ never fired). This is just as much a block
                // signal as soft_blocked — write the cooldown marker so subsequent runs short-
                // circuit at the entry gate instead of cascading wasted timeouts. The separate
                // goto-throw catch path (Mode D: genuine network failure) does NOT route here,
                // so this is correctly scoped to "page worked but Monster's edge refused us".
                writeCooldownMarker({
                    writeFile: defaultWriteFile(),
                    rename: defaultRename(),
                    now: new Date(),
                    cooldownMs: cooldownMs(),
                    path: cooldownPath(),
                });
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
        try { await cleanup(); } catch { /* already closed */ }
    }
}
