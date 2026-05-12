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
import { normalizeJobData } from '../src/core/normalize.js';

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

// Extract jobs from HTML
function extractJobsFromHTML(html) {
    const $ = cheerio.load(html);
    const jobs = [];

    $('.jobCard').each((index, element) => {
        const jobCard = $(element);
        const jobTitle = jobCard.find('[data-test="job-title"]').text().trim();
        const companyName = jobCard.find('[data-test="job-employer"]').text().trim() ||
                          jobCard.find('.EmployerProfile_compactEmployerName__9MGcV').text().trim();
        const location = jobCard.find('[data-test="emp-location"]').text().trim();
        const salary = jobCard.find('[data-test="detailSalary"]').text().trim();
        const jobLink = jobCard.find('[data-test="job-link"]').attr('href');
        const easyApply = jobCard.find('.JobCard_easyApplyTag__5vlo5').length > 0;
        const ratingElement = jobCard.find('.rating-single-star_RatingText__5fdjN');
        const companyRating = ratingElement.length > 0 ? parseFloat(ratingElement.text().trim()) : null;
        const jobId = jobCard.find('[data-test="job-title"]').attr('id')?.replace('job-title-', '') ||
                     jobCard.find('[data-test="job-link"]').attr('href')?.match(/jl=(\d+)/)?.[1];

        if (jobTitle) {
            jobs.push({
                jobId,
                jobTitle,
                companyName,
                location,
                salaryEstimate: salary,
                jobLink: jobLink ? `https://www.glassdoor.co.in${jobLink}` : null,
                easyApply,
                companyRating
            });
        }
    });

    return jobs.filter((job, index, self) =>
        index === self.findIndex(j => j.jobId && j.jobId === job.jobId)
    );
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
        // Build a proper Glassdoor job detail URL from the jobListingId
        const detailUrl = `https://www.glassdoor.co.in/job-listing/j?jl=${job.jobId}`;
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
export async function scrapeGlassdoor(jobTitle, location, sessionId = null) {
    logProgress('Glassdoor', `Searching for "${jobTitle}" in "${location}"`);

    // sessionId is kept in the signature for orchestrator compatibility,
    // but CloakBrowser anonymous-launches don't need credentials — the
    // stealth Chromium binary itself defeats Cloudflare's bot check.
    void sessionId;

    logProgress('Glassdoor', `🚀 Launching CloakBrowser stealth Chromium...`);
    const browser = await launch({
        headless: true,
        // humanize: false — we drive page.goto + scrollBy ourselves;
        // no mouse curves needed since we never click anything where
        // behavioral detection matters.
    });
    logProgress('Glassdoor', `✅ CloakBrowser ready`);

    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    const page = await context.newPage();

    let loginSuccess = false;

    try {
        // Determine domain based on location
        const domain = location.toLowerCase().includes('india') || location.toLowerCase() === 'in' 
            ? 'glassdoor.co.in' 
            : 'glassdoor.com';
        
        logProgress('Glassdoor', `Using domain: ${domain} for location: ${location}`);
        
        // Navigate to homepage first
        logProgress('Glassdoor', 'Navigating to Glassdoor...');
        await page.goto(`https://www.${domain}/index.htm`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await page.waitForTimeout(humanDelay(3000, 5000));
        
        // Mark as login success if we got past homepage
        loginSuccess = true;

        // Navigate to search - use simple search URL with fromAge=7 filter
        const encodedJobTitle = encodeURIComponent(jobTitle);
        const encodedLocation = encodeURIComponent(location);
        const searchUrl = `https://www.${domain}/Job/jobs.htm?sc.keyword=${encodedJobTitle}&locT=N&locId=&jobType=&context=Jobs&sc.location=${encodedLocation}&fromAge=7`;

        logProgress('Glassdoor', 'Navigating to job search...');
        await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await page.waitForTimeout(humanDelay(5000, 8000));

        // Load all jobs
        await page.waitForTimeout(humanDelay(2000, 4000));
        await loadAllJobs(page, 30);

        // Extract jobs
        logProgress('Glassdoor', 'Extracting jobs from page...');
        const html = await page.content();
        const allJobs = extractJobsFromHTML(html);
        const jobs = allJobs.slice(0, 30);

        logProgress('Glassdoor', `Found ${jobs.length} jobs`);

        // Extract detailed information
        logProgress('Glassdoor', `Extracting details with ${CONFIG.CONCURRENT_TABS} parallel tabs...`);
        await extractJobDetailsInParallel(context, jobs, CONFIG.CONCURRENT_TABS);

        // Normalize and return
        const jobDetails = jobs.map(job => normalizeJobData({
            title: job.jobTitle,
            company: job.companyName,
            location: job.location,
            url: job.jobLink,
            description: job.details?.fullDescription || 'N/A',
            salary: job.salaryEstimate || 'N/A',
            rating: job.companyRating,
            easyApply: job.easyApply
        }, 'Glassdoor'));

        // CloakBrowser cleanup: full close — this browser is dedicated
        // to this scrape.
        try { await browser.close(); } catch { /* already closed */ }
        logProgress('Glassdoor', `Completed! Found ${jobDetails.length} jobs with details`);
        return jobDetails;

    } catch (error) {
        // No credentials to release — CloakBrowser anonymous launches
        // have no per-scrape state to clean up. Just close the browser.
        try { await browser.close(); } catch { /* already closed */ }
        // loginSuccess is preserved for log clarity (whether the page
        // loaded vs. failed at navigation); we don't act on it.
        void loginSuccess;
        throw error;
    }
}
