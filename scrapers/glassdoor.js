// Glassdoor Job Scraper Module
//
// Uses CloakBrowser — a stealth Chromium with source-level C++
// fingerprint patches that passes Cloudflare Turnstile, FingerprintJS,
// and BrowserScan without warmup or cookies. The previous CDP-attach
// approach needed a real human-warmed Chrome on port 9222, a stored
// cf_clearance cookie credential, and constant credential rotation.
// CloakBrowser eliminates all of that — anonymous fresh launches load
// search-result pages cleanly.
import * as cheerio from 'cheerio';
import { launch } from 'cloakbrowser';
import { createLogger } from '../src/logger/index.js';
import { applyResourceBlocking } from '../src/core/resource-blocking.js';
import { getProxyPool } from '../src/core/proxy-pool.js';
import { stealthLaunchOptions } from '../src/core/launch-config.js';
import { scrapeGlassdoorViaApi } from './glassdoor-api.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
import {
    cooldownPath, cooldownMs, readCooldownMarker, writeCooldownMarker, isOnCooldown,
    defaultReadFile, defaultWriteFile, defaultRename,
} from '../src/core/glassdoor-cooldown.js';

const log = createLogger('glassdoor');
const logProgress = (_scope, msg) => log.info(msg);

// Configuration
const CONFIG = {
    CONCURRENT_TABS: 5, // Parallel job detail extraction
    fingerprints: [
        {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'en-US',
            timezone: 'America/New_York'
        },
        {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            locale: 'en-GB',
            timezone: 'Europe/London'
        }
    ]
};

// Human-like delay
function humanDelay(min = 2000, max = 5000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Get random fingerprint
function getRandomFingerprint() {
    return CONFIG.fingerprints[Math.floor(Math.random() * CONFIG.fingerprints.length)];
}

// Normalize an expirationDate to Unix seconds. See indeed.js parseExpiry
// for the full rationale — different cookie-export tools emit numbers
// vs ISO 8601 strings, and Math.floor on a string yields NaN which
// Playwright rejects with "Invalid parameters".
function parseExpiry(raw) {
    if (raw === null || raw === undefined || raw === '') return undefined;
    if (typeof raw === 'number' && isFinite(raw)) return Math.floor(raw);
    if (typeof raw === 'string') {
        const asNum = Number(raw);
        if (isFinite(asNum) && asNum > 0) return Math.floor(asNum);
        const ms = Date.parse(raw);
        if (!isNaN(ms)) return Math.floor(ms / 1000);
    }
    return undefined;
}

// Load cookies from path or credential object
function loadCookies(cookiesPathOrCredential) {
    let cookies;

    // If it's a credential object from API
    if (typeof cookiesPathOrCredential === 'object' && cookiesPathOrCredential.credentials) {
        // Check if credentials is an array (actual API format)
        if (Array.isArray(cookiesPathOrCredential.credentials)) {
            // API returns array of cookie objects directly
            cookies = cookiesPathOrCredential.credentials.map(cookie => ({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
                httpOnly: cookie.httpOnly || false,
                secure: cookie.secure || false,
                sameSite: cookie.sameSite === 'no_restriction' ? 'None' :
                         cookie.sameSite === 'unspecified' ? 'Lax' :
                         cookie.sameSite === 'strict' ? 'Strict' :
                         cookie.sameSite === 'lax' ? 'Lax' :
                         cookie.sameSite || 'Lax',
                expires: parseExpiry(cookie.expirationDate),
            }));
        } else {
            // Legacy format: cookie string and csrf_token
            const { cookie, csrf_token } = cookiesPathOrCredential.credentials;
            
            // Parse cookie string into cookie objects
            const cookiePairs = cookie.split(';').map(c => c.trim());
            cookies = cookiePairs.map(pair => {
                const [name, value] = pair.split('=');
                return {
                    name: name.trim(),
                    value: value.trim(),
                    domain: '.glassdoor.com',
                    path: '/',
                    httpOnly: false,
                    secure: true,
                    sameSite: 'Lax'
                };
            });
            
            // Add CSRF token as a cookie if provided
            if (csrf_token) {
                cookies.push({
                    name: 'csrf_token',
                    value: csrf_token,
                    domain: '.glassdoor.com',
                    path: '/',
                    httpOnly: false,
                    secure: true,
                    sameSite: 'Lax'
                });
            }
        }
    } else {
        // Original path-based loading
        const cookiesPath = typeof cookiesPathOrCredential === 'string' ? cookiesPathOrCredential : cookiesPathOrCredential.cookiesPath;
        const cookiesData = fs.readFileSync(cookiesPath, 'utf8');
        cookies = JSON.parse(cookiesData);
        
        cookies = cookies.map(cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path || '/',
            httpOnly: cookie.httpOnly || false,
            secure: cookie.secure || false,
            sameSite: cookie.sameSite === 'no_restriction' ? 'None' :
                     cookie.sameSite === 'unspecified' ? 'Lax' :
                     cookie.sameSite === 'strict' ? 'Strict' :
                     cookie.sameSite === 'lax' ? 'Lax' :
                     cookie.sameSite || 'Lax',
            expires: cookie.expirationDate ? Math.floor(cookie.expirationDate) : undefined
        }));
    }
    
    return cookies;
}

// Close popups/modals
async function closePopups(page) {
    const popupCloseSelectors = [
        // Priority: User's specific close button with modal_CloseIcon
        'button[data-role-variant="icon"][data-size-variant="md"] svg.modal_CloseIcon__0u8CC',
        'button[data-role-variant="icon"] .modal_CloseIcon__0u8CC',
        'button.icon-button_IconButton__8Hv90[data-role-variant="icon"]',
        'button svg.modal_CloseIcon__0u8CC',
        'button.modal_CloseIcon__0u8CC',
        // Other common selectors
        'button[data-test="job-alert-modal-close"]',
        'button[aria-label="Cancel"]',
        'button[aria-label="Close"]',
        '[data-test*="modal-close"]',
        'button[data-role-variant="icon"][aria-label*="Close"]',
        'button[data-role-variant="icon"][aria-label*="Cancel"]',
        'button svg path[d*="m7.293"]'
    ];

    for (const selector of popupCloseSelectors) {
        try {
            const closeButton = await page.$(selector);
            if (closeButton) {
                const isVisible = await closeButton.isVisible();
                if (isVisible) {
                    logProgress('Glassdoor', `Closing popup with: ${selector}`);
                    await closeButton.click();
                    await page.waitForTimeout(humanDelay(1000, 2000));
                    return true;
                }
            }
        } catch (error) {
            continue;
        }
    }

    return false;
}

// Load all jobs by clicking "Show More"
async function loadAllJobs(page, maxJobs = 100) {
    let previousJobCount = 0;
    let currentJobCount = 0;
    let clickAttempts = 0;
    const maxAttempts = 50;
    const maxSameCount = 3; // Reduced to give more chances before stopping
    let sameCountStreak = 0;

    logProgress('Glassdoor', 'Loading jobs with "Show More" button...');

    while (clickAttempts < maxAttempts && sameCountStreak < maxSameCount) {
        await closePopups(page);

        currentJobCount = await page.$$eval('.jobCard', cards => cards.length);
        logProgress('Glassdoor', `Current job count: ${currentJobCount}`);

        if (currentJobCount >= maxJobs) {
            logProgress('Glassdoor', `Reached target of ${maxJobs} jobs!`);
            break;
        }

        if (currentJobCount > previousJobCount) {
            sameCountStreak = 0;
        } else if (currentJobCount === previousJobCount && clickAttempts > 0) {
            sameCountStreak++;
        }

        previousJobCount = currentJobCount;

        const showMoreSelectors = [
            'button[data-test="load-more"]',
            'button[data-test*="show-more"]',
            'button[data-test*="load-more"]',
            'button.button_Button__meEP5',
            'button[class*="button_Button"]',
            'button:has-text("Show more jobs")',
            'button:has-text("Show More")',
            'button:has-text("Show more")',
            '[data-test="pagination"] button'
        ];

        let buttonFound = false;
        
        // Log available buttons for debugging
        try {
            const availableButtons = await page.$$eval('button', buttons => 
                buttons.map(btn => ({
                    text: btn.textContent?.trim(),
                    dataTest: btn.getAttribute('data-test'),
                    class: btn.className
                })).filter(btn => 
                    btn.text?.toLowerCase().includes('more') || 
                    btn.text?.toLowerCase().includes('load') ||
                    btn.dataTest?.includes('load') ||
                    btn.dataTest?.includes('more')
                )
            );
            if (availableButtons.length > 0 && clickAttempts === 0) {
                logProgress('Glassdoor', `Available buttons: ${JSON.stringify(availableButtons.slice(0, 3))}`);
            }
        } catch (e) {
            // Ignore
        }

        for (const selector of showMoreSelectors) {
            try {
                const button = await page.$(selector);
                if (button) {
                    const isVisible = await button.isVisible();
                    const isEnabled = await button.isEnabled();
                    const dataLoading = await button.getAttribute('data-loading');
                    const isNotLoading = dataLoading !== 'true';

                    if (isVisible && isEnabled && isNotLoading) {
                        await button.scrollIntoViewIfNeeded();
                        await page.waitForTimeout(humanDelay(1000, 2000));
                        await button.click();

                        // Wait for loading cycle
                        try {
                            await page.waitForFunction(
                                (sel) => {
                                    const btn = document.querySelector(sel);
                                    return btn && btn.getAttribute('data-loading') === 'true';
                                },
                                { timeout: 5000 },
                                selector
                            );
                        } catch (e) {
                            // Continue anyway
                        }

                        try {
                            await page.waitForFunction(
                                (sel) => {
                                    const btn = document.querySelector(sel);
                                    return btn && btn.getAttribute('data-loading') === 'false';
                                },
                                { timeout: 15000 },
                                selector
                            );
                        } catch (e) {
                            // Continue anyway
                        }

                        await page.waitForTimeout(humanDelay(2000, 3000));
                        await page.evaluate(() => window.scrollBy(0, 300));
                        await page.waitForTimeout(humanDelay(1000, 2000));

                        buttonFound = true;
                        clickAttempts++;
                        break;
                    }
                }
            } catch (error) {
                continue;
            }
        }

        if (!buttonFound) {
            // More aggressive scrolling to trigger lazy loading
            logProgress('Glassdoor', 'Button not found, scrolling to load more...');
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(humanDelay(2000, 3000));
            
            // Scroll up and down to trigger any lazy loading
            await page.evaluate(() => {
                window.scrollBy(0, -500);
            });
            await page.waitForTimeout(500);
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(humanDelay(1500, 2500));

            const newJobCount = await page.$$eval('.jobCard', cards => cards.length);
            if (newJobCount > currentJobCount) {
                logProgress('Glassdoor', `Scroll loaded ${newJobCount - currentJobCount} more jobs`);
                clickAttempts++;
                continue;
            } else {
                clickAttempts++;
                continue;
            }
        }

        await page.waitForTimeout(humanDelay(500, 1000));
    }

    const finalJobCount = await page.$$eval('.jobCard', cards => cards.length);
    logProgress('Glassdoor', `Job loading complete! Total: ${finalJobCount} jobs`);
    return finalJobCount;
}

// Slug used inside Glassdoor's canonical /Job/...-SRCH_... URLs.
export function slugifyForGlassdoor(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Canonical search URL with an EXPLICIT location pin. Free-text
// sc.location URLs get geo-rewritten to the IP's country (probe
// 2026-06-12: US searches from an Indian IP returned India jobs);
// the _I<T><id> segment keeps results pinned from any IP.
//   loc: {locType:'N'|'S'|'C', locId:number, slug:string} | {remote:true}
export function buildGlassdoorSearchUrl({ keyword, loc }) {
    const remote = !!loc?.remote;
    const locSlug = remote ? 'united-states' : loc.slug;
    const locSeg = remote ? 'IN1' : `I${loc.locType}${loc.locId}`;
    const kwSlug = slugifyForGlassdoor(keyword);
    const L = locSlug.length;
    const K = kwSlug.length;
    const base = `https://www.glassdoor.com/Job/${locSlug}-${kwSlug}-jobs-SRCH_IL.0,${L}_${locSeg}_KO${L + 1},${L + 1 + K}.htm?fromAge=7`;
    return remote ? `${base}&remoteWorkType=1` : base;
}

// Selects the best findPopularLocationAjax result for a search term.
//   - 'remote' (any case) → {remote:true} sentinel; never hits the endpoint
//     results (geo-ambiguous: resolves to "Remote, India" from Indian IPs).
//   - exact case-insensitive label/longName match wins, else first entry
//     (endpoint ranks by relevance).
//   - null on no results → caller falls back to the US country pin.
export function pickGlassdoorLocation(results, term) {
    const t = String(term ?? '').trim().toLowerCase();
    if (t === 'remote') return { remote: true };
    if (!Array.isArray(results) || results.length === 0) return null;
    const exact = results.find((r) =>
        String(r.label ?? '').toLowerCase() === t || String(r.longName ?? '').toLowerCase() === t);
    const chosen = exact ?? results[0];
    if (!chosen?.locationType || !chosen?.locationId) return null;
    return {
        locType: chosen.locationType,
        locId: chosen.locationId,
        slug: slugifyForGlassdoor(term),
    };
}

// No-results phrases seen on the live fixture (2026-06-12): "No results",
// "no results", "couldn't find", "We did not find", "0 jobs".
export const GLASSDOOR_NO_RESULTS_RE = /no results|couldn.?t find|didn.?t find any|0 jobs matching|0 jobs|we did not find/i;
const GLASSDOOR_DOM_CHANGED_BYTES = 100_000;

// Pure page-state classifier for the Glassdoor search-results page.
//   soft_blocked    → Cloudflare/anti-bot interstitial (text wins over cards)
//   empty_confirmed → no-results TEXT — checked BEFORE card count because
//                     empty pages still render ~5 "suggested job" cards
//   geo_redirected  → SRCH URL lost the explicit location pin (Glassdoor
//                     rewrote the search to the IP's country)
//   results         → cards present
//   dom_changed     → large render, 0 cards, no signals
//   network_error   → fall-through
export function classifyGlassdoorSearchPage({ url, bodyText, cardCount, bytes, noResultsText, expectedLocToken }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/cloudflare|verify you are human|just a moment|ray id|security check|help us protect/i.test(t) || /captcha|challenge/i.test(u)) {
        return { state: 'soft_blocked', signal: 'block-page text' };
    }
    if (noResultsText) {
        return { state: 'empty_confirmed', signal: 'no-results text (suggested cards ignored)' };
    }
    if (expectedLocToken && u.includes('SRCH_')) {
        const pinned = u.includes(`${expectedLocToken}_`) || u.includes(`${expectedLocToken}.`);
        if (!pinned) return { state: 'geo_redirected', signal: `SRCH URL lost location pin ${expectedLocToken}` };
    }
    if ((cardCount ?? 0) > 0) return { state: 'results', signal: `cards=${cardCount}` };
    if ((bytes ?? 0) >= GLASSDOOR_DOM_CHANGED_BYTES) return { state: 'dom_changed', signal: `large render (${bytes}b), 0 cards, no signals` };
    return { state: 'network_error', signal: `small body (${bytes}b)` };
}

// Maps one .jobCard to a flat row. Load-bearing: title + (link or jobId).
// Company/rating/salary/easyApply are best-effort — hashed CSS-module
// fallback classes rot on Glassdoor rebuilds and must never kill a row.
// jobLink resolves against the SERVING page URL (geo redirects flip the
// domain; the old hardcoded .co.in prefix emitted wrong-domain links).
export function parseGlassdoorCard($, $card, pageBaseUrl) {
    const jobTitle = $card.find('[data-test="job-title"]').text().trim();
    const href = $card.find('[data-test="job-link"]').attr('href')
        || $card.find('a[href*="/job-listing/"]').attr('href') || '';
    const jobId = $card.find('[data-test="job-title"]').attr('id')?.replace('job-title-', '')
        || href.match(/jl=(\d+)/)?.[1] || null;
    if (!jobTitle) return { __domChanged: true, reason: 'missing_title' };
    if (!href && !jobId) return { __domChanged: true, reason: 'missing_link_and_id' };
    const companyName = $card.find('[data-test="job-employer"]').text().trim()
        || $card.find('[class*="EmployerProfile_compactEmployerName"]').text().trim() || '';
    const ratingText = $card.find('[class*="rating-single-star_RatingText"]').text().trim();
    return {
        jobId,
        jobTitle,
        companyName,
        location: $card.find('[data-test="emp-location"]').text().trim(),
        salaryEstimate: $card.find('[data-test="detailSalary"]').text().trim(),
        jobLink: href ? new URL(href, pageBaseUrl).toString() : null,
        easyApply: $card.find('[class*="JobCard_easyApplyTag"]').length > 0,
        companyRating: ratingText ? parseFloat(ratingText) : null,
    };
}


// Extract job details from detail page
function extractJobDetailsFromHTML(html) {
    const $ = cheerio.load(html);
    const title = $('title').text().trim();

    if (title.includes('Security') || title.includes('Just a moment')) {
        return null;
    }

    const jobDescription = {};
    const jsonLd = $('script[type="application/ld+json"]').html();

    if (jsonLd) {
        try {
            const structuredData = JSON.parse(jsonLd);
            if (structuredData.description) {
                const descHtml = structuredData.description;
                const $desc = cheerio.load(descHtml);
                const fullDescription = $desc.text().trim();
                if (fullDescription) {
                    jobDescription.fullDescription = fullDescription;
                }
            }
        } catch (e) {
            // Ignore
        }
    }

    if (!jobDescription.fullDescription) {
        const descSelectors = [
            '[data-test="job-description"]',
            '.jobDescription',
            '[class*="jobDescription"]'
        ];

        for (const selector of descSelectors) {
            const descElement = $(selector);
            if (descElement.length > 0) {
                const description = descElement.text().trim();
                if (description && description.length > 50) {
                    jobDescription.fullDescription = description;
                    break;
                }
            }
        }
    }

    return jobDescription;
}

// Extract single job details using proper Glassdoor detail URL
async function extractSingleJobDetails(page, job, jobIndex, totalJobs) {
    if (!job.jobId) {
        job.details = null;
        return;
    }

    try {
        // Build the detail URL on the SERVING domain (derived from the
        // already-resolved jobLink). Hardcoding a regional domain here
        // re-introduced the wrong-domain bug the card parser fixed —
        // final-review catch 2026-06-12. Fallback: glassdoor.com.
        let origin = 'https://www.glassdoor.com';
        try { if (job.jobLink) origin = new URL(job.jobLink).origin; } catch { /* keep fallback */ }
        const detailUrl = `${origin}/job-listing/j?jl=${job.jobId}`;
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(humanDelay(3000, 5000));

        const detailHtml = await page.content();
        const details = extractJobDetailsFromHTML(detailHtml);

        if (details === null) {
            job.details = null;
        } else {
            job.details = details;
        }
    } catch (error) {
        job.details = null;
        job.error = error.message;
    }
}

// Parallel extraction
async function extractJobDetailsInParallel(context, jobs, concurrentTabs) {
    async function worker(tabId, jobQueue) {
        const page = await context.newPage();

        try {
            while (jobQueue.length > 0) {
                const jobInfo = jobQueue.shift();
                if (!jobInfo) break;

                const { job, index } = jobInfo;
                await extractSingleJobDetails(page, job, index + 1, jobs.length);
                await page.waitForTimeout(humanDelay(1500, 2500));
            }
        } finally {
            await page.close();
        }
    }

    const jobQueue = jobs.map((job, index) => ({ job, index }));
    const workers = [];

    for (let i = 0; i < concurrentTabs; i++) {
        workers.push(worker(i + 1, jobQueue));
    }

    await Promise.all(workers);
}

// Main export function
// Resolves free-text location → {locType, locId, slug} via Glassdoor's
// autocomplete endpoint. Runs in-page (session cookies required). Falls
// back to the US country pin on any failure — never free-text URLs,
// which geo-rewrite to the IP's country (spec: probe 2026-06-12).
async function resolveGlassdoorLocation(page, term) {
    const sentinel = pickGlassdoorLocation(null, term);   // handles 'remote'
    if (sentinel?.remote) return sentinel;
    let results = null;
    try {
        results = await page.evaluate(async (t) => {
            const r = await fetch(`/findPopularLocationAjax.htm?maxLocationsToReturn=5&term=${encodeURIComponent(t)}`, { headers: { accept: 'application/json' } });
            if (!r.ok) return null;
            return await r.json();
        }, term);
    } catch { /* fall through to fallback */ }
    const picked = pickGlassdoorLocation(results, term);
    if (picked) return picked;
    log.warn(`Glassdoor location "${term}" did not resolve — falling back to United States pin`);
    return { locType: 'N', locId: 1, slug: 'united-states' };
}

export async function scrapeGlassdoor(jobTitle, location, sessionId = null, options = {}) {
    logProgress('Glassdoor', `Searching for "${jobTitle}" in "${location}"`);
    void sessionId; // anonymous platform — kept for orchestrator signature compat

    // PRIMARY PATH: Glassdoor's /graph GraphQL API via TLS-impersonation. The
    // website is Cloudflare-walled (browser ~0-27%); the API is reachable with a
    // randomized-JA3 client. Browser is opt-in fallback (GLASSDOOR_BROWSER_FALLBACK=1).
    if (process.env.GLASSDOOR_USE_API !== 'false') {
        try {
            const apiResult = await scrapeGlassdoorViaApi(jobTitle, location, sessionId, options);
            if (apiResult.jobs.length > 0 || apiResult.emptyConfirmed) return apiResult;
            logProgress('Glassdoor', 'API path returned 0 jobs (unconfirmed) — falling through');
        } catch (e) {
            logProgress('Glassdoor', `API path failed (${e.message})`);
            if (process.env.GLASSDOOR_BROWSER_FALLBACK !== '1') throw e;
        }
    }

    // ---- BROWSER FALLBACK (opt-in: GLASSDOOR_BROWSER_FALLBACK=1) ----
    // Cross-run cooldown gate. A recent Cloudflare block wrote the marker;
    // short-circuit immediately — no browser launch. Prod (2026-06-14) hammered
    // Glassdoor every ~60s and got blocked every time; this backs off after a
    // block so the IP can recover instead of re-blocking on every cycle.
    {
        const now = new Date();
        const marker = readCooldownMarker({ readFile: defaultReadFile(), now, path: cooldownPath() });
        if (isOnCooldown(marker, now)) {
            throw new BlockedError(
                `Glassdoor IP cooldown active until ${marker.blockedUntil.toISOString()} — skipping scrape`,
                { platform: 'glassdoor', kind: 'cloudflare-cooldown' },
            );
        }
    }

    logProgress('Glassdoor', `🚀 Launching CloakBrowser stealth Chromium...`);
    const proxy = getProxyPool().acquire('glassdoor');
    const browser = await launch(stealthLaunchOptions({ proxy }));
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    await applyResourceBlocking(context);
    const page = await context.newPage();

    const collectedJobs = [];
    let rawJobs = [];

    // Runs detail enrichment + normalization over rawJobs so partial-result
    // returns carry actual jobs (Indeed lesson: never emit {jobs:[],partial:true}
    // when raw cards were already extracted).
    const enrichAndCollect = async () => {
        if (rawJobs.length === 0 || collectedJobs.length > 0) return;
        try {
            await extractJobDetailsInParallel(context, rawJobs, CONFIG.CONCURRENT_TABS);
            for (const job of rawJobs) {
                collectedJobs.push(normalizeJobData({
                    title: job.jobTitle,
                    company: job.companyName,
                    location: job.location,
                    url: job.jobLink,
                    description: job.details?.fullDescription || 'N/A',
                    salary: job.salaryEstimate || 'N/A',
                    rating: job.companyRating,
                    easyApply: job.easyApply,
                }, 'Glassdoor'));
            }
        } catch (e) {
            log.warn(`Glassdoor enrichment failed during partial emission: ${e.message}`);
        }
    };

    try {
        // Homepage warmup — also primes session cookies for the location endpoint.
        await page.goto('https://www.glassdoor.com/index.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(humanDelay(3000, 5000));

        const loc = await resolveGlassdoorLocation(page, location);
        const searchUrl = buildGlassdoorSearchUrl({ keyword: jobTitle, loc });
        const expectedLocToken = loc.remote ? '_IN1' : `_I${loc.locType}${loc.locId}`;
        logProgress('Glassdoor', `Pinned search URL: ${searchUrl}`);

        try {
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            throw new NetworkError(`Glassdoor search page.goto failed: ${e.message}`, { platform: 'glassdoor', cause: e });
        }
        // Cloudflare's managed challenge needs time to auto-resolve. Rather than
        // a blunt fixed wait (5-8s cleared ~8%, 20s cleared ~27% in a 2026-06-17
        // proxied test), POLL until real job cards render (challenge cleared) —
        // returns early on success, waits up to the grace ceiling for slow
        // challenges, and bails immediately on a hard "blocked" page (no point
        // waiting). Env-tunable ceiling via GLASSDOOR_CF_GRACE_MS.
        const cfGraceMs = Number.parseInt(process.env.GLASSDOOR_CF_GRACE_MS, 10) || 28000;
        const pollStart = Date.now();
        while (Date.now() - pollStart < cfGraceMs) {
            const cards = await page.$$eval('.jobCard', (c) => c.length).catch(() => 0);
            if (cards > 0) break; // challenge cleared, content rendered
            const hardBlock = await page.evaluate(
                () => /you have been blocked|access denied|sorry, you have been blocked/i.test(document.body?.innerText || ''),
            ).catch(() => false);
            if (hardBlock) break; // hard deny — waiting won't help
            await page.waitForTimeout(1500);
        }

        const probe = await page.evaluate((noResRe) => ({
            finalUrl: window.location.href,
            bodyText: (document.body?.innerText || '').slice(0, 4000),
            cardCount: document.querySelectorAll('.jobCard').length,
            bytes: document.documentElement?.outerHTML?.length ?? 0,
            noResultsText: new RegExp(noResRe, 'i').test(document.body?.innerText || ''),
        }), GLASSDOOR_NO_RESULTS_RE.source);

        const verdict = classifyGlassdoorSearchPage({
            url: probe.finalUrl,
            bodyText: probe.bodyText,
            cardCount: probe.cardCount,
            bytes: probe.bytes,
            noResultsText: probe.noResultsText,
            expectedLocToken,
        });
        logProgress('Glassdoor', `Search page classified: ${verdict.state} (${verdict.signal})`);

        if (verdict.state === 'soft_blocked') {
            // Back off future cycles: write the cooldown marker before throwing
            // so the entry-gate short-circuits subsequent calls (no browser
            // launch) until the IP recovers. geo_redirected does NOT write —
            // that's an IP-geo problem a time-based cooldown can't fix.
            writeCooldownMarker({
                writeFile: defaultWriteFile(),
                rename: defaultRename(),
                now: new Date(),
                cooldownMs: cooldownMs(),
                path: cooldownPath(),
            });
            throw new BlockedError(`Glassdoor blocked: ${verdict.signal}`, { platform: 'glassdoor', kind: 'cloudflare' });
        }
        if (verdict.state === 'geo_redirected') {
            throw new BlockedError(`Glassdoor geo-redirected the pinned search: ${verdict.signal}`, { platform: 'glassdoor', kind: 'geo-redirect' });
        }
        if (verdict.state === 'empty_confirmed') {
            return { jobs: [], emptyConfirmed: true };
        }
        if (verdict.state === 'dom_changed') {
            throw new DomChangedError(`Glassdoor DOM changed: ${verdict.signal}`, { platform: 'glassdoor' });
        }
        if (verdict.state === 'network_error') {
            throw new NetworkError(`Glassdoor page didn't render: ${verdict.signal}`, { platform: 'glassdoor' });
        }

        // results — load more, then extract via parseGlassdoorCard
        await page.waitForTimeout(humanDelay(2000, 4000));
        await loadAllJobs(page, 30);

        const html = await page.content();
        const pageBaseUrl = page.url();
        const $ = cheerio.load(html);
        let domChangedCount = 0;
        $('.jobCard').each((_, el) => {
            const row = parseGlassdoorCard($, $(el), pageBaseUrl);
            if (!row) return;
            if (row.__domChanged) { domChangedCount++; return; }
            if (rawJobs.some((j) => j.jobId && j.jobId === row.jobId)) return;
            rawJobs.push(row);
        });
        rawJobs = rawJobs.slice(0, 30);
        logProgress('Glassdoor', `Extracted ${rawJobs.length} unique cards (${domChangedCount} dom-changed sentinels)`);

        const totalCards = rawJobs.length + domChangedCount;
        if (totalCards > 0 && domChangedCount / totalCards > 0.30) {
            throw new DomChangedError(`Glassdoor card-level DOM-changed rate too high (${domChangedCount}/${totalCards})`, { platform: 'glassdoor' });
        }
        if (rawJobs.length === 0) {
            // results verdict but nothing extractable — selector drift
            throw new DomChangedError('Glassdoor: results page but 0 extractable cards', { platform: 'glassdoor' });
        }

        await enrichAndCollect();
        logProgress('Glassdoor', `Completed! ${collectedJobs.length} jobs with details`);
        if (collectedJobs.length === 0) return { jobs: [], emptyConfirmed: true };
        return collectedJobs;
    } catch (error) {
        // Partial-result policy: if cards were already extracted, enrich +
        // return them rather than discarding the work. Geo-redirected results
        // are wrong-country data — never return them, even partially.
        if (rawJobs.length > 0 && !(error instanceof BlockedError && error.kind === 'geo-redirect')) {
            await enrichAndCollect();
            if (collectedJobs.length > 0) {
                logProgress('Glassdoor', `Partial return: ${collectedJobs.length} jobs before ${error.name}`);
                return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
            }
        }
        throw error;
    } finally {
        try { await browser.close(); } catch { /* already closed */ }
    }
}
