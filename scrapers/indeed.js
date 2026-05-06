// Indeed Job Scraper Module
// Uses cookie-based authentication similar to Glassdoor scraper

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { stripHtmlTags } from '../src/core/html.js';
import { getCredentialsAPIClient } from '../src/api/credentials.js';

const log = createLogger('indeed');
const logProgress = (_scope, msg) => log.info(msg);

// Apply stealth plugin to avoid detection
chromium.use(StealthPlugin());

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
            expires: cookie.expirationDate ? Math.floor(cookie.expirationDate) : undefined
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
    const encodedJobTitle = encodeURIComponent(jobTitle);
    const encodedLocation = encodeURIComponent(location);
    
    // fromage=7 = last 7 days, sort=date for most recent
    let url = `https://${domain}/jobs?q=${encodedJobTitle}&l=${encodedLocation}&fromage=7&sort=date`;
    
    if (start > 0) {
        url += `&start=${start}`;
    }
    
    return url;
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

    // Fetch credentials from API
    const apiClient = getCredentialsAPIClient();
    const credential = await apiClient.getCredential('indeed', sessionId);
    
    if (!credential) {
        throw new Error('No Indeed credentials available from API');
    }

    const cookies = loadCookies(credential);
    logProgress('Indeed', `Loaded ${cookies.length} cookies`);

    const fingerprint = getRandomFingerprint();
    const domain = getIndeedDomain(location);
    
    logProgress('Indeed', `Using domain: ${domain}`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });

    const context = await browser.newContext({
        viewport: fingerprint.viewport,
        userAgent: fingerprint.userAgent,
        locale: fingerprint.locale,
        timezoneId: fingerprint.timezone,
        extraHTTPHeaders: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': `${fingerprint.locale};q=0.9,en;q=0.8`,
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    });

    // Add cookies to context
    await context.addCookies(cookies);
    
    const page = await context.newPage();
    let loginSuccess = false;

    try {
        // Navigate to Indeed homepage first to establish session
        logProgress('Indeed', 'Establishing session...');
        await page.goto(`https://${domain}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });
        await page.waitForTimeout(humanDelay(2000, 4000));
        
        // Close any initial popups
        await closePopups(page);
        
        loginSuccess = true;

        const allJobs = [];
        const seenJobIds = new Set();

        // Scrape multiple pages
        for (let pageNum = 0; pageNum < CONFIG.MAX_PAGES; pageNum++) {
            const start = pageNum * 10; // Indeed uses 10 jobs per page
            const searchUrl = buildSearchUrl(domain, jobTitle, location, start);
            
            logProgress('Indeed', `Fetching page ${pageNum + 1}: ${searchUrl}`);
            
            await page.goto(searchUrl, { 
                waitUntil: 'domcontentloaded', 
                timeout: 60000 
            });
            await page.waitForTimeout(humanDelay(3000, 5000));
            
            // Close any popups
            await closePopups(page);

            // Extract jobs from current page
            const html = await page.content();
            const pageJobs = extractJobsFromSearchPage(html, domain);
            
            logProgress('Indeed', `Page ${pageNum + 1}: Found ${pageJobs.length} jobs`);

            if (pageJobs.length === 0) {
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

        // Report success to API
        await apiClient.reportSuccess('indeed', `Scraped ${normalizedJobs.length} jobs successfully`);

        await browser.close();
        logProgress('Indeed', `Completed! Found ${normalizedJobs.length} jobs with details`);
        
        return normalizedJobs;

    } catch (error) {
        await browser.close();
        
        // Report failure to API
        if (!loginSuccess) {
            if (error.message.includes('cookie') || error.message.includes('login') || error.message.includes('auth')) {
                await apiClient.reportFailure('indeed', `Authentication failed: ${error.message}`, 0);
            } else if (error.message.includes('rate limit') || error.message.includes('blocked') || error.message.includes('captcha')) {
                await apiClient.reportFailure('indeed', `Rate limited or blocked: ${error.message}`, 60);
            } else {
                await apiClient.reportFailure('indeed', `Scraping error: ${error.message}`, 30);
            }
        } else {
            await apiClient.reportFailure('indeed', `Scraping error after login: ${error.message}`, 30);
        }
        
        throw error;
    }
}
