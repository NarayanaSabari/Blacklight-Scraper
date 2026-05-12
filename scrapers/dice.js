// Dice Job Scraper Module
//
// Uses CloakBrowser for consistency across the platform fleet. Dice
// itself has no detection layer worth defeating — vanilla Playwright
// works 100% of the time in stress tests — but standardizing on one
// browser launcher simplifies ops (single binary install, single
// fingerprint surface). humanize:false because there's nothing to fool
// and the behavioral overhead would slow the 5-page-then-100-detail
// scrape pattern down meaningfully.
import { launch } from 'cloakbrowser';
import { CheerioCrawler } from 'crawlee';
import * as cheerio from 'cheerio';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { stripHtmlTags } from '../src/core/html.js';

const log = createLogger('dice');
const logProgress = (_scope, msg) => log.info(msg);

/**
 * Fetch recruiter profile page and extract name/title from RSC payload.
 * Email/phone are behind authentication and cannot be scraped without login.
 */
async function fetchRecruiterProfile(recruiterId, browser) {
    if (!recruiterId) return { name: 'N/A', title: null, company: null };
    const url = `https://www.dice.com/recruiter-profile/${recruiterId}`;
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);
        const html = await page.content();
        const $r = cheerio.load(html);

        // Extract from RSC payload: firstName/lastName are embedded in self.__next_f.push blocks
        let firstName = null, lastName = null, jobTitle = null, companyName = null;
        $r('script').each((_, el) => {
            const src = $r(el).html() || '';
            if (!src.includes('firstName')) return;
            // Match "firstName":"Deva","lastName":"Raya","jobTitle":"Recruiter","companyName":"..."
            const firstMatch = src.match(/"firstName"\s*:\s*"([^"]+)"/);
            const lastMatch  = src.match(/"lastName"\s*:\s*"([^"]+)"/);
            const titleMatch = src.match(/"jobTitle"\s*:\s*"([^"]+)"/);
            const compMatch  = src.match(/"companyName"\s*:\s*"([^"]+)"/);
            if (firstMatch) firstName = firstMatch[1];
            if (lastMatch)  lastName  = lastMatch[1];
            if (titleMatch) jobTitle  = titleMatch[1];
            if (compMatch)  companyName = compMatch[1];
        });

        const name = [firstName, lastName].filter(Boolean).join(' ') || 'N/A';
        logProgress('Dice', `Recruiter: ${name} (${jobTitle || 'N/A'}) @ ${companyName || 'N/A'}`);
        return { name, title: jobTitle, company: companyName };
    } catch (e) {
        logProgress('Dice', `Could not fetch recruiter profile ${recruiterId}: ${e.message}`);
        return { name: 'N/A', title: null, company: null };
    } finally {
        await page.close();
        await context.close();
    }
}

export async function scrapeDice(jobTitle, location) {
    const encodedJobTitle = encodeURIComponent(jobTitle);
    const encodedLocation = encodeURIComponent(location);

    logProgress('Dice', `Searching for "${jobTitle}" in "${location}"`);

    // CloakBrowser handles its own Chromium args internally (sandbox,
    // shm, GPU) so we don't pass --no-sandbox etc. headless:true is
    // enough; humanize is off because Dice has no behavioral detection.
    const browser = await launch({ headless: true });

    // All contexts created below are pushed to this array so the finally block
    // can guarantee cleanup no matter which step throws. Previously a failure
    // anywhere after browser launch leaked the browser + its contexts.
    const contextsToCleanup = [];

    try {

    // Step 1: Scrape job URLs from the search page
    const searchUrl = `https://www.dice.com/jobs?q=${encodedJobTitle}&location=${encodedLocation}&filters.postedDate=SEVEN`;
    const jobUrls = [];
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
    });
    contextsToCleanup.push(context);
    const page = await context.newPage();

    const maxPages = 5;
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const pageUrl = `${searchUrl}&page=${pageNum}`;
        try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForSelector('body', { timeout: 10000 });

            const links = await page.$$eval('a[href*="/job-detail/"]', anchors => anchors.map(a => a.href));
            jobUrls.push(...links);
            logProgress('Dice', `Page ${pageNum}: Found ${links.length} job URLs`);
        } catch (error) {
            logProgress('Dice', `Error scraping page ${pageNum}: ${error.message}`);
            break;
        }
    }
    jobUrls.splice(0, jobUrls.length, ...new Set(jobUrls)); // Deduplicate
    logProgress('Dice', `Total unique job URLs found: ${jobUrls.length}`);
    await context.close();

    // Limit to 100 jobs
    const maxJobs = 100;
    const jobsToProcess = jobUrls.slice(0, maxJobs);

    const detailedData = [];

    // Create contexts for parallel job scraping
    const jobContexts = [];
    for (let i = 0; i < 5; i++) {
        const jobCtx = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            ignoreHTTPSErrors: true,
            bypassCSP: true
        });
        jobContexts.push(jobCtx);
        contextsToCleanup.push(jobCtx);
    }
    let jobContextIndex = 0;
    const getJobContext = () => {
        const ctx = jobContexts[jobContextIndex];
        jobContextIndex = (jobContextIndex + 1) % jobContexts.length;
        return ctx;
    };

    // Process jobs in parallel using CheerioCrawler
    const jobCrawler = new CheerioCrawler({
        maxConcurrency: 10,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 180,
        async requestHandler({ $, request }) {
            logProgress('Dice', `Processing job ${request.url}`);

            // Use Playwright to render the page (Next.js RSC requires JS execution)
            let pageHtml = '';
            const jobContext = getJobContext();
            const jobPage = await jobContext.newPage();
            try {
                await jobPage.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await jobPage.waitForTimeout(2000);
                pageHtml = await jobPage.content();
                await jobPage.close();
            } catch (error) {
                logProgress('Dice', `Error loading job page with Playwright: ${error.message}`);
                try { await jobPage.close(); } catch (e) {}
                return;
            }

            // Parse the rendered HTML with Cheerio
            const $job = cheerio.load(pageHtml);

            // ── Structured data (Schema.org JobPosting) ──────────────────────────
            const structuredDataScript = $job('script[id="jobDetailStructuredData"]').html();
            if (!structuredDataScript) {
                logProgress('Dice', `❌ No structured data found for ${request.url}`);
                return;
            }

            let jobData;
            try {
                jobData = JSON.parse(structuredDataScript);
            } catch (e) {
                logProgress('Dice', `❌ Error parsing structured data JSON: ${e.message}`);
                return;
            }

            if (!jobData || jobData['@type'] !== 'JobPosting') {
                logProgress('Dice', `❌ Invalid structured data type: ${jobData?.['@type']}`);
                return;
            }

            logProgress('Dice', `✓ Extracted job data: ${jobData.title || 'No title'}`);

            // ── Job ID ────────────────────────────────────────────────────────────
            const jobId = jobData.identifier?.value || request.url.split('/').pop();

            // ── Location ──────────────────────────────────────────────────────────
            const addr = jobData.jobLocation?.address || {};
            const city    = addr.addressLocality || null;
            const state   = addr.addressRegion   || null;
            const country = addr.addressCountry  || null;
            const locationFormatted = city && state ? `${city}, ${state}` : (city || state || 'N/A');

            // Remote: jobLocationType === 'TELECOMMUTE' signals remote/hybrid
            const isRemote = jobData.jobLocationType === 'TELECOMMUTE';

            // ── Salary ────────────────────────────────────────────────────────────
            // baseSalary structure in Dice structured data:
            //   { "@type": "MonetaryAmount", "currency": "USD", "minValue": 60000, "maxValue": 65000 }
            // (minValue/maxValue are directly on baseSalary, NOT nested under .value)
            let salaryMin = null, salaryMax = null, salaryCurrency = 'USD', salaryPeriod = null;
            if (jobData.baseSalary) {
                salaryMin      = jobData.baseSalary.minValue ?? jobData.baseSalary.value?.minValue ?? null;
                salaryMax      = jobData.baseSalary.maxValue ?? jobData.baseSalary.value?.maxValue ?? null;
                salaryCurrency = jobData.baseSalary.currency || 'USD';
                salaryPeriod   = jobData.baseSalary.unitText || null; // 'YEAR' or 'HOUR' when present
            }

            // Fallback: parse salary period from rendered badge text (e.g. "$60,000 - $65,000/yr")
            if (!salaryPeriod) {
                const badgeTexts = [];
                $job('.SeuiInfoBadge').each((_, el) => {
                    badgeTexts.push($job(el).text().trim());
                });
                const salaryBadge = badgeTexts.find(t => t.includes('$'));
                if (salaryBadge) {
                    if (salaryBadge.includes('/hr'))   salaryPeriod = 'HOUR';
                    else if (salaryBadge.includes('/yr')) salaryPeriod = 'YEAR';
                }
            }

            // Build human-readable salary string
            let salaryFormatted = 'N/A';
            if (salaryMin || salaryMax) {
                const fmt = (v) => v ? `$${Number(v).toLocaleString()}` : null;
                const period = salaryPeriod === 'HOUR' ? '/hr' : salaryPeriod === 'YEAR' ? '/yr' : '';
                salaryFormatted = [fmt(salaryMin), fmt(salaryMax)].filter(Boolean).join(' - ') + period;
            }

            // ── Employment type ───────────────────────────────────────────────────
            const employmentTypeMap = {
                'FULL_TIME':  'full_time',
                'PART_TIME':  'part_time',
                'CONTRACTOR': 'contract',
                'TEMPORARY':  'temporary',
                'INTERN':     'internship'
            };
            const rawType = jobData.employmentType;
            // employmentType can be a single string or an array
            const employmentType = Array.isArray(rawType)
                ? rawType.map(t => employmentTypeMap[t] || t.toLowerCase()).join(', ')
                : (employmentTypeMap[rawType] || rawType?.toLowerCase() || 'N/A');

            // ── Skills ────────────────────────────────────────────────────────────
            // Skills are rendered as SeuiInfoBadge items under the "Skills" heading
            const skills = [];
            const skillsHeading = $job('h3').filter((_, el) => $job(el).text().trim() === 'Skills');
            if (skillsHeading.length) {
                skillsHeading.next('ul').find('li').each((_, el) => {
                    const skill = $job(el).text().trim();
                    if (skill) skills.push(skill);
                });
            }

            // ── Workplace type (On-site / Remote / Hybrid) ────────────────────────
            let workplaceType = null;
            const locationTypeBadge = $job('[data-testid="locationTypeBadge"]');
            if (locationTypeBadge.length) {
                workplaceType = locationTypeBadge.text().trim() || null;
            }

            // ── easyApply ─────────────────────────────────────────────────────────
            // Parse from RSC payload (self.__next_f.push blocks)
            let easyApply = false;
            $job('script').each((_, el) => {
                const src = $job(el).html() || '';
                if (src.includes(jobId) && src.includes('easyApply')) {
                    const m = src.match(/"easyApply"\s*:\s*(true|false)/);
                    if (m) easyApply = m[1] === 'true';
                }
            });

            // ── Recruiter ─────────────────────────────────────────────────────────
            // recruiterId is embedded in RSC payload; fetch the profile page for name/title
            let recruiterInfo = { name: 'N/A', title: null, company: null };
            let recruiterId = null;
            $job('script').each((_, el) => {
                const src = $job(el).html() || '';
                if (!src.includes('recruiterId')) return;
                const m = src.match(/"recruiterId"\s*:\s*"([a-f0-9-]{36})"/);
                if (m) recruiterId = m[1];
            });
            if (recruiterId) {
                recruiterInfo = await fetchRecruiterProfile(recruiterId, browser);
            }

            // ── Company ───────────────────────────────────────────────────────────
            const companyName        = jobData.hiringOrganization?.name || 'N/A';
            const companyProfileUrl  = jobData.hiringOrganization?.sameAs || null;
            const companyLogoUrl     = jobData.hiringOrganization?.logo || null;

            // ── Description ───────────────────────────────────────────────────────
            const description = stripHtmlTags(jobData.description || '');

            // ── Posted date ───────────────────────────────────────────────────────
            const postedDate = jobData.datePosted
                ? new Date(jobData.datePosted).toISOString().split('T')[0]
                : null;

            // ── Expiry date ───────────────────────────────────────────────────────
            const validThrough = jobData.validThrough
                ? new Date(jobData.validThrough).toISOString().split('T')[0]
                : null;

            const normalizedJob = normalizeJobData({
                id: jobId,
                title: jobData.title,
                company: companyName,
                companyProfileUrl,
                companyLogoUrl,
                location: locationFormatted,
                city,
                state,
                country,
                isRemote,
                workplaceType,
                salary: salaryFormatted,
                salary_min: salaryMin,
                salary_max: salaryMax,
                salary_currency: salaryCurrency,
                salary_period: salaryPeriod,
                postedDate,
                validThrough,
                description,
                employmentType,
                easyApply,
                skills,
                url: jobData.url || request.url,
                recruiter: {
                    name: recruiterInfo.name,
                    title: recruiterInfo.title,
                    company: recruiterInfo.company,
                    profileUrl: recruiterId ? `https://www.dice.com/recruiter-profile/${recruiterId}` : null
                }
            }, 'Dice');

            detailedData.push(normalizedJob);
            logProgress('Dice', `✅ Job saved: ${jobData.title} at ${companyName} (Total: ${detailedData.length})`);
        }
    });

    await jobCrawler.run(jobsToProcess.map(url => ({ url })));

    logProgress('Dice', `Crawler finished. Jobs in detailedData array: ${detailedData.length}`);

    logProgress('Dice', `Completed! Saved ${detailedData.length} detailed jobs`);
    return detailedData;

    } finally {
        // Guaranteed cleanup — runs whether scraping succeeded or threw.
        for (const ctx of contextsToCleanup) {
            try { await ctx.close(); } catch (err) {
                log.warn(`Failed to close context: ${err.message}`);
            }
        }
        try { await browser.close(); } catch (err) {
            log.warn(`Failed to close browser: ${err.message}`);
        }
    }
}
