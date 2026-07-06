// Indeed Job Scraper Module
//
// Uses CloakBrowser — stealth Chromium with source-level C++ fingerprint
// patches — combined with a persistent logged-in profile (`npm run
// indeed:login`) for full pagination. Anonymous (page-1) is the fallback.
//
// Why auth: anonymous Indeed caps at page 1 (~16 cards per role). Any
// pagination attempt — direct &start=10 or clicking "Next page" —
// bounces to the Sign-In page. Logged-in sessions get the full 5-page
// /50-job pagination. Confirmed via cloak-indeed-paginate probes.
//
// Why CloakBrowser (not CDP+Playwright): the previous CDP-attach
// approach reused a manually-logged-in real Chrome to pass Cloudflare,
// but was fragile (manual `chrome:login`, single-browser bottleneck
// with LinkedIn, broke whenever the user closed Chrome). CloakBrowser's
// stealth Chromium + injected cookies passes Cloudflare from a fresh
// headless launch, restoring scalability.
//
// Three combination knobs matter for getting past Cloudflare:
//   1. humanize:true at launch — Cloudflare scores behavioral signals
//      (timing, mouse curves) in addition to fingerprints. Without it
//      we get "Additional Verification Required" / Ray ID page.
//   2. NO homepage warmup — visiting https://www.indeed.com first
//      causes a regional redirect (in.indeed.com from Indian IPs)
//      which then makes the navigation back to www.indeed.com look
//      suspicious to Cloudflare. Go directly to the search URL.
//   3. waitUntil:'load' + ~10s post-nav wait — Cloudflare's challenge
//      JS needs time to run and post the clearance token. Without it
//      the page resolves while still on the challenge page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { launch, launchPersistentContext } from 'cloakbrowser';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { stripHtmlTags } from '../src/core/html.js';
import { assertNotBlocked } from '../src/core/block-detection.js';
import { AuthError, BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
import { applyResourceBlocking } from '../src/core/resource-blocking.js';
import { getProxyPool } from '../src/core/proxy-pool.js';
import { scrapeIndeedViaApi } from './indeed-api.js';
import {
    cooldownPath, cooldownMs, readCooldownMarker, writeCooldownMarker, isOnCooldown,
    defaultReadFile, defaultWriteFile, defaultRename,
} from '../src/core/indeed-cooldown.js';

// Persistent logged-in profile (manual-login model, mirrors LinkedIn). The
// operator runs `node scripts/indeed-login.js` once → a headed CloakBrowser writes the
// session into this dir → scrapeIndeed reuses it (full pagination + a warmed
// cf_clearance that passes Cloudflare). Default ~/.blacklight-indeed-profile;
// override with INDEED_PROFILE_DIR (must match what indeed:login uses).
export function indeedProfileDir() {
    return process.env.INDEED_PROFILE_DIR
        || path.join(os.homedir(), '.blacklight-indeed-profile');
}

// True once the operator has logged in (profile dir exists and is non-empty).
export function indeedProfileExists() {
    try {
        const dir = indeedProfileDir();
        return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

// Flag-gated hardening (audit I1/I13/I2). Read once. When this is NOT
// 'true' (the default/shipped state) Indeed behaves byte-identically to
// the pre-1C scraper: loginSuccess set early, any 0-card page ends
// pagination, no block detection. Flipping SCRAPER_STRICT_EMPTY=true
// per-host activates: a Cloudflare/DataDome challenge throws (→ cooldown
// + 'blocked' metric) instead of a silent successful 0-job scrape.
const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true';

const log = createLogger('indeed');
const logProgress = (_scope, msg) => log.info(msg);

// Grace for Cloudflare's challenge to auto-resolve before we classify. A
// 2026-06-17 test showed a longer wait (22s) did NOT help Indeed (0% vs ~6%) —
// Indeed hard-blocks rather than serving a resolvable challenge — so 10s stays.
// Env-tunable for future experiments.
const CLOUDFLARE_GRACE_MS = Number.parseInt(process.env.INDEED_CF_GRACE_MS, 10) || 10_000;
const DETAIL_DOM_CHANGED_THRESHOLD = 0.30;

// Configuration
const CONFIG = {
    CONCURRENT_TABS: 5,
    MAX_JOBS: 40,   // detail-page count drives proxy bandwidth
    MAX_PAGES: 5,
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
            locale: 'en-IN',
            timezone: 'Asia/Kolkata'
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

/**
 * Close any popups or modals that might appear
 * @param {Page} page - Playwright page object
 */
async function closePopups(page) {
    const popupSelectors = [
        'button[aria-label="close"]',
        'button[aria-label="Close"]',
        '[data-testid="close-button"]',
        '.icl-CloseButton',
        '.popover-x-button-close',
        '#mosaic-desktopserpjapopup button[aria-label="Close"]',
        '.icl-Modal-close',
        'button.css-yi9ndv'
    ];

    for (const selector of popupSelectors) {
        try {
            const closeButton = await page.$(selector);
            if (closeButton) {
                const isVisible = await closeButton.isVisible();
                if (isVisible) {
                    logProgress('Indeed', `Closing popup with: ${selector}`);
                    await closeButton.click();
                    await page.waitForTimeout(humanDelay(500, 1000));
                    return true;
                }
            }
        } catch (error) {
            continue;
        }
    }
    return false;
}

/**
 * Determine the Indeed domain based on location
 * @param {string} location - Location string
 * @returns {string} Indeed domain
 */
function getIndeedDomain(location) {
    const locationLower = location.toLowerCase();
    
    if (locationLower.includes('india') || locationLower === 'in' || locationLower.includes('bangalore') || 
        locationLower.includes('mumbai') || locationLower.includes('delhi') || locationLower.includes('chennai') ||
        locationLower.includes('hyderabad') || locationLower.includes('pune')) {
        return 'in.indeed.com';
    }
    if (locationLower.includes('uk') || locationLower.includes('london') || locationLower.includes('england')) {
        return 'uk.indeed.com';
    }
    if (locationLower.includes('canada') || locationLower.includes('toronto') || locationLower.includes('vancouver')) {
        return 'ca.indeed.com';
    }
    if (locationLower.includes('australia') || locationLower.includes('sydney') || locationLower.includes('melbourne')) {
        return 'au.indeed.com';
    }
    
    // Default to US
    return 'www.indeed.com';
}

/**
 * Build Indeed search URL
 * @param {string} domain - Indeed domain
 * @param {string} jobTitle - Job title to search
 * @param {string} location - Location to search
 * @param {number} start - Starting index for pagination
 * @returns {string} Search URL
 */
function buildSearchUrl(domain, jobTitle, location, start = 0) {
    // Indeed treats parenthesized text as a literal required token, so a
    // canonical role like "Quantitative Developer (Quant)" forces every
    // posting to also contain "(Quant)" — collapsing to zero results.
    // Strip any "(...)" segments before encoding.
    const cleanedTitle = jobTitle.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const encodedJobTitle = encodeURIComponent(cleanedTitle);
    const encodedLocation = encodeURIComponent(location);
    
    // fromage=7 = last 7 days, sort=date for most recent
    let url = `https://${domain}/jobs?q=${encodedJobTitle}&l=${encodedLocation}&fromage=7&sort=date`;
    
    if (start > 0) {
        url += `&start=${start}`;
    }
    
    return url;
}

/**
 * Positively detect Indeed's "no results" page so a genuine empty search
 * is distinguishable from a silent block / DOM change. Pure + safe on
 * junk input. Indeed renders a `jobsearch-NoResult` container and/or the
 * phrase "did not match any jobs".
 * @param {string} html
 * @returns {boolean}
 */
export function indeedNoResults(html) {
    if (!html || typeof html !== 'string') return false;
    if (html.includes('jobsearch-NoResult')) return true;
    return /did not match any jobs/i.test(html);
}

// Returns the job key (Indeed's per-listing identifier) for a card.
// Three-step fallback, preserving the historical waterfall:
//   1. card's own data-jk attribute
//   2. closest ancestor with data-jk
//   3. first descendant with data-jk (today's primary path: a[data-jk] —
//      2026 Indeed migrated the attribute from li/div onto the anchor)
// Returns null on miss; the caller skips the row.
export function extractJobKey($, $card) {
    const own = $card.attr('data-jk');
    if (own) return own;
    const ancestor = $card.closest('[data-jk]');
    if (ancestor.length && ancestor.attr('data-jk')) return ancestor.attr('data-jk');
    const descendant = $card.find('[data-jk]').first();
    if (descendant.length && descendant.attr('data-jk')) return descendant.attr('data-jk');
    return null;
}

// Builds the canonical job-detail URL for an Indeed listing. Returns
// null when either input is missing so the caller can drop the row
// rather than emit a broken URL.
export function indeedJobUrl(domain, jobKey) {
    if (!domain || !jobKey) return null;
    return `https://${domain}/viewjob?jk=${encodeURIComponent(jobKey)}`;
}

// Maps one search-result card to a flat record. Composes extractJobKey
// + indeedJobUrl with per-field selectors. Returns:
//   - the row on success
//   - { __domChanged: true, reason } when load-bearing fields are missing
//     and the card had a data-jk (indicates Indeed renamed something)
//   - null when no data-jk exists at all (UI artifact, not a job card)
export function parseJobCard($, $card, domain) {
    const jobKey = extractJobKey($, $card);
    if (!jobKey) return null;

    // Title — prefer the nested span inside h3.jobTitle (Indeed's stable layout)
    let title = $card.find('h3.jobTitle span[title]').attr('title')
        || $card.find('h3.jobTitle span').first().text().trim()
        || $card.find('h3.jobTitle').text().trim()
        || $card.find('h2.jobTitle span[title]').attr('title')
        || $card.find('h2.jobTitle span').first().text().trim()
        || $card.find('h2.jobTitle').text().trim()
        || $card.find('a[data-jk]').first().text().trim();
    title = title?.trim() || '';

    // Company
    const company = (
        $card.find('[data-testid="company-name"]').text().trim()
        || $card.find('.companyName').text().trim()
        || $card.find('span.companyName').text().trim()
        || ''
    ).trim();

    if (!title || !company) {
        return { __domChanged: true, reason: !title ? 'missing_title' : 'missing_company' };
    }

    // Location
    const location = (
        $card.find('[data-testid="text-location"]').text().trim()
        || $card.find('.companyLocation').text().trim()
        || ''
    ).trim();

    // Salary (best-effort; not load-bearing)
    const salary = (
        $card.find('[data-testid="attribute_snippet_testid"]:contains("$")').first().text().trim()
        || $card.find('.salary-snippet, .estimated-salary').first().text().trim()
        || ''
    ).trim();

    // Posted-date
    const postedDate = (
        $card.find('[data-testid="myJobsStateDate"]').text().trim()
        || $card.find('.date').text().trim()
        || ''
    ).replace(/^Posted\s*/i, '').trim();

    const url = indeedJobUrl(domain, jobKey);
    const isPromoted = $card.attr('data-empn') ? true : $card.find('.sponsoredJob, [class*="sponsored"]').length > 0;

    return {
        jobKey,
        title,
        company,
        location,
        salary,
        postedDate,
        url,
        isPromoted,
    };
}

// Pure page-state classifier for the Indeed search-results page.
//   results          → real results page, anchors are extractable
//   empty_confirmed  → real "0 results" page (indeedNoResults() matches)
//   auth_required    → bounced to secure.indeed.com/auth (cookies invalid
//                      OR pagination beyond anonymous cap)
//   soft_blocked     → Cloudflare interstitial / verify-human page
//   dom_changed      → page rendered but anchors absent and no other signal
//   network_error    → page didn't render meaningfully
const INDEED_DOM_CHANGED_BYTES_THRESHOLD = 50_000;

export function classifyIndeedSearchPage({ url, bodyText, anchorCount, sawAuthBounce, bytes, html }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/cloudflare|verify you are human|just a moment|ray id|additional verification|access denied/i.test(t)
        || /captcha|challenge/i.test(u)) {
        return { state: 'soft_blocked', signal: 'cloudflare-style block page' };
    }
    if (sawAuthBounce || /secure\.indeed\.com\/auth/.test(u)) {
        return { state: 'auth_required', signal: 'bounced to secure.indeed.com/auth' };
    }
    if (anchorCount > 0) {
        return { state: 'results', signal: `anchors=${anchorCount}` };
    }
    if (indeedNoResults(html)) {
        return { state: 'empty_confirmed', signal: 'indeedNoResults() matched' };
    }
    if ((bytes ?? 0) >= INDEED_DOM_CHANGED_BYTES_THRESHOLD) {
        return { state: 'dom_changed', signal: `large render (${bytes}b) but 0 anchors and no empty/auth/block signal` };
    }
    return { state: 'network_error', signal: `small body (${bytes}b), no positive page signal` };
}

/**
 * Extract job listings from search results page
 * @param {string} html - HTML content of search results
 * @param {string} domain - Indeed domain for building full URLs
 * @returns {Array} Array of job objects with basic info
 */
function extractJobsFromSearchPage(html, domain) {
    const $ = cheerio.load(html);
    const jobs = [];

    // Indeed job cards - the main container has data-jk attribute with job key
    const jobCardSelectors = [
        '.job_seen_beacon',
        '.jobsearch-ResultsList > li',
        '[data-testid="job-card"]',
        '.resultContent',
        'li[data-jk]',
        'div[data-jk]'
    ];

    let jobCards = $([]);
    for (const selector of jobCardSelectors) {
        jobCards = $(selector);
        if (jobCards.length > 0) {
            logProgress('Indeed', `Found ${jobCards.length} job cards with selector: ${selector}`);
            break;
        }
    }

    jobCards.each((index, element) => {
        try {
            const card = $(element);
            
            // Get job key (jk) - this is the unique identifier
            // First check the card itself for data-jk, then parent elements
            let jobKey = card.attr('data-jk');
            
            if (!jobKey) {
                // Check parent elements
                const parentWithJk = card.closest('[data-jk]');
                if (parentWithJk.length > 0) {
                    jobKey = parentWithJk.attr('data-jk');
                }
            }
            
            if (!jobKey) {
                // Check for job key in any child element with data-jk
                const childWithJk = card.find('[data-jk]').first();
                if (childWithJk.length > 0) {
                    jobKey = childWithJk.attr('data-jk');
                }
            }
            
            // Extract job title and link
            const titleElement = card.find('h2.jobTitle a, a[data-jk], .jobTitle a, a.jcs-JobTitle, h2 a, a[id^="job_"]');
            let jobTitle = titleElement.find('span[title]').attr('title') || 
                           titleElement.find('span').first().text().trim() ||
                           titleElement.text().trim();
            
            // Clean up title
            jobTitle = jobTitle.replace(/\s+/g, ' ').trim();
            
            // Get href for job URL
            const href = titleElement.attr('href');
            
            // Try to extract job key from href if not found yet
            if (!jobKey && href) {
                const jkMatch = href.match(/jk=([a-f0-9]+)/i);
                if (jkMatch) {
                    jobKey = jkMatch[1];
                }
            }
            
            // Try extracting from any link in the card
            if (!jobKey) {
                card.find('a[href*="jk="]').each((_, linkEl) => {
                    const linkHref = $(linkEl).attr('href');
                    const match = linkHref?.match(/jk=([a-f0-9]+)/i);
                    if (match) {
                        jobKey = match[1];
                        return false; // break
                    }
                });
            }
            
            // Build job URL
            let jobUrl = '';
            if (jobKey) {
                jobUrl = `https://${domain}/viewjob?jk=${jobKey}`;
            } else if (href) {
                jobUrl = href.startsWith('http') ? href : `https://${domain}${href}`;
            }
            
            // Skip if no job key found (likely duplicate or invalid card)
            if (!jobKey) {
                return; // continue to next card
            }

            // Extract company name
            const companyElement = card.find('[data-testid="company-name"], .companyName, span[data-testid="company-name"], .company_location span:first-child, span.css-1h7lukg, span.css-92r8pb');
            const company = companyElement.first().text().trim() || 'N/A';

            // Extract location
            const locationElement = card.find('[data-testid="text-location"], .companyLocation, div[data-testid="text-location"], .company_location div:last-child');
            const location = locationElement.first().text().trim() || 'N/A';

            // Extract salary if available
            const salaryElement = card.find('[data-testid="attribute_snippet_testid"], .salary-snippet-container, .metadata .attribute_snippet, .salaryText, div.salary-snippet-container');
            const salary = salaryElement.first().text().trim() || 'N/A';

            // Extract job snippet/description
            const snippetElement = card.find('.job-snippet, [data-testid="job-snippet"], .underShelfFooter, ul[style*="list-style"]');
            const snippet = snippetElement.text().trim() || '';

            // Extract posted date
            const dateElement = card.find('.date, [data-testid="myJobsStateDate"], .result-footer .date, span.date');
            const postedDate = dateElement.first().text().trim() || 'N/A';

            // Check for easy apply
            const easyApply = card.find('.iaLabel, .indeed-apply-badge, [data-testid="indeedApply"], span:contains("Easily apply")').length > 0;

            if (jobTitle && jobKey) {
                jobs.push({
                    jobId: jobKey,
                    title: jobTitle,
                    company,
                    location,
                    salary,
                    snippet,
                    postedDate,
                    easyApply,
                    url: jobUrl
                });
            }
        } catch (error) {
            logProgress('Indeed', `Error parsing job card: ${error.message}`);
        }
    });

    return jobs;
}

/**
 * Extract detailed job information from job detail page
 * @param {Page} page - Playwright page object  
 * @param {Object} job - Basic job object
 * @returns {Object} Job object with detailed information
 */
async function extractJobDetails(page, job) {
    try {
        logProgress('Indeed', `   Fetching details for: ${job.title.substring(0, 40)}...`);
        
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(humanDelay(2000, 3000));
        
        // Close any popups
        await closePopups(page);
        
        const html = await page.content();
        const $ = cheerio.load(html);

        // Extract full job description
        const descriptionSelectors = [
            '#jobDescriptionText',
            '.jobsearch-jobDescriptionText',
            '[data-testid="jobDescriptionText"]',
            '.jobsearch-JobComponent-description'
        ];
        
        let description = '';
        for (const selector of descriptionSelectors) {
            const descElement = $(selector);
            if (descElement.length > 0) {
                description = stripHtmlTags(descElement.html()) || descElement.text().trim();
                if (description && description.length > 50) {
                    break;
                }
            }
        }

        // Extract salary from detail page if not found in search
        if (job.salary === 'N/A' || !job.salary) {
            const salarySelectors = [
                '[data-testid="jobsearch-JobInfoHeader-salary"]',
                '.jobsearch-JobMetadataHeader-item',
                '#salaryInfoAndJobType',
                '.salary-snippet-container'
            ];
            
            for (const selector of salarySelectors) {
                const salaryElement = $(selector);
                const salaryText = salaryElement.text().trim();
                if (salaryText && (salaryText.includes('$') || salaryText.includes('₹') || salaryText.includes('year') || salaryText.includes('hour'))) {
                    job.salary = salaryText;
                    break;
                }
            }
        }

        // Extract job type (Full-time, Part-time, Contract, etc.)
        const jobTypeSelectors = [
            '[data-testid="jobsearch-JobInfoHeader-jobType"]',
            '.jobsearch-JobMetadataHeader-item',
            '#salaryInfoAndJobType'
        ];
        
        let employmentType = 'N/A';
        for (const selector of jobTypeSelectors) {
            const typeElements = $(selector);
            typeElements.each((_, el) => {
                const text = $(el).text().trim().toLowerCase();
                if (text.includes('full-time') || text.includes('full time')) {
                    employmentType = 'full_time';
                } else if (text.includes('part-time') || text.includes('part time')) {
                    employmentType = 'part_time';
                } else if (text.includes('contract')) {
                    employmentType = 'contract';
                } else if (text.includes('temporary')) {
                    employmentType = 'temporary';
                } else if (text.includes('intern')) {
                    employmentType = 'internship';
                }
            });
            if (employmentType !== 'N/A') break;
        }

        // Extract company rating if available
        let companyRating = null;
        const ratingElement = $('[data-testid="rating"], .icl-Ratings-count, .jobsearch-CompanyRating');
        if (ratingElement.length > 0) {
            const ratingText = ratingElement.text().trim();
            const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
            if (ratingMatch) {
                companyRating = parseFloat(ratingMatch[1]);
            }
        }

        // Check for remote work
        const isRemote = description.toLowerCase().includes('remote') || 
                        job.location.toLowerCase().includes('remote') ||
                        $('[data-testid="remote"]').length > 0;

        // Extract skills from description (common patterns)
        const skills = [];
        const skillPatterns = [
            /skills?:\s*([^.]+)/gi,
            /requirements?:\s*([^.]+)/gi,
            /qualifications?:\s*([^.]+)/gi
        ];
        
        for (const pattern of skillPatterns) {
            const matches = description.match(pattern);
            if (matches) {
                matches.forEach(match => {
                    const skillText = match.replace(/skills?:|requirements?:|qualifications?:/gi, '').trim();
                    const skillList = skillText.split(/[,;]/).map(s => s.trim()).filter(s => s.length > 2 && s.length < 50);
                    skills.push(...skillList.slice(0, 10));
                });
            }
        }

        return {
            ...job,
            description: description || job.snippet,
            employmentType,
            companyRating,
            isRemote,
            skills: [...new Set(skills)].slice(0, 15) // Dedupe and limit
        };

    } catch (error) {
        logProgress('Indeed', `   Error fetching job details: ${error.message}`);
        return {
            ...job,
            description: job.snippet,
            employmentType: 'N/A',
            companyRating: null,
            isRemote: false,
            skills: []
        };
    }
}

/**
 * Extract job details in parallel using multiple browser tabs
 * @param {BrowserContext} context - Playwright browser context
 * @param {Array} jobs - Array of job objects
 * @param {number} concurrentTabs - Number of parallel tabs
 */
async function extractJobDetailsInParallel(context, jobs, concurrentTabs) {
    async function worker(tabId, jobQueue) {
        const page = await context.newPage();
        
        try {
            while (jobQueue.length > 0) {
                const jobInfo = jobQueue.shift();
                if (!jobInfo) break;
                
                const { job, index } = jobInfo;
                const detailedJob = await extractJobDetails(page, job);
                
                // Update the job in the original array
                Object.assign(jobs[index], detailedJob);
                
                await page.waitForTimeout(humanDelay(1000, 2000));
            }
        } finally {
            await page.close();
        }
    }

    const jobQueue = jobs.map((job, index) => ({ job, index }));
    const workers = [];

    for (let i = 0; i < Math.min(concurrentTabs, jobs.length); i++) {
        workers.push(worker(i + 1, jobQueue));
    }

    await Promise.all(workers);
}

/**
 * Main export function - scrapes Indeed jobs
 * @param {string} jobTitle - Job title to search
 * @param {string} location - Location to search
 * @param {string} sessionId - Optional session ID for credential tracking
 * @returns {Array|Object} Array of normalized job objects, or {jobs, emptyConfirmed, partial}
 */
export async function scrapeIndeed(jobTitle, location, sessionId = null, options = {}) {
    // PRIMARY PATH: Indeed's mobile GraphQL API (apis.indeed.com). The public
    // website is a Cloudflare HARD block (browser path ~0%); the iOS-app backend
    // has no wall and returns clean JSON in <1s through the residential proxy.
    if (process.env.INDEED_USE_API !== 'false') {
        try {
            const apiResult = await scrapeIndeedViaApi(jobTitle, location, sessionId, options);
            if (apiResult.jobs.length > 0 || apiResult.emptyConfirmed) return apiResult;
            logProgress('Indeed', 'API path returned 0 jobs (unconfirmed) — falling through');
        } catch (e) {
            logProgress('Indeed', `API path failed (${e.message})`);
            // Browser fallback is opt-in (it scores ~0% vs Cloudflare). Default:
            // surface the API error so it's recorded, don't waste a browser run.
            if (process.env.INDEED_BROWSER_FALLBACK !== '1') throw e;
        }
    }

    // ---- BROWSER FALLBACK (opt-in: INDEED_BROWSER_FALLBACK=1) ----
    // Cross-run cooldown gate. If a recent Cloudflare block wrote the
    // marker, short-circuit immediately — no browser launch.
    {
        const now = new Date();
        const marker = readCooldownMarker({
            readFile: defaultReadFile(),
            now,
            path: cooldownPath(),
        });
        if (isOnCooldown(marker, now)) {
            throw new BlockedError(
                `Indeed IP cooldown active until ${marker.blockedUntil.toISOString()} — skipping scrape`,
                { platform: 'indeed', kind: 'cloudflare-cooldown' },
            );
        }
    }

    logProgress('Indeed', `Searching for "${jobTitle}" in "${location}"`);

    const domain = getIndeedDomain(location);

    // Session: prefer the operator's persistent logged-in profile
    // (`node scripts/indeed-login.js`). It gives full pagination AND a warmed
    // cf_clearance that passes Cloudflare reliably on later runs. With no
    // profile, fall back to an anonymous context (page-1 only) when
    // INDEED_ALLOW_ANONYMOUS=1, otherwise throw — the remedy is indeed:login.
    const usingProfile = indeedProfileExists();
    const proxy = getProxyPool().acquire('indeed');
    let browser = null;   // set only in anonymous mode (plain launch → Browser handle)
    let context;
    if (usingProfile) {
        logProgress('Indeed', `🔓 Using persistent Indeed profile (${indeedProfileDir()})`);
        context = await launchPersistentContext({
            userDataDir: indeedProfileDir(),
            headless: process.env.INDEED_HEADLESS !== 'false',
            humanize: true,
            ...(proxy ? { proxy } : {}),
            // Match indeed-login.js's viewport so the scrape fingerprint stays
            // coherent with the profile the operator logged in under.
            viewport: { width: 1366, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
    } else if (process.env.INDEED_ALLOW_ANONYMOUS === '1') {
        const fingerprint = getRandomFingerprint();
        logProgress('Indeed', 'WARN: no Indeed profile — running anonymous (page 1 only). Run `node scripts/indeed-login.js` for full pagination.');
        browser = await launch({ headless: true, humanize: true, ...(proxy ? { proxy } : {}) });
        context = await browser.newContext({
            userAgent: fingerprint.userAgent,
            viewport: fingerprint.viewport,
            locale: fingerprint.locale,
            timezoneId: fingerprint.timezone,
        });
    } else {
        throw new AuthError(
            'No Indeed profile — run `node scripts/indeed-login.js` (or set INDEED_ALLOW_ANONYMOUS=1 for page-1 only)',
            { platform: 'indeed' },
        );
    }

    await applyResourceBlocking(context);

    const collectedJobs = [];
    let collectedAnything = false;

    try {
        const page = await context.newPage();
        await closePopups(page);

        const allRawJobs = [];
        let domChangedCardCount = 0;
        let totalCardsProcessed = 0;

        // Detail enrichment is structurally end-of-loop, so the partial-result
        // return paths used to emit collectedJobs=[] (raw cards collected but
        // never enriched) — silent data loss. This helper runs enrichment +
        // normalization on whatever raw cards we have, so partial-result
        // returns carry actual jobs. Errors in enrichment are swallowed so we
        // don't lose the original throw-context for the outer caller.
        const enrichAndCollect = async () => {
            if (allRawJobs.length === 0) return;
            try {
                await extractJobDetailsInParallel(context, allRawJobs, CONFIG.CONCURRENT_TABS);
                for (const j of allRawJobs) {
                    collectedJobs.push(normalizeJobData(j, 'Indeed'));
                }
            } catch (e) {
                log.warn(`Indeed enrichment failed during partial-result emission: ${e.message}`);
            }
        };

        for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES && allRawJobs.length < CONFIG.MAX_JOBS; pageNum++) {
            const start = (pageNum - 1) * 10;
            const url = buildSearchUrl(domain, jobTitle, location, start);
            logProgress('Indeed', `Page ${pageNum}: ${url}`);

            try {
                await page.goto(url, { waitUntil: 'load', timeout: 45000 });
            } catch (e) {
                if (allRawJobs.length > 0) {
                    await enrichAndCollect();
                    if (collectedJobs.length > 0) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                }
                throw new NetworkError(`Indeed page.goto failed: ${e.message}`, { platform: 'indeed', cause: e });
            }
            await new Promise((r) => setTimeout(r, CLOUDFLARE_GRACE_MS));

            const probe = await page.evaluate(() => ({
                finalUrl: window.location.href,
                bodyText: (document.body?.innerText || '').slice(0, 4000),
                bytes: document.documentElement?.outerHTML?.length ?? 0,
                anchorCount: document.querySelectorAll('.job_seen_beacon').length
                    || document.querySelectorAll('[data-jk]').length,
            }));
            const html = await page.content();
            const sawAuthBounce = /secure\.indeed\.com\/auth/.test(probe.finalUrl);
            const verdict = classifyIndeedSearchPage({
                url: probe.finalUrl,
                bodyText: probe.bodyText,
                anchorCount: probe.anchorCount,
                sawAuthBounce,
                bytes: probe.bytes,
                html,
            });
            logProgress('Indeed', `Page ${pageNum} classified: ${verdict.state} (${verdict.signal})`);

            if (verdict.state === 'soft_blocked') {
                writeCooldownMarker({
                    writeFile: defaultWriteFile(),
                    rename: defaultRename(),
                    now: new Date(),
                    cooldownMs: cooldownMs(),
                    path: cooldownPath(),
                });
                if (allRawJobs.length > 0) {
                    await enrichAndCollect();
                    if (collectedJobs.length > 0) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                }
                throw new BlockedError(`Indeed blocked: ${verdict.signal}`, { platform: 'indeed', kind: 'cloudflare' });
            }
            if (verdict.state === 'auth_required') {
                if (allRawJobs.length > 0) {
                    await enrichAndCollect();
                    if (collectedJobs.length > 0) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                }
                throw new AuthError(`Indeed auth required: ${verdict.signal}`, { platform: 'indeed' });
            }
            if (verdict.state === 'dom_changed') {
                if (allRawJobs.length > 0) {
                    await enrichAndCollect();
                    if (collectedJobs.length > 0) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                }
                throw new DomChangedError(`Indeed DOM changed: ${verdict.signal}`, { platform: 'indeed' });
            }
            if (verdict.state === 'network_error') {
                writeCooldownMarker({
                    writeFile: defaultWriteFile(),
                    rename: defaultRename(),
                    now: new Date(),
                    cooldownMs: cooldownMs(),
                    path: cooldownPath(),
                });
                if (allRawJobs.length > 0) {
                    await enrichAndCollect();
                    if (collectedJobs.length > 0) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                }
                throw new NetworkError(`Indeed page didn't render: ${verdict.signal}`, { platform: 'indeed' });
            }
            if (verdict.state === 'empty_confirmed') {
                logProgress('Indeed', `Page ${pageNum}: confirmed no results — stopping pagination`);
                break;
            }

            // results — extract via parseJobCard per card
            const $ = cheerio.load(html);
            const cardSelectors = [
                '.job_seen_beacon', '[data-testid="job-card"]', '.resultContent',
                'a[data-jk]', 'li[data-jk]', 'div[data-jk]',
            ];
            let $cards = $([]);
            for (const sel of cardSelectors) {
                $cards = $(sel);
                if ($cards.length > 0) {
                    logProgress('Indeed', `Page ${pageNum}: ${$cards.length} cards via ${sel}`);
                    break;
                }
            }
            let pageNewCount = 0;
            $cards.each((_, el) => {
                const $card = $(el);
                totalCardsProcessed++;
                const row = parseJobCard($, $card, domain);
                if (!row) return;
                if (row.__domChanged) { domChangedCardCount++; return; }
                if (allRawJobs.some((j) => j.jobKey === row.jobKey)) return;
                // Add jobId alias so extractJobDetails + normalizeJobData can
                // use job.jobId (their historic field name) without changes.
                allRawJobs.push({ ...row, jobId: row.jobKey });
                pageNewCount++;
            });

            collectedAnything = collectedAnything || allRawJobs.length > 0;
            logProgress('Indeed', `Page ${pageNum}: ${pageNewCount} new unique, total: ${allRawJobs.length}`);

            if (pageNewCount === 0) break;
            await new Promise((r) => setTimeout(r, humanDelay(2000, 5000)));
        }

        // Per-card DOM-changed batch gate. Gate on collectedJobs.length (not
        // collectedAnything) because detail enrichment hasn't run yet at this
        // point — collectedJobs is empty, so the partial-result short-circuit
        // would emit {jobs:[],partial:true} (silent data loss). Always throw
        // when the rate is exceeded so the failure is loud.
        if (totalCardsProcessed > 0) {
            const rate = domChangedCardCount / totalCardsProcessed;
            if (rate > DETAIL_DOM_CHANGED_THRESHOLD) {
                if (collectedJobs.length > 0) return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                throw new DomChangedError(
                    `Indeed card-level DOM-changed rate too high (${domChangedCardCount}/${totalCardsProcessed})`,
                    { platform: 'indeed' },
                );
            }
        }

        if (allRawJobs.length === 0) {
            return { jobs: [], emptyConfirmed: true };
        }

        // Detail enrichment via shared helper (same path the partial-result
        // sites use, so behavior is uniform).
        await enrichAndCollect();
        logProgress('Indeed', `Completed: ${collectedJobs.length} jobs`);
        if (collectedJobs.length === 0) return { jobs: [], emptyConfirmed: true };
        return collectedJobs;
    } finally {
        // Persistent context: close the context (flushes the profile to disk).
        // Anonymous: close the Browser (closes its context too). browser is
        // null in profile mode, so the optional-chain call is a no-op there.
        try { await context.close(); } catch { /* already closed */ }
        try { await browser?.close(); } catch { /* none / already closed */ }
    }
}
