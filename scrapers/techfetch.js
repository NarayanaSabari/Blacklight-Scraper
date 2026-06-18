// TechFetch Job Scraper Module — CloakBrowser stealth Chromium (fleet-consistent
// with linkedin/monster/dice/indeed/glassdoor). Was playwright-extra +
// puppeteer-extra-plugin-stealth; CloakBrowser supplies a coherent stealth
// fingerprint out of the box, so the manual launch args + StealthPlugin + the
// hardcoded Chrome/120 UA are no longer needed.
import { launch } from 'cloakbrowser';
import { JSDOM } from 'jsdom';
import { createLogger } from '../src/logger/index.js';
import { applyResourceBlocking } from '../src/core/resource-blocking.js';
import { getProxyPool } from '../src/core/proxy-pool.js';
import { stealthLaunchOptions } from '../src/core/launch-config.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { getCredentialsAPIClient } from '../src/api/credentials.js';
import { AuthError, BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
import {
    cooldownPath, cooldownMs, readCooldownMarker, writeCooldownMarker, isOnCooldown,
    defaultReadFile, defaultWriteFile, defaultRename,
} from '../src/core/techfetch-cooldown.js';

const log = createLogger('techfetch');
const logProgress = (_scope, msg) => log.info(msg);

// TechFetch job URLs embed parameters with bare '&' (no '?'):
//   /job-description/<slug>-j<digits>&aid=tfjstfviewjob&utm_source=...
// Strip utm_* segments (tracking noise) but KEEP &aid — the probe only
// verified the aid-bearing form resolves. Pure string handling: these
// are not standard URLs.
export function canonicalTechFetchJobUrl(href) {
    if (!href) return null;
    const abs = href.startsWith('http') ? href : `https://www.techfetch.com${href}`;
    return abs.replace(/&utm_[^&]*/g, '');
}

// Maps one [id*="_divJob"] row element to a flat record. Load-bearing:
// title text + href (sentinel when missing — ASP.NET id rename signal).
// Company/location/rate/description best-effort. Pure DOM-element-in,
// object-out: callable from the class (live) and tests (JSDOM fixtures).
export function parseTechFetchRow(jobDiv) {
    if (!jobDiv) return null;
    const titleSpan = jobDiv.querySelector('[id*="_lblTitle"]');
    const titleLink = titleSpan?.querySelector('a');
    const jobTitle = titleLink?.textContent?.trim() ?? '';
    const href = titleLink?.getAttribute('href') ?? '';
    if (!titleSpan || !titleLink || !jobTitle) return { __domChanged: true, reason: 'missing_title_anchor' };
    if (!href) return { __domChanged: true, reason: 'missing_href' };
    const logoDiv = jobDiv.querySelector('[id*="_jllogo"]');
    // Company comes from the logo (href /job-openings/<x> or img alt) OR, when
    // the card has no logo, the "posted by" label. Live data: ~40% of cards
    // (8/20 in the fixture) carry the company ONLY in _lblPostedBy, so that
    // fallback is load-bearing, not cosmetic.
    const company = logoDiv?.querySelector('a')?.getAttribute('href')?.split('/job-openings/')?.[1]
        || logoDiv?.querySelector('img')?.getAttribute('alt')
        || jobDiv.querySelector('[id*="_lblPostedBy"]')?.textContent?.trim()
        || 'N/A';
    return {
        jobTitle,
        jobLink: canonicalTechFetchJobUrl(href),
        company,
        location: jobDiv.querySelector('[id*="_lblLocation"]')?.textContent?.trim() || 'N/A',
        rate: jobDiv.querySelector('[id*="_lblRate"]')?.textContent?.trim() || 'N/A',
        description: jobDiv.querySelector('[id*="_lblDesc"], [id*="_lblJobDesc"]')?.textContent?.trim() || '',
    };
}

// Live no-results page (2026-06-14) says "NO matched jobs found." — the
// "no matched jobs" alternative is REQUIRED (generic "no jobs" misses it).
export const TECHFETCH_NO_RESULTS_RE = /no matched jobs|no (more )?jobs|no results|not found|0 jobs/i;
const TECHFETCH_DOM_CHANGED_BYTES = 50_000;

// Pure page-state classifier for the TechFetch job-list page.
//   auth_required   → bounced to the login page
//   results         → [id*="_divJob"] rows present
//   empty_confirmed → 0 rows + no-results text
//   dom_changed     → ASP.NET shell rendered (LoadJobs fn / big page) but
//                     rows absent and no empty text → markup rename
//   network_error   → fall-through
export function classifyTechFetchListPage({ url, rowCount, hasLoadJobsFn, bodyText, bytes }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/login/i.test(u)) return { state: 'auth_required', signal: 'redirected to login page' };
    if ((rowCount ?? 0) > 0) return { state: 'results', signal: `rows=${rowCount}` };
    if (TECHFETCH_NO_RESULTS_RE.test(t)) return { state: 'empty_confirmed', signal: 'no-results text' };
    if (hasLoadJobsFn || (bytes ?? 0) >= TECHFETCH_DOM_CHANGED_BYTES) {
        return { state: 'dom_changed', signal: `shell rendered but 0 rows (bytes=${bytes}, LoadJobs=${!!hasLoadJobsFn})` };
    }
    return { state: 'network_error', signal: `small body (${bytes}b), no shell` };
}

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
        if (this.browser) return;   // idempotent — don't launch twice
        logProgress('TechFetch', 'Launching CloakBrowser...');
        // CloakBrowser manages launch flags + a coherent fingerprint itself;
        // humanize:true smooths the login/search form interactions.
        const proxy = getProxyPool().acquire('techfetch');
        this.browser = await launch(stealthLaunchOptions({ proxy }));
        this.context = await this.browser.newContext({
            viewport: { width: 1920, height: 1080 },
            locale: 'en-US',
        });
        await applyResourceBlocking(this.context);
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

            // Wait for either: (a) a known post-login URL, or (b) the JSLogin
            // cookie to appear. The OLD code used a fixed 5s timeout + URL-only
            // check, which false-positive'd on slow redirects and locked the
            // credential out. Cookie is the source of truth for auth state.
            try {
                await this.page.waitForURL(
                    /js_(job_list|s_jobs|my_resume)|dashboard/i,
                    { timeout: 20000 },
                );
            } catch {
                // URL didn't match in 20s — still might be logged in. Check
                // cookies before declaring failure.
            }

            this.cookies = await this.context.cookies();
            const jsLogin = this.cookies.find(c => c.name === 'JSLogin');
            const sessionId = this.cookies.find(c => c.name === 'ASP.NET_SessionId');
            const currentUrl = this.page.url();

            logProgress('TechFetch', `Current URL: ${currentUrl}`);
            logProgress('TechFetch', `Session cookies: JSLogin=${jsLogin ? '✓' : '✗'} ASP.NET_SessionId=${sessionId ? '✓' : '✗'}`);

            if (jsLogin) {
                // Cookie present → login worked, regardless of URL.
                logProgress('TechFetch', 'Login successful!');

                // Navigate to js_s_jobs.aspx to initialize search session
                logProgress('TechFetch', 'Navigating to Fetch Jobs page...');
                await this.navigateWithRetry('https://www.techfetch.com/js/js_s_jobs.aspx', {
                    waitUntil: 'load',
                    timeout: 60000
                });
                await this.page.waitForTimeout(2000);
                logProgress('TechFetch', 'Ready to search jobs');

                return true;
            }

            // No JSLogin cookie — login genuinely didn't establish a session.
            // Try to read an explicit error message from the page so the caller
            // can decide whether this is a permanent (wrong creds) vs transient
            // (slow page, security challenge) failure.
            const pageError = await this.page
                .locator('span[id*="lblError"], div.error, .alert-danger, #errorMsg')
                .first()
                .textContent({ timeout: 1000 })
                .catch(() => null);
            const errMsg = pageError?.trim()
                ? `Login failed: ${pageError.trim()}`
                : 'Login uncertain (no JSLogin cookie, no explicit error on page)';
            logProgress('TechFetch', `❌ ${errMsg}`);
            // Throw a typed error so the outer catch can distinguish wrong-creds
            // (page error visible) from transient (no error visible).
            const e = new Error(errMsg);
            e.isExplicitAuthError = Boolean(pageError?.trim());
            throw e;
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

        // Anonymous-first: navigate ourselves instead of assuming the
        // post-login landing page (probe 2026-06-12: search works without
        // login end-to-end).
        if (!this.page) {
            this.page = await this.context.newPage();
            // Handle JavaScript dialogs automatically
            this.page.on('dialog', async dialog => {
                logProgress('TechFetch', `   Dialog detected: "${dialog.message()}" - dismissing...`);
                try { await dialog.dismiss(); } catch (_) {}
            });
        }
        await this.navigateWithRetry('https://www.techfetch.com/js/js_s_jobs.aspx', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // Wait for the search form to be ready after navigation
        await this.page.waitForTimeout(2000);

        // Try to fill search form if available
        try {
            // Wait for the keyword field
            // Fail fast: when the search page renders, #txtKeyword is there
            // within a couple seconds. A long wait doesn't help when the page
            // is a block/stub (prod 2026-06-14: techfetch.com serves a flagged
            // IP a ~6KB "no shell" page with no form) — the classifier catches
            // that as network_error and the cooldown backs off, so there's no
            // point burning 20s here on a form that will never appear.
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

    // Fetch the rendered HTML for a given pagination page.
    //
    // Previously navigated directly to ajs_job_list.aspx?From=N which
    // is an AJAX fragment endpoint, not a standalone page. Direct
    // navigation lost the session state, so pages 2+ flaked out 2/3 of
    // the time ("No more jobs found" in <200ms even when results
    // existed). The page itself paginates via an in-place AJAX call:
    //   href="javascript:LoadJobs('/js/ajs_job_list.aspx?From=2')"
    // so we replay the SAME call via page.evaluate while staying on
    // js_job_list.aspx — session state intact, results consistent.
    async fetchPageWithBrowser(pageNum) {
        logProgress('TechFetch', `Fetching page ${pageNum}...`);

        if (pageNum === 1) {
            // search() already submitted the form, which loaded
            // js_job_list.aspx + auto-fired the initial LoadJobs AJAX.
            // Wait for the first job div to render, then snapshot.
            try {
                await this.page.waitForSelector('[id*="_divJob"]', { timeout: 15000 });
            } catch {
                // No jobs at all — let extractJobs report 0 below.
            }
            return await this.page.content();
        }

        // The ASP.NET-generated container ids (ctl09_divJob...) stay
        // stable across paginations — only the inner content changes.
        // So we snapshot the FIRST JOB'S TITLE LINK href instead, and
        // wait for that to flip. Every job links to a unique URL so a
        // change there is a reliable "content swapped" signal.
        const previousFirstHref = await this.page.evaluate(() => {
            const titleA = document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a');
            return titleA ? titleA.href : null;
        });

        // Call the page's own pagination function. It internally
        // fetches ajs_job_list.aspx and swaps the job-list DOM.
        await this.page.evaluate((n) => {
            if (typeof window.LoadJobs === 'function') {
                window.LoadJobs(`/js/ajs_job_list.aspx?From=${n}`);
            }
        }, pageNum);

        try {
            await this.page.waitForFunction((prev) => {
                const titleA = document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a');
                return titleA && titleA.href !== prev;
            }, previousFirstHref, { timeout: 12000 });
        } catch {
            logProgress('TechFetch', `   ⚠️  Page ${pageNum}: content didn't swap within 12s — likely end of results`);
        }

        return await this.page.content();
    }

    async extractJobDetails(jobLink, retryCount = 0, page = null) {
        const maxRetries = 3;
        const baseTimeout = 15000;
        // Polite-but-not-glacial delay. Original 2000ms was overkill — TechFetch
        // never rate-limited at this rate across 463+ historical sessions.
        const baseDelay = 500;
        // Allow a per-call page so we can parallelize detail fetches across
        // multiple Playwright pages within the same browser context (cookies
        // are shared, login persists).
        const targetPage = page || this.page;

        try {
            logProgress('TechFetch', `   Fetching details for: ${jobLink.split('/').pop().substring(0, 30)}...${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);

            const delay = baseDelay * Math.pow(1.5, retryCount);
            await targetPage.waitForTimeout(delay);

            const response = await targetPage.goto(jobLink, {
                waitUntil: 'domcontentloaded',
                timeout: baseTimeout
            });

            await targetPage.waitForTimeout(500);
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
                    await targetPage.goto('https://www.techfetch.com/js/js_s_jobs.aspx', {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    }).catch(() => {}); // Ignore errors on recovery navigation

                    await targetPage.waitForTimeout(1000);
                } catch (recoveryError) {
                    logProgress('TechFetch', `   ⚠️  Recovery navigation failed: ${recoveryError.message}`);
                }

                // Retry the request — preserve the per-worker page across retries
                return this.extractJobDetails(jobLink, retryCount + 1, page);
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
        const jobDivs = dom.window.document.querySelectorAll('[id*="_divJob"]');
        logProgress('TechFetch', `Found ${jobDivs.length} job divs on page`);
        const jobs = [];
        let domChanged = 0;
        jobDivs.forEach((jobDiv) => {
            const row = parseTechFetchRow(jobDiv);
            if (!row) return;
            if (row.__domChanged) { domChanged++; return; }
            jobs.push(row);
        });
        if (domChanged > 0) logProgress('TechFetch', `   ⚠️  ${domChanged} rows skipped (__domChanged sentinels)`);
        jobs.__domChangedCount = domChanged;   // consumed by scrapeJobs gate
        return jobs;
    }

    // matchesLocation() and the location filter on the result set have
    // been removed — TechFetch is a US-focused board so every posting
    // is implicitly US-based. The previous client-side filter was
    // throwing away ~77% of search results (e.g. "Senior Java Dev / US"
    // returned 100 results, filter kept only 23), wasting detail-page
    // bandwidth on jobs we'd discard. Now we keep them all.

    async scrapeJobs(keywords, location, maxPages = 2, includeDetails = true) {
        await this.initialize();
        await this.search(keywords, location);

        // Poll until the post-search page settles into a classifiable state:
        // job rows appear, OR the no-results message renders, OR we bounce to
        // login. The form POST navigates (js_s_jobs -> js_job_list), which
        // can destroy the eval context mid-wait — under CloakBrowser this race
        // surfaced as the classifier reading a transitional ~10KB shell and
        // mislabeling a real empty result as network_error. So we re-evaluate
        // every second (tolerating in-flight-navigation errors) instead of a
        // single waitForFunction that dies on context destruction.
        let listState = null;
        for (let i = 0; i < 20; i++) {
            try {
                const s = await this.page.evaluate(() => ({
                    url: window.location.href,
                    rowCount: document.querySelectorAll('[id*="_divJob"]').length,
                    hasLoadJobsFn: typeof window.LoadJobs === 'function',
                    bodyText: (document.body?.innerText || '').slice(0, 3000),
                    bytes: document.documentElement?.outerHTML?.length ?? 0,
                }));
                listState = s;
                const settled = s.rowCount > 0
                    || /no matched jobs|no (more )?jobs|no results/i.test(s.bodyText)
                    || /login/i.test(s.url);
                if (settled) break;
            } catch { /* navigation in flight — retry on the next tick */ }
            await this.page.waitForTimeout(1000);
        }

        // Classify the settled page (fall back to a neutral shape if every
        // poll failed — classifier then reports network_error legitimately).
        const verdict = classifyTechFetchListPage(
            listState ?? { url: this.page.url(), rowCount: 0, hasLoadJobsFn: false, bodyText: '', bytes: 0 },
        );
        logProgress('TechFetch', `List page classified: ${verdict.state} (${verdict.signal})`);
        if (verdict.state === 'auth_required') {
            const e = new AuthError(`TechFetch requires login: ${verdict.signal}`, { platform: 'techfetch' });
            e.techfetchAuthRequired = true;   // orchestrator triggers the one-shot login fallback
            throw e;
        }
        if (verdict.state === 'empty_confirmed') return { jobs: [], emptyConfirmed: true };
        if (verdict.state === 'dom_changed') throw new DomChangedError(`TechFetch list DOM changed: ${verdict.signal}`, { platform: 'techfetch' });
        if (verdict.state === 'network_error') {
            // A tiny "no shell" page is what techfetch.com serves a flagged IP
            // (prod 2026-06-14). Treat it as a block: write the cooldown marker
            // so the orchestrator's claim pre-flight excludes techfetch until
            // it expires, instead of re-claiming a doomed stub every cycle.
            writeCooldownMarker({
                writeFile: defaultWriteFile(),
                rename: defaultRename(),
                now: new Date(),
                cooldownMs: cooldownMs(),
                path: cooldownPath(),
            });
            throw new NetworkError(`TechFetch list didn't render: ${verdict.signal}`, { platform: 'techfetch' });
        }

        const allJobs = [];
        const maxJobs = 40;   // detail-page count drives proxy bandwidth
        let totalScraped = 0;
        // jobLink is unique per posting; track across pages so we can
        // detect a stale-page response (LoadJobs() returned the same
        // results) and break out instead of detail-fetching duplicates.
        const seenLinks = new Set();

        for (let page = 1; page <= maxPages; page++) {
            try {
                const html = await this.fetchPageWithBrowser(page);
                const allExtracted = this.extractJobs(html);

                const domChangedCount = allExtracted.__domChangedCount ?? 0;
                if (allExtracted.length === 0 && domChangedCount > 0) {
                    throw new DomChangedError(`TechFetch rows all failed extraction (${domChangedCount} sentinels)`, { platform: 'techfetch' });
                }

                // Dedup against pages we've already processed.
                const jobs = allExtracted.filter(j => {
                    if (!j.jobLink || seenLinks.has(j.jobLink)) return false;
                    seenLinks.add(j.jobLink);
                    return true;
                });

                if (jobs.length === 0) {
                    logProgress('TechFetch',
                        `⚠️  No new jobs on page ${page} (${allExtracted.length} extracted, all duplicates) — end of results`);
                    break;
                }

                totalScraped += jobs.length;
                
                // Fetch additional details for each job if requested.
                // Parallel pool: each worker holds its own Playwright page (cookies
                // shared via the browser context, so login session persists). 4 is
                // enough to ~4× detail throughput without spamming TechFetch.
                if (includeDetails) {
                    logProgress('TechFetch', `   📋 Fetching details for ${jobs.length} jobs (concurrency=4)...`);
                    const concurrency = Math.min(4, jobs.length);
                    const queue = jobs.map((job, idx) => ({ job, idx }));

                    const mergeDetails = (job, details) => ({
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
                        domain: details.domain,
                    });

                    const worker = async () => {
                        const workerPage = await this.context.newPage();
                        try {
                            // eslint-disable-next-line no-constant-condition
                            while (true) {
                                const item = queue.shift();
                                if (!item) break;
                                const details = await this.extractJobDetails(item.job.jobLink, 0, workerPage);
                                jobs[item.idx] = mergeDetails(item.job, details);
                            }
                        } finally {
                            await workerPage.close().catch(() => {});
                        }
                    };

                    await Promise.all(Array.from({ length: concurrency }, () => worker()));
                }
                
                allJobs.push(...jobs);
                logProgress('TechFetch', `✅ Extracted ${jobs.length} jobs from page ${page} (Total: ${allJobs.length})`);
                
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

        logProgress('TechFetch', `🎉 Scraping complete! Total ${allJobs.length} jobs (${totalScraped} scraped pre-cap)`);
        return allJobs;
    }

    async close() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }
        } catch (_) {
            // Ignore teardown errors
        }
    }
}

// Export function for UnifiedJobScraper
export async function scrapeTechFetch(jobTitle, location, sessionId = null) {
    logProgress('TechFetch', `Starting TechFetch scraper for "${jobTitle}" in "${location || 'any location'}" (anonymous-first)`);

    const maxPages = location ? 5 : 2;

    // Cross-run cooldown gate — a recent stub-page block wrote the marker;
    // short-circuit before launching a browser.
    {
        const now = new Date();
        const marker = readCooldownMarker({ readFile: defaultReadFile(), now, path: cooldownPath() });
        if (isOnCooldown(marker, now)) {
            throw new BlockedError(
                `TechFetch cooldown active until ${marker.blockedUntil.toISOString()} — skipping scrape`,
                { platform: 'techfetch', kind: 'blocked-cooldown' },
            );
        }
    }

    // ── Attempt 1: anonymous (probe-verified working path) ──────────
    const anonScraper = new TechFetchScraper(null, null);
    let authRequired = false;
    try {
        const result = await anonScraper.scrapeJobs(jobTitle, location, maxPages, true);
        return normalizeTechFetchResult(result);
    } catch (e) {
        if (e?.techfetchAuthRequired) {
            authRequired = true;
            logProgress('TechFetch', 'Anonymous search hit a login wall — attempting credential fallback');
        } else {
            throw e;
        }
    } finally {
        await anonScraper.close().catch(() => {});
    }

    // ── Attempt 2 (only on auth_required): single credential try ────
    if (authRequired) {
        const lease = await getCredentialsAPIClient().acquire('techfetch', sessionId);
        if (!lease) {
            throw new AuthError('TechFetch requires login but no credential is available from the API', { platform: 'techfetch' });
        }
        const credential = lease.credential;
        logProgress('TechFetch', `Credential fetched: id=${credential.id} password=${'*'.repeat(credential.password?.length || 8)}`);
        const scraper = new TechFetchScraper(credential.email, credential.password);
        try {
            await scraper.initialize();
            // login() returns true or THROWS (it never returns false): an
            // explicit wrong-credentials page sets e.isExplicitAuthError.
            await scraper.login();
            const result = await scraper.scrapeJobs(jobTitle, location, maxPages, true);
            await lease.reportSuccess(`Scraped ${Array.isArray(result) ? result.length : result.jobs?.length ?? 0} jobs after login fallback`);
            return normalizeTechFetchResult(result);
        } catch (e) {
            if (e?.isExplicitAuthError) {
                // Bad credential — retire it immediately (cooldown 0) so the
                // pool stops handing it out, rather than a transient backoff.
                await lease.reportFailure(`Login failed (bad credential): ${e.message}`, 0);
                throw new AuthError(`TechFetch login failed: ${e.message}`, { platform: 'techfetch', cause: e });
            }
            if (e?.techfetchAuthRequired) {
                await lease.reportFailure('Login succeeded but search still bounced to login', 30);
                throw new AuthError('TechFetch still requires auth after login fallback', { platform: 'techfetch' });
            }
            if (!(e instanceof AuthError)) {
                await lease.reportFailure(`Scraping error: ${e.message}`, 30).catch(() => {});
            }
            throw e;
        } finally {
            await scraper.close().catch(() => {});
        }
    }
}

function normalizeTechFetchResult(result) {
    if (!Array.isArray(result)) return result;   // {jobs:[], emptyConfirmed:true} passes through
    const normalizedJobs = result.map((job) => normalizeJobData({
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
        companyLocation: job.companyLocation,
    }, 'techfetch'));
    logProgress('TechFetch', `Completed: ${normalizedJobs.length} jobs`);
    return normalizedJobs;
}
