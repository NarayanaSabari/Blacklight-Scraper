// Indeed Job Scraper Module
//
// Uses CloakBrowser — stealth Chromium with source-level C++ fingerprint
// patches — combined with cookie-based auth from the credentials API.
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
import * as cheerio from 'cheerio';
import { launch } from 'cloakbrowser';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { stripHtmlTags } from '../src/core/html.js';
import { getCredentialsAPIClient } from '../src/api/credentials.js';
import { assertNotBlocked } from '../src/core/block-detection.js';

// Flag-gated hardening (audit I1/I13/I2). Read once. When this is NOT
// 'true' (the default/shipped state) Indeed behaves byte-identically to
// the pre-1C scraper: loginSuccess set early, any 0-card page ends
// pagination, no block detection. Flipping SCRAPER_STRICT_EMPTY=true
// per-host activates: a Cloudflare/DataDome challenge throws (→ cooldown
// + 'blocked' metric) instead of a silent successful 0-job scrape.
const STRICT = process.env.SCRAPER_STRICT_EMPTY === 'true';

const log = createLogger('indeed');
const logProgress = (_scope, msg) => log.info(msg);

// Configuration
const CONFIG = {
    CONCURRENT_TABS: 5,
    MAX_JOBS: 50,
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
 * Load cookies from credential object (array format from API/local config)
 * @param {Object} credential - Credential object with cookies array
 * @returns {Array} Playwright-compatible cookie array
 */
// Normalize an expirationDate to Unix seconds.
// Cookie-export tools differ:
//   - Brave/Chrome "Cookie Editor" extension exports as Unix seconds (number)
//   - Some browser tools (and the centralD upload path) export as ISO 8601
//     strings ("2026-05-07T11:48:47.814Z")
// Math.floor("2026-...") returns NaN, and Playwright's addCookies rejects
// NaN expires with the unhelpful "Protocol error (Storage.setCookies):
// Invalid parameters". Handle both shapes here so a fresh cookie export
// from any common tool just works.
function parseExpiry(raw) {
    if (raw === null || raw === undefined || raw === '') return undefined;
    if (typeof raw === 'number' && isFinite(raw)) return Math.floor(raw);
    if (typeof raw === 'string') {
        // Numeric string ("1806254047.084")
        const asNum = Number(raw);
        if (isFinite(asNum) && asNum > 0) return Math.floor(asNum);
        // ISO 8601 ("2026-05-07T11:48:47.814Z")
        const ms = Date.parse(raw);
        if (!isNaN(ms)) return Math.floor(ms / 1000);
    }
    return undefined;
}

function loadCookies(credential) {
    let cookies = [];

    if (Array.isArray(credential.credentials)) {
        // API/local format: array of cookie objects
        cookies = credential.credentials.map(cookie => ({
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
    } else if (credential.cookies) {
        // Alternative format: cookies property
        cookies = credential.cookies;
    }

    return cookies;
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
 * @returns {Array} Array of normalized job objects
 */
export async function scrapeIndeed(jobTitle, location, sessionId = null) {
    logProgress('Indeed', `Searching for "${jobTitle}" in "${location}"`);

    // Lease an Indeed credential — required for pagination beyond page 1.
    //
    // Uses the lease-based API (`acquire` → `lease.reportSuccess/Failure`)
    // NOT the legacy platform-keyed API. The legacy `reportSuccess('indeed')`
    // resolves through latestByPlatform which is overwritten by any later
    // concurrent acquire — so two parallel indeed scrapes would release
    // each other's leases. Lease-keyed reports always target the right lease.
    const apiClient = getCredentialsAPIClient();
    const lease = await apiClient.acquire('indeed', sessionId);
    if (!lease) {
        // Race-window fallback: orchestrator's pre-flight should have
        // excluded indeed from the claim if no creds were free, but the
        // last cred can disappear between check and acquire (concurrent
        // scraper grabbed it first). Tag the error so the orchestrator
        // submits status='skipped' (not 'failed') and the role goes
        // back to the queue cleanly — no credential burn, no false
        // failure metric.
        const err = new Error('No Indeed credentials available from API');
        err.skipNoCreds = true;
        throw err;
    }
    const credential = lease.credential;
    const cookies = loadCookies(credential);
    logProgress('Indeed', `Acquired credential (${cookies.length} cookies)`);

    const domain = getIndeedDomain(location);
    logProgress('Indeed', `Using domain: ${domain}`);
    logProgress('Indeed', `🚀 Launching CloakBrowser stealth Chromium...`);

    // humanize:true is required — Cloudflare/Akamai score behavioral
    // signals separately from fingerprints. See module header.
    const browser = await launch({ headless: true, humanize: true });
    logProgress('Indeed', `✅ CloakBrowser ready`);

    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Inject cookies before opening any page. Per-cookie retry: a single
    // malformed entry from a cookie export shouldn't take down the whole
    // batch (seen with `expirationDate` shape drift in older exports).
    let cookiesAdded = 0;
    try {
        await context.addCookies(cookies);
        cookiesAdded = cookies.length;
    } catch (bulkErr) {
        logProgress('Indeed', `Bulk addCookies failed (${bulkErr.message}) — falling back to per-cookie`);
        for (const c of cookies) {
            try { await context.addCookies([c]); cookiesAdded++; } catch { /* skip bad cookie */ }
        }
    }
    logProgress('Indeed', `Cookies injected: ${cookiesAdded}/${cookies.length}`);

    const page = await context.newPage();
    let loginSuccess = false;

    try {
        // No homepage warmup — visiting https://www.indeed.com triggers
        // a regional redirect (e.g. in.indeed.com from Indian IPs), which
        // then makes the navigation back to www.indeed.com look bot-like
        // to Cloudflare. Probe confirmed direct-to-search returns 200.
        // I13: setting loginSuccess=true before any navigation makes the
        // catch-block cooldown taxonomy dead code. In STRICT mode defer it
        // to confirmed page 0 (see loop). When NOT strict keep legacy
        // early-true so behavior is byte-identical.
        if (!STRICT) loginSuccess = true;

        const allJobs = [];
        const seenJobIds = new Set();
        let sawConfirmedEmpty = false;

        // Scrape multiple pages
        for (let pageNum = 0; pageNum < CONFIG.MAX_PAGES; pageNum++) {
            const start = pageNum * 10; // Indeed uses 10 jobs per page
            const searchUrl = buildSearchUrl(domain, jobTitle, location, start);
            
            logProgress('Indeed', `Fetching page ${pageNum + 1}: ${searchUrl}`);

            // waitUntil:'load' gives Cloudflare's JS challenge time to run.
            // domcontentloaded fires while still on the challenge page and
            // we end up parsing the "Additional Verification Required" page.
            const navResp = await page.goto(searchUrl, {
                waitUntil: 'load',
                timeout: 60000
            });
            await page.waitForTimeout(humanDelay(8000, 12000));

            // Close any popups
            await closePopups(page);

            // Extract jobs from current page
            const html = await page.content();

            // STRICT: throw on a Cloudflare/DataDome/auth-wall challenge so
            // a block becomes a loud failure (cooldown + 'blocked' metric)
            // instead of a silent successful 0-job scrape (audit I1/F4).
            // M5: inspects the SEARCH RESULTS document, never a job title.
            if (STRICT) {
                assertNotBlocked({
                    status: typeof navResp?.status === 'function' ? navResp.status() : null,
                    finalUrl: page.url(),
                    title: await page.title().catch(() => ''),
                    html,
                    platform: 'indeed',
                });
            }

            const pageJobs = extractJobsFromSearchPage(html, domain);

            logProgress('Indeed', `Page ${pageNum + 1}: Found ${pageJobs.length} jobs`);

            // I13: not blocked and page 0 — genuinely past Cloudflare.
            if (STRICT && pageNum === 0) loginSuccess = true;

            if (pageJobs.length === 0) {
                // I2: page-0 zero is NOT "end of results" — it is a block
                // or DOM change UNLESS Indeed positively shows its
                // no-results marker. Later pages legitimately end here.
                // Note: this lands the 30-min "after login" cooldown (loginSuccess=true by here) — intentional: a true CF/DataDome block was already caught above by the block-detection guard (60-min); reaching here means DOM-change-like, not a fingerprint block.
                if (STRICT && pageNum === 0 && !indeedNoResults(html)) {
                    throw new Error('Indeed page 1 returned 0 jobs with no "no results" marker — suspected block / DOM change');
                }
                if (pageNum === 0 && indeedNoResults(html)) {
                    logProgress('Indeed', 'Indeed reports no matching jobs (confirmed empty)');
                    sawConfirmedEmpty = true;
                }
                logProgress('Indeed', 'No more jobs found, stopping pagination');
                break;
            }

            // Add unique jobs
            for (const job of pageJobs) {
                if (!seenJobIds.has(job.jobId)) {
                    seenJobIds.add(job.jobId);
                    allJobs.push(job);
                }
                
                if (allJobs.length >= CONFIG.MAX_JOBS) {
                    break;
                }
            }

            logProgress('Indeed', `Total unique jobs collected: ${allJobs.length}`);

            if (allJobs.length >= CONFIG.MAX_JOBS) {
                logProgress('Indeed', `Reached max jobs limit (${CONFIG.MAX_JOBS})`);
                break;
            }

            // Small delay between pages
            if (pageNum < CONFIG.MAX_PAGES - 1) {
                await page.waitForTimeout(humanDelay(2000, 4000));
            }
        }

        // Limit to max jobs
        const jobsToProcess = allJobs.slice(0, CONFIG.MAX_JOBS);
        
        logProgress('Indeed', `Extracting details for ${jobsToProcess.length} jobs with ${CONFIG.CONCURRENT_TABS} parallel tabs...`);
        
        // Extract detailed information for each job
        await extractJobDetailsInParallel(context, jobsToProcess, CONFIG.CONCURRENT_TABS);

        // Normalize job data
        const normalizedJobs = jobsToProcess.map(job => normalizeJobData({
            id: job.jobId,
            title: job.title,
            company: job.company,
            location: job.location,
            description: job.description || job.snippet,
            salary: job.salary,
            url: job.url,
            postedDate: job.postedDate,
            employmentType: job.employmentType,
            easyApply: job.easyApply,
            isRemote: job.isRemote,
            rating: job.companyRating,
            skills: job.skills
        }, 'Indeed'));

        try { await browser.close(); } catch { /* already closed */ }
        logProgress('Indeed', `Completed! Found ${normalizedJobs.length} jobs with details`);

        await lease.reportSuccess(`Scraped ${normalizedJobs.length} jobs successfully`);

        // BaseScraper (Plan 1A) accepts Array OR { jobs, emptyConfirmed }.
        // emptyConfirmed only when Indeed positively showed its no-results
        // marker. Scrape FLOW is byte-identical when STRICT off; emptyConfirmed may be
        // true on a genuine no-results page (intended: suppresses the
        // Plan 1B unconfirmed-zero warning for real empties).
        return { jobs: normalizedJobs, emptyConfirmed: sawConfirmedEmpty && normalizedJobs.length === 0 };

    } catch (error) {
        try { await browser.close(); } catch { /* already closed */ }

        // Map error to a cooldown so a flaky cookie doesn't keep getting
        // handed out to fresh scrape sessions. Cooldowns from prior CDP-
        // path: auth=0min (cookie immediately re-checked next acquire),
        // rate-limit=60min (back off this IP/cookie pair), other=30min.
        const msg = error.message || '';
        if (!loginSuccess) {
            if (/cookie|login|auth|sign in/i.test(msg)) {
                await lease.reportFailure(`Authentication failed: ${msg}`, 0);
            } else if (/rate limit|blocked|captcha|cloudflare|verification/i.test(msg)) {
                await lease.reportFailure(`Rate limited or blocked: ${msg}`, 60);
            } else {
                await lease.reportFailure(`Scraping error: ${msg}`, 30);
            }
        } else {
            await lease.reportFailure(`Scraping error after login: ${msg}`, 30);
        }
        throw error;
    }
}
