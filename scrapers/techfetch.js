// TechFetch Job Scraper Module - Using exact working scraper methodology
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { JSDOM } from 'jsdom';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { getCredentialsAPIClient } from '../src/api/credentials.js';

const log = createLogger('techfetch');
const logProgress = (_scope, msg) => log.info(msg);

// Apply stealth plugin
chromium.use(StealthPlugin());

class TechFetchScraper {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.cookies = null;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.detailDebugSaved = false; // Flag to save debug HTML only once
    }

    // Helper method to check if error is a network error
    isNetworkError(error) {
        const message = error.message || '';
        return message.includes('ERR_NETWORK_CHANGED') || 
               message.includes('Timeout') ||
               message.includes('net::') ||
               message.includes('Navigation failed') ||
               message.includes('ERR_CONNECTION') ||
               message.includes('ERR_NAME_NOT_RESOLVED');
    }

    // Helper method to navigate with retry logic
    async navigateWithRetry(url, options = {}, maxRetries = 3) {
        const defaultOptions = {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        };
        const navOptions = { ...defaultOptions, ...options };
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Add delay before retry attempts
                if (attempt > 1) {
                    const delay = 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s
                    logProgress('TechFetch', `   ⏳ Waiting ${delay/1000}s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
                const response = await this.page.goto(url, navOptions);
                return response;
            } catch (error) {
                if (this.isNetworkError(error) && attempt < maxRetries) {
                    logProgress('TechFetch', `   ⚠️  Network error (attempt ${attempt}/${maxRetries}): ${error.message.split('\n')[0]}`);
                    continue;
                }
                throw error;
            }
        }
    }

    async initialize() {
        logProgress('TechFetch', 'Launching browser...');
        this.browser = await chromium.launch({
            headless: true,  // Headless mode for stability
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        
        this.context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });
    }

    async login(retryCount = 0) {
        const maxRetries = 3;
        
        try {
            this.page = await this.context.newPage();
            
            // Handle JavaScript dialogs (alerts, confirms, prompts) automatically
            this.page.on('dialog', async dialog => {
                logProgress('TechFetch', `   📢 Dialog detected: "${dialog.message()}" - dismissing...`);
                try {
                    await dialog.dismiss();
                } catch (e) {
                    // Ignore errors if dialog already closed
                }
            });
            
            logProgress('TechFetch', `Logging in to TechFetch...${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);
            await this.navigateWithRetry('https://www.techfetch.com/js/js_login.aspx', {
                waitUntil: 'load',
                timeout: 60000
            });

            await this.page.waitForTimeout(2000);

            // Fill login form (correct field names: txtemailid and txtpwd)
            logProgress('TechFetch', 'Filling credentials...');
            await this.page.fill('input[name="txtemailid"], #txtemailid', this.email);
            await this.page.fill('input[name="txtpwd"], #txtpwd', this.password);
            
            await this.page.waitForTimeout(1000);

            // Click login button
            logProgress('TechFetch', 'Clicking login...');
            await this.page.click('input[type="submit"], button[type="submit"], #btnLogin, input[id*="Login"]');
            
            await this.page.waitForTimeout(5000);

            // Check if logged in
            const currentUrl = this.page.url();
            logProgress('TechFetch', `Current URL: ${currentUrl}`);
            
            if (currentUrl.includes('js_job_list') || currentUrl.includes('dashboard') || currentUrl.includes('js_s_jobs') || currentUrl.includes('js_my_resume')) {
                logProgress('TechFetch', 'Login successful!');
                
                // Get cookies
                this.cookies = await this.context.cookies();
                const jsLogin = this.cookies.find(c => c.name === 'JSLogin');
                const sessionId = this.cookies.find(c => c.name === 'ASP.NET_SessionId');
                
                logProgress('TechFetch', 'Session cookies obtained:');
                logProgress('TechFetch', `  - JSLogin: ${jsLogin ? '✓' : '✗'}`);
                logProgress('TechFetch', `  - ASP.NET_SessionId: ${sessionId ? '✓' : '✗'}`);
                
                // Navigate to js_s_jobs.aspx to initialize search session
                logProgress('TechFetch', 'Navigating to Fetch Jobs page...');
                await this.navigateWithRetry('https://www.techfetch.com/js/js_s_jobs.aspx', {
                    waitUntil: 'load',
                    timeout: 60000
                });
                await this.page.waitForTimeout(2000);
                logProgress('TechFetch', 'Ready to search jobs');
                
                return true;
            } else {
                logProgress('TechFetch', 'Login may have failed');
                return false;
            }
        } catch (error) {
            // Retry on network errors
            if (this.isNetworkError(error) && retryCount < maxRetries) {
                logProgress('TechFetch', `   ⚠️  Network error during login, retrying (${retryCount + 1}/${maxRetries}): ${error.message.split('\n')[0]}`);
                
                // Close current page and wait before retry
                try {
                    await this.page?.close();
                } catch (e) {}
                
                const delay = 5000 * Math.pow(2, retryCount); // 5s, 10s, 20s
                logProgress('TechFetch', `   ⏳ Waiting ${delay/1000}s before retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                
                return this.login(retryCount + 1);
            }
            throw error;
        }
    }

    async search(keywords, location = '') {
        logProgress('TechFetch', `Searching for: "${keywords}"${location ? ` in ${location}` : ''}`);
        
        // Already on js_s_jobs.aspx from login, just fill the search form
        await this.page.waitForTimeout(2000);

        // Try to fill search form if available
        try {
            // Wait for the keyword field
            await this.page.waitForSelector('#txtKeyword', { timeout: 5000 });
            
            logProgress('TechFetch', 'Filling keyword field...');
            await this.page.fill('#txtKeyword', keywords);
            
            // Note: TechFetch search form doesn't have a simple location text field
            // Location is selected via state dropdown which is complex
            // For now, we'll search by keyword only
            if (location) {
                logProgress('TechFetch', `Note: Location "${location}" will filter results after search (no location input field available)`);
            }
            
            logProgress('TechFetch', 'Clicking search button...');
            await this.page.click('input[type="submit"], button[type="submit"], #btnSearch');
            await this.page.waitForTimeout(3000);
            logProgress('TechFetch', 'Search submitted successfully');
        } catch (error) {
            logProgress('TechFetch', `❌ Search form error: ${error.message}`);
        }

        logProgress('TechFetch', 'On jobs page');
    }

    getCookieHeader() {
        return this.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    async fetchPageWithBrowser(pageNum, retryCount = 0) {
        const maxRetries = 3;
        
        try {
            logProgress('TechFetch', `Fetching page ${pageNum}...${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);
            
            const url = `https://www.techfetch.com/js/ajs_job_list.aspx?From=${pageNum}`;
            logProgress('TechFetch', `URL: ${url}`);
            
            // Add delay before retry attempts
            if (retryCount > 0) {
                const delay = 3000 * Math.pow(2, retryCount - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
            const response = await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            const html = await response.text();
            
            return html;
        } catch (error) {
            if (this.isNetworkError(error) && retryCount < maxRetries) {
                logProgress('TechFetch', `   ⚠️  Network error fetching page ${pageNum}, retrying (${retryCount + 1}/${maxRetries}): ${error.message.split('\n')[0]}`);
                return this.fetchPageWithBrowser(pageNum, retryCount + 1);
            }
            throw error;
        }
    }

    async extractJobDetails(jobLink, retryCount = 0) {
        const maxRetries = 3;
        const baseTimeout = 15000; // Increased from 3000ms to 15000ms
        const baseDelay = 2000;
        
        try {
            logProgress('TechFetch', `   Fetching details for: ${jobLink.split('/').pop().substring(0, 30)}...${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);
            
            // Add delay before request to avoid rate limiting (exponential backoff on retries)
            const delay = baseDelay * Math.pow(1.5, retryCount);
            await this.page.waitForTimeout(delay);
            
            const response = await this.page.goto(jobLink, {
                waitUntil: 'domcontentloaded',
                timeout: baseTimeout
            });
            
            await this.page.waitForTimeout(1500);
            const html = await response.text();
            
            const dom = new JSDOM(html);
            const document = dom.window.document;
            
            // Extract job description - the correct selector is #JobDescCKEditor
            let fullDescription = '';
            
            // The job description is in a span with id="JobDescCKEditor"
            const descElement = document.querySelector('#JobDescCKEditor, span.JobDescCKEditor, [id="JobDescCKEditor"]');
            if (descElement) {
                fullDescription = descElement.textContent.trim();
            }
            
            // Extract company name
            let company = 'N/A';
            const companyElement = document.querySelector('a[href*="/job-openings/"], span[id*="lblCompany"], div[id*="CompanyName"]');
            if (companyElement) {
                company = companyElement.textContent.trim() || 
                          companyElement.getAttribute('href')?.split('/job-openings/')?.[1] || 'N/A';
            }
            
            // Extract posted date/company from the recruiter info section
            let postedDate = 'N/A';
            const dateElement = document.querySelector('span[id*="lblDate"], div[id*="PostedDate"], .posted-date');
            if (dateElement) {
                postedDate = dateElement.textContent.trim();
            }
            
            // Extract duration
            let duration = 'N/A';
            const durationElement = document.querySelector('span[id*="lblDuration"], span[id*="Duration"]');
            if (durationElement) {
                const durationText = durationElement.textContent.trim();
                const durationMatch = durationText.match(/Duration\s*:\s*(.+)|(\d+\s*(?:year|month|day|week)s?.*)/i);
                if (durationMatch) {
                    duration = (durationMatch[1] || durationMatch[2]).trim();
                }
            }
            
            // Extract rate/salary
            let rate = 'N/A';
            const rateElement = document.querySelector('span[id*="lblRate"], span[id*="Salary"]');
            if (rateElement) {
                const rateText = rateElement.textContent.trim();
                const rateMatch = rateText.match(/Rate\/Salary\s*\(\$\)\s*:\s*(.+)|(\$[\d,]+.*|\d+\$)/i);
                if (rateMatch) {
                    rate = (rateMatch[1] || rateMatch[2]).trim();
                }
            }
            
            // Extract skills
            let skills = 'N/A';
            const skillsElement = document.querySelector('span[id*="lblSkills"], span[id*="Skills"]');
            if (skillsElement) {
                const skillsText = skillsElement.textContent.trim();
                const skillsMatch = skillsText.match(/Sp\.\s*Skills\s*:\s*(.+)|Skills:\s*(.+)/i);
                if (skillsMatch) {
                    skills = (skillsMatch[1] || skillsMatch[2]).trim();
                }
            }
            
            // Extract experience level (e.g., Architect, Senior, etc.)
            let experienceLevel = 'N/A';
            const expElement = document.querySelector('span#lblExp, span#lblMobExp');
            if (expElement) {
                experienceLevel = expElement.textContent.trim();
            }
            
            // Extract experience required (years) from job description
            let experienceRequired = 'N/A';
            if (fullDescription) {
                const expYearsMatch = fullDescription.match(/Experience(?:\s+Required)?:\s*(\d+[\+\-\s]*(?:Years?|yrs?))/i) ||
                                     fullDescription.match(/(\d+[\+\-\s]*(?:Years?|yrs?)\s+of\s+(?:overall\s+)?(?:IT\s+)?experience)/i);
                if (expYearsMatch) {
                    experienceRequired = expYearsMatch[1].trim();
                }
            }
            
            // Extract location
            let location = 'N/A';
            const locationElement = document.querySelector('span#lblLocation, span#lblMobLocation');
            if (locationElement) {
                location = locationElement.textContent.trim();
            }
            
            // Extract Company Location (from recruiter contact section) - clean extraction
            let companyLocation = 'N/A';
            const contactElement = document.querySelector('span#lblContact');
            if (contactElement) {
                // Extract just the city, state from the contact section
                const contactHTML = contactElement.innerHTML;
                // Look for pattern: CompanyName<br/>City, State<br/>
                const locationMatch = contactHTML.match(/<br\s*\/?>\s*([A-Za-z\s]+,\s*[A-Z]{2})\s*<br/i);
                if (locationMatch) {
                    companyLocation = locationMatch[1].trim();
                }
            }
            
            // Extract Work Authorization (check which ones have fa-check class)
            const workAuth = [];
            if (document.querySelector('#wauthuscicon.fa-check') || document.querySelector('#wauthuscmobicon.fa-check')) {
                workAuth.push('US Citizen');
            }
            if (document.querySelector('#wauthgcicon.fa-check') || document.querySelector('#wauthgcmobicon.fa-check')) {
                workAuth.push('GC');
            }
            if (document.querySelector('#wauthh1bicon.fa-check') || document.querySelector('#wauthh1bmobicon.fa-check')) {
                workAuth.push('H1B');
            }
            if (document.querySelector('#wauthtneadicon.fa-check') || document.querySelector('#wauthtneadmobicon.fa-check')) {
                const eadType = document.querySelector('span#wauthead, span#wautheadmob')?.textContent.trim() || 'EAD';
                workAuth.push(eadType);
            }
            
            // Extract Preferred Employment (check which ones have fa-check class)
            const prefEmployment = [];
            if (document.querySelector('#prefempccicon.fa-check') || document.querySelector('#prefempccmobicon.fa-check')) {
                prefEmployment.push('Corp-Corp');
            }
            if (document.querySelector('#prefempw2picon.fa-check') || document.querySelector('#prefempw2pmobicon.fa-check')) {
                prefEmployment.push('W2-Permanent');
            }
            if (document.querySelector('#prefempw2cicon.fa-check') || document.querySelector('#prefempw2cmobicon.fa-check')) {
                prefEmployment.push('W2-Contract');
            }
            if (document.querySelector('#prefemp1099icon.fa-check') || document.querySelector('#prefemp1099mobicon.fa-check')) {
                prefEmployment.push('1099-Contract');
            }
            if (document.querySelector('#prefempcontracticon.fa-check') || document.querySelector('#prefempcontractmobicon.fa-check')) {
                prefEmployment.push('Contract to Hire');
            }
            
            // Extract Employment Type (from jobEmpType section)
            let employmentType = 'N/A';
            const empTypeElement = document.querySelector('#jobEmpTypedetails, #mobjobemptypedetails');
            if (empTypeElement) {
                employmentType = empTypeElement.textContent.trim().replace(/\s+/g, ' ');
            }
            
            // Extract Required Skills
            let requiredSkills = 'N/A';
            const reqSkillsElement = document.querySelector('span#lblSpecSkill, span#lblMobSpecSkill');
            if (reqSkillsElement) {
                requiredSkills = reqSkillsElement.textContent.trim();
            }
            
            // Extract Preferred Skills
            let preferredSkills = 'N/A';
            const prefSkillsElement = document.querySelector('span#lblprefskill, span#lblMobprefSkill');
            if (prefSkillsElement && prefSkillsElement.textContent.trim()) {
                preferredSkills = prefSkillsElement.textContent.trim();
            }
            
            // Extract Special Area
            let specialArea = 'N/A';
            const specAreaElement = document.querySelector('span#lblSpecArea, span#lblMobSparea');
            if (specAreaElement) {
                specialArea = specAreaElement.textContent.trim();
            }
            
            // Extract Special Skills (already done above as 'skills', but using correct selector)
            let specialSkills = 'N/A';
            const specSkillsElement = document.querySelector('span#lblSpskills, span#lblMobSpskills');
            if (specSkillsElement) {
                specialSkills = specSkillsElement.textContent.trim();
            }
            
            // Extract Domain
            let domain = 'N/A';
            const domainElement = document.querySelector('span#lblDomain, span#lblMobDomain');
            if (domainElement) {
                domain = domainElement.textContent.trim();
            }
            
            return {
                fullDescription: fullDescription || '',
                company,
                companyLocation,
                postedDate,
                duration,
                rate,
                experienceLevel,
                experienceRequired,
                location,
                workAuthorization: workAuth.length > 0 ? workAuth.join(', ') : 'N/A',
                preferredEmployment: prefEmployment.length > 0 ? prefEmployment.join(', ') : 'N/A',
                employmentType,
                requiredSkills,
                preferredSkills,
                specialArea,
                specialSkills,
                domain
            };
        } catch (error) {
            // Retry on network errors
            if (this.isNetworkError(error) && retryCount < maxRetries) {
                logProgress('TechFetch', `   ⚠️  Network error, retrying (${retryCount + 1}/${maxRetries}): ${error.message.split('\n')[0]}`);
                
                // Try to recover the page/context on network errors
                try {
                    // Wait before retry with exponential backoff
                    const retryDelay = 3000 * Math.pow(2, retryCount);
                    logProgress('TechFetch', `   ⏳ Waiting ${retryDelay/1000}s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    
                    // Try to navigate to a known page to reset connection
                    await this.page.goto('https://www.techfetch.com/js/js_s_jobs.aspx', {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    }).catch(() => {}); // Ignore errors on recovery navigation
                    
                    await this.page.waitForTimeout(1000);
                } catch (recoveryError) {
                    logProgress('TechFetch', `   ⚠️  Recovery navigation failed: ${recoveryError.message}`);
                }
                
                // Retry the request
                return this.extractJobDetails(jobLink, retryCount + 1);
            }
            
            logProgress('TechFetch', `   ⚠️  Error fetching job details: ${error.message.split('\n')[0]}`);
            return {
                fullDescription: '',
                company: 'N/A',
                companyLocation: 'N/A',
                postedDate: 'N/A',
                duration: 'N/A',
                rate: 'N/A',
                experienceLevel: 'N/A',
                experienceRequired: 'N/A',
                location: 'N/A',
                workAuthorization: 'N/A',
                preferredEmployment: 'N/A',
                employmentType: 'N/A',
                requiredSkills: 'N/A',
                preferredSkills: 'N/A',
                specialArea: 'N/A',
                specialSkills: 'N/A',
                domain: 'N/A'
            };
        }
    }

    extractJobs(html) {
        const dom = new JSDOM(html);
        const document = dom.window.document;
        const jobs = [];

        const jobDivs = document.querySelectorAll('[id*="_divJob"]');
        logProgress('TechFetch', `Found ${jobDivs.length} job divs on page`);
        
        // Debug: Try alternative selectors if main one fails
        if (jobDivs.length === 0) {
            const alternativeSelectors = [
                '.job-item',
                '[class*="job"]',
                'div[id*="job"]',
                'div.divjob',
                '.divJob'
            ];
            
            for (const selector of alternativeSelectors) {
                const altDivs = document.querySelectorAll(selector);
                if (altDivs.length > 0) {
                    logProgress('TechFetch', `Found ${altDivs.length} elements with selector: ${selector}`);
                }
            }
        }
        
        jobDivs.forEach(jobDiv => {
            try {
                const titleSpan = jobDiv.querySelector('[id*="_lblTitle"]');
                if (!titleSpan) return;
                
                const titleLink = titleSpan.querySelector('a');
                if (!titleLink) return;
                
                const jobTitle = titleLink.textContent.trim();
                const jobLink = titleLink.getAttribute('href');
                const fullJobLink = jobLink.startsWith('http') 
                    ? jobLink 
                    : `https://www.techfetch.com${jobLink}`;
                
                const logoDiv = jobDiv.querySelector('[id*="_jllogo"]');
                const companyLink = logoDiv?.querySelector('a');
                const company = companyLink?.getAttribute('href')?.split('/job-openings/')?.[1] 
                    || logoDiv?.querySelector('img')?.getAttribute('alt') 
                    || 'N/A';
                
                const locationSpan = jobDiv.querySelector('[id*="_lblLocation"]');
                const location = locationSpan?.textContent.trim() || 'N/A';
                
                const rateSpan = jobDiv.querySelector('[id*="_lblRate"]');
                const rate = rateSpan?.textContent.trim() || 'N/A';
                
                const descDiv = jobDiv.querySelector('[id*="_lblDesc"], [id*="_lblJobDesc"]');
                const description = descDiv?.textContent.trim() || '';
                
                jobs.push({
                    jobTitle,
                    jobLink: fullJobLink,
                    description,
                    company,
                    location,
                    rate
                });
            } catch (error) {
                logProgress('TechFetch', `Error parsing job: ${error.message}`);
            }
        });

        return jobs;
    }

    // Helper method to check if job location matches the search location
    matchesLocation(jobLocation, searchLocation) {
        if (!searchLocation || searchLocation.trim() === '') {
            return true; // No location filter, all jobs match
        }
        
        if (!jobLocation || jobLocation === 'N/A') {
            return true; // Include jobs with unknown location (might be remote)
        }
        
        const searchLower = searchLocation.toLowerCase().trim();
        const jobLower = jobLocation.toLowerCase().trim();
        
        // State name to abbreviation mapping
        const stateMap = {
            'alabama': 'al', 'alaska': 'ak', 'arizona': 'az', 'arkansas': 'ar',
            'california': 'ca', 'colorado': 'co', 'connecticut': 'ct', 'delaware': 'de',
            'florida': 'fl', 'georgia': 'ga', 'hawaii': 'hi', 'idaho': 'id',
            'illinois': 'il', 'indiana': 'in', 'iowa': 'ia', 'kansas': 'ks',
            'kentucky': 'ky', 'louisiana': 'la', 'maine': 'me', 'maryland': 'md',
            'massachusetts': 'ma', 'michigan': 'mi', 'minnesota': 'mn', 'mississippi': 'ms',
            'missouri': 'mo', 'montana': 'mt', 'nebraska': 'ne', 'nevada': 'nv',
            'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
            'north carolina': 'nc', 'north dakota': 'nd', 'ohio': 'oh', 'oklahoma': 'ok',
            'oregon': 'or', 'pennsylvania': 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
            'south dakota': 'sd', 'tennessee': 'tn', 'texas': 'tx', 'utah': 'ut',
            'vermont': 'vt', 'virginia': 'va', 'washington': 'wa', 'west virginia': 'wv',
            'wisconsin': 'wi', 'wyoming': 'wy', 'district of columbia': 'dc'
        };
        
        // Reverse mapping (abbreviation to full name)
        const abbrevToState = Object.fromEntries(
            Object.entries(stateMap).map(([k, v]) => [v, k])
        );
        
        // Check for "remote" jobs - always include them
        if (jobLower.includes('remote') || jobLower.includes('work from home')) {
            return true;
        }
        
        // Direct match
        if (jobLower.includes(searchLower)) {
            return true;
        }
        
        // Check if search is a state name, match against abbreviation
        if (stateMap[searchLower]) {
            const abbrev = stateMap[searchLower];
            // Match patterns like "City, CA" or "CA" at end
            if (jobLower.includes(`, ${abbrev}`) || jobLower.endsWith(` ${abbrev}`)) {
                return true;
            }
        }
        
        // Check if search is a state abbreviation, match against full name
        if (abbrevToState[searchLower]) {
            const fullName = abbrevToState[searchLower];
            if (jobLower.includes(fullName)) {
                return true;
            }
        }
        
        return false;
    }

    async scrapeJobs(keywords, location, maxPages = 2, includeDetails = true) {
        await this.initialize();
        
        const loginSuccess = await this.login();
        if (!loginSuccess) {
            throw new Error('Login failed. Please check credentials.');
        }
        
        await this.search(keywords, location);

        const allJobs = [];
        const maxJobs = 30;
        let totalScraped = 0;
        let totalFiltered = 0;
        
        for (let page = 1; page <= maxPages; page++) {
            try {
                const html = await this.fetchPageWithBrowser(page);
                const jobs = this.extractJobs(html);
                
                if (jobs.length === 0) {
                    logProgress('TechFetch', `⚠️  No more jobs found on page ${page}`);
                    break;
                }
                
                totalScraped += jobs.length;
                
                // Fetch additional details for each job if requested
                if (includeDetails) {
                    logProgress('TechFetch', `   📋 Fetching details for ${jobs.length} jobs...`);
                    for (let i = 0; i < jobs.length; i++) {
                        const job = jobs[i];
                        const details = await this.extractJobDetails(job.jobLink);
                        
                        // Merge details, preferring detail page data over list page data when available
                        jobs[i] = {
                            jobTitle: job.jobTitle,
                            jobLink: job.jobLink,
                            description: details.fullDescription || job.description,
                            company: details.company !== 'N/A' ? details.company : job.company,
                            companyLocation: details.companyLocation,
                            location: details.location !== 'N/A' ? details.location : job.location,
                            rate: details.rate !== 'N/A' ? details.rate : job.rate,
                            postedDate: details.postedDate,
                            duration: details.duration,
                            experienceLevel: details.experienceLevel,
                            experienceRequired: details.experienceRequired,
                            workAuthorization: details.workAuthorization,
                            preferredEmployment: details.preferredEmployment,
                            employmentType: details.employmentType,
                            requiredSkills: details.requiredSkills,
                            preferredSkills: details.preferredSkills,
                            specialArea: details.specialArea,
                            specialSkills: details.specialSkills,
                            domain: details.domain
                        };
                        
                        // Delay is now handled in extractJobDetails with exponential backoff
                    }
                }
                
                // Filter jobs by location if specified
                const filteredJobs = location 
                    ? jobs.filter(job => this.matchesLocation(job.location, location))
                    : jobs;
                
                const filteredOut = jobs.length - filteredJobs.length;
                totalFiltered += filteredOut;
                
                if (location && filteredOut > 0) {
                    logProgress('TechFetch', `   📍 Location filter: ${filteredJobs.length}/${jobs.length} jobs match "${location}"`);
                }
                
                allJobs.push(...filteredJobs);
                logProgress('TechFetch', `✅ Extracted ${filteredJobs.length} jobs from page ${page} (Total: ${allJobs.length})`);
                
                // Stop if we've reached the job limit
                if (allJobs.length >= maxJobs) {
                    allJobs.splice(maxJobs); // Trim to exactly maxJobs
                    logProgress('TechFetch', `Reached ${maxJobs} job limit. Stopping...`);
                    break;
                }
                
                // Rate limiting
                if (page < maxPages) {
                    logProgress('TechFetch', '⏳ Waiting 3 seconds before next page...');
                    await this.page.waitForTimeout(3000);
                }
            } catch (error) {
                logProgress('TechFetch', `❌ Error fetching page ${page}: ${error.message}`);
                break;
            }
        }

        logProgress('TechFetch', '🎉 Scraping complete!');
        if (location && totalFiltered > 0) {
            logProgress('TechFetch', `📊 Summary: ${allJobs.length} jobs match "${location}" (filtered out ${totalFiltered} from ${totalScraped} total)`);
        }
        logProgress('TechFetch', '🔄 Closing browser...');
        await this.browser.close();
        
        return allJobs;
    }
}       

// Export function for UnifiedJobScraper
export async function scrapeTechFetch(jobTitle, location, sessionId = null) {
    logProgress('TechFetch', `Starting TechFetch scraper for "${jobTitle}" in "${location || 'any location'}"`);
    
    const apiClient = getCredentialsAPIClient();
    const maxAttempts = 3;
    let attemptCount = 0;
    let lastError = null;
    
    // Retry loop: Try up to maxAttempts credentials
    while (attemptCount < maxAttempts) {
        attemptCount++;
        
        // Fetch credentials from API with wait-and-retry logic
        logProgress('TechFetch', `\n🔑 Attempting to fetch credential (attempt ${attemptCount}/${maxAttempts})...`);
        
        let credential = null;
        const maxCredentialRetries = 10; // Wait for credentials up to 10 times
        const credentialRetryDelay = 60000; // 60 seconds between retries
        
        for (let credRetry = 0; credRetry < maxCredentialRetries; credRetry++) {
            credential = await apiClient.getCredential('techfetch', sessionId);
            
            if (credential) {
                // Got a credential, break out of retry loop
                break;
            }
            
            if (credRetry < maxCredentialRetries - 1) {
                logProgress('TechFetch', `⏳ No credentials available, waiting ${credentialRetryDelay/1000}s before retry ${credRetry + 1}/${maxCredentialRetries}...`);
                await new Promise(resolve => setTimeout(resolve, credentialRetryDelay));
            }
        }
        
        if (!credential) {
            logProgress('TechFetch', `⚠️  No TechFetch credentials available after ${maxCredentialRetries} retries`);
            if (lastError) {
                throw lastError;
            }
            throw new Error('No TechFetch credentials available from API');
        }
        
        // Print credential info (mask password)
        logProgress('TechFetch', `✅ Credential fetched:`);
        logProgress('TechFetch', `   📧 Email: ${credential.email}`);
        logProgress('TechFetch', `   🔒 Password: ${'*'.repeat(credential.password?.length || 8)}`);
        logProgress('TechFetch', `   🆔 Credential ID: ${credential.id}`);
        
        const scraper = new TechFetchScraper(
            credential.email,
            credential.password
        );
        
        let loginSuccess = false;
        
        try {
            // If location is specified, fetch more pages to compensate for filtering
            const maxPages = location ? 5 : 2; // More pages when filtering by location
            const jobs = await scraper.scrapeJobs(jobTitle, location, maxPages, true);
            
            // Mark login as successful if we got this far
            loginSuccess = true;
            
            // Normalize job data using utils function
            const normalizedJobs = jobs.map(job => normalizeJobData({
            title: job.jobTitle,
            company: job.company,
            location: job.location,
            postedDate: job.postedDate,
            description: job.description,
            salary: job.rate,
            url: job.jobLink,
            employmentType: job.employmentType,
            skills: job.requiredSkills ? job.requiredSkills.split(',').map(s => s.trim()) : [],
            applyUrl: job.jobLink,
            // TechFetch specific fields preserved
            duration: job.duration,
            experienceLevel: job.experienceLevel,
            experienceRequired: job.experienceRequired,
            workAuthorization: job.workAuthorization,
            preferredEmployment: job.preferredEmployment,
            requiredSkills: job.requiredSkills,
            preferredSkills: job.preferredSkills,
            specialArea: job.specialArea,
            specialSkills: job.specialSkills,
            domain: job.domain,
            companyLocation: job.companyLocation
        }, 'techfetch'));
        
        // Report success to API
        await apiClient.reportSuccess('techfetch', `Scraped ${normalizedJobs.length} jobs successfully`);
        
        logProgress('TechFetch', `✅ Successfully scraped ${normalizedJobs.length} jobs from TechFetch`);
        return normalizedJobs;
        
    } catch (error) {
        logProgress('TechFetch', `❌ Error: ${error.message}`);
        
        lastError = error;
        
        // Report failure to API
        if (!loginSuccess) {
            // Login or authentication failure - try next credential
            if (error.message.includes('Login') || error.message.includes('credentials')) {
                logProgress('TechFetch', '🔄 Login failed - will try next credential...');
                logProgress('TechFetch', '📤 Notifying system: WRONG CREDENTIALS (permanent failure)');
                await apiClient.reportFailure('techfetch', `Login failed: ${error.message}`, 0);
            } else if (error.message.includes('rate limit')) {
                logProgress('TechFetch', '⏳ Rate limited - will try next credential...');
                logProgress('TechFetch', '📤 Notifying system: RATE LIMIT (60 min cooldown)');
                await apiClient.reportFailure('techfetch', `Rate limited: ${error.message}`, 60);
            } else {
                // Any other error during login/setup phase - treat as credential failure
                logProgress('TechFetch', '⚠️  Credential error - will try next credential...');
                logProgress('TechFetch', `   Error details: ${error.message}`);
                logProgress('TechFetch', '📤 Notifying system: CREDENTIAL ERROR (permanent failure)');
                await apiClient.reportFailure('techfetch', `Credential error: ${error.message}`, 0);
            }
            // Continue to next credential attempt
            continue;
        } else {
            // If login was successful but scraping failed, still try next credential
            logProgress('TechFetch', '⚠️  Scraping error after login - will try next credential...');
            logProgress('TechFetch', '📤 Notifying system: SCRAPING ERROR (30 min cooldown)');
            await apiClient.reportFailure('techfetch', `Scraping error: ${error.message}`, 30);
            continue;
        }
    }
    } // End of while loop
    
    // If we exhausted all attempts, throw the last error
    logProgress('TechFetch', `\n❌ All ${maxAttempts} credential attempts failed`);
    throw lastError || new Error('All TechFetch credential attempts failed');
}
