// Dice Job Scraper Module
//
// Uses CloakBrowser for consistency across the platform fleet. Dice
// itself has no detection layer worth defeating — vanilla Playwright
// works 100% of the time in stress tests — but standardizing on one
// browser launcher simplifies ops (single binary install, single
// fingerprint surface). humanize:false because there's nothing to fool
// and the behavioral overhead would slow the 5-page-then-100-detail
// scrape pattern down meaningfully.
import { launch } from '../src/core/browser-pool.js';
import * as cheerio from 'cheerio';
import { Semaphore } from '../src/core/semaphore.js';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { stripHtmlTags } from '../src/core/html.js';
import { BlockedError, DomChangedError, NetworkError } from '../src/core/errors.js';
import { applyResourceBlocking } from '../src/core/resource-blocking.js';
import { getMetrics } from '../src/metrics/registry.js';

const log = createLogger('dice');
const logProgress = (_scope, msg) => log.info(msg);

// Parses the body of <script id="jobDetailStructuredData">. Pure given a
// string. Returns {data, error}: data is the parsed object on success,
// or null with a human-readable error string. The caller turns the
// error into a typed ParseError or DomChangedError depending on context.
export function parseStructuredData(scriptText) {
    if (scriptText === null || scriptText === undefined || scriptText === '') {
        return { data: null, error: 'empty structured-data script body' };
    }
    let parsed;
    try { parsed = JSON.parse(scriptText); }
    catch (e) { return { data: null, error: `JSON parse failed: ${e.message}` }; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { data: null, error: 'structured data is not an object' };
    }
    return { data: parsed, error: null };
}

// Parses the baseSalary block from a JobPosting JSON-LD. Handles both
// the modern "MonetaryAmount" shape (minValue/maxValue at top level) and
// the legacy "value.minValue" nested shape. Returns a stable object with
// {min, max, currency, period, formatted}. The formatted string is the
// human-readable label downstream UIs render.
export function parseSalary(baseSalary) {
    const fallback = { min: null, max: null, currency: 'USD', period: null, formatted: 'N/A' };
    if (baseSalary === null || baseSalary === undefined) return fallback;
    const min = baseSalary.minValue ?? baseSalary.value?.minValue ?? null;
    const max = baseSalary.maxValue ?? baseSalary.value?.maxValue ?? null;
    const currency = baseSalary.currency || 'USD';
    const period = baseSalary.unitText || null;
    if (min === null && max === null) return { ...fallback, currency, period };
    // Pin the locale: toLocaleString() follows the HOST locale, so an en-IN box
    // formats 100000 as "1,00,000" and ships malformed salaries.
    const fmt = (v) => (v !== null && v !== undefined)
        ? `$${Number(v).toLocaleString('en-US')}` : null;
    const suffix = period === 'HOUR' ? '/hr' : period === 'YEAR' ? '/yr' : '';
    const formatted = [fmt(min), fmt(max)].filter(Boolean).join(' - ') + suffix;
    return { min, max, currency, period, formatted };
}

const EMPLOYMENT_TYPE_MAP = Object.freeze({
    FULL_TIME: 'full_time',
    PART_TIME: 'part_time',
    CONTRACTOR: 'contract',
    TEMPORARY: 'temporary',
    INTERN: 'internship',
});

// Maps Dice's employmentType (single string or array of strings) into our
// canonical lower-snake_case form. Unknown values pass through lowercased.
// Missing/empty → 'N/A' (matches the rest of the normalize.js defaults).
export function parseEmploymentType(rawType) {
    if (rawType === null || rawType === undefined || rawType === '') return 'N/A';
    if (Array.isArray(rawType)) {
        if (rawType.length === 0) return 'N/A';
        return rawType.map((t) => EMPLOYMENT_TYPE_MAP[t] ?? String(t).toLowerCase()).join(', ');
    }
    return EMPLOYMENT_TYPE_MAP[rawType] ?? String(rawType).toLowerCase();
}

// Maps a JobPosting JSON-LD object into the flat record we pass to
// normalizeJobData. Returns the row on success, or
// { __domChanged: true, reason } when a load-bearing field is missing —
// caller aggregates these and throws DomChangedError when the rate
// crosses the batch threshold (Section E of the spec).
export function extractJobFromStructuredData(jsonLd, requestUrl) {
    if (!jsonLd?.title) return { __domChanged: true, reason: 'missing_title' };
    const company = jsonLd?.hiringOrganization?.name;
    if (!company) return { __domChanged: true, reason: 'missing_company' };

    const jobId = jsonLd.identifier?.value || String(requestUrl).split('/').filter(Boolean).pop();
    const addr = jsonLd.jobLocation?.address ?? {};
    const city = addr.addressLocality ?? null;
    const state = addr.addressRegion ?? null;
    const country = addr.addressCountry ?? null;
    const locationFormatted = city && state ? `${city}, ${state}` : (city || state || 'N/A');
    const isRemote = jsonLd.jobLocationType === 'TELECOMMUTE';

    const salary = parseSalary(jsonLd.baseSalary);
    const employmentType = parseEmploymentType(jsonLd.employmentType);

    const fmtDate = (v) => {
        if (!v) return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().split('T')[0];
    };

    return {
        jobId,
        title: jsonLd.title,
        company,
        companyProfileUrl: jsonLd.hiringOrganization?.sameAs ?? null,
        companyLogoUrl: jsonLd.hiringOrganization?.logo ?? null,
        locationFormatted,
        city,
        state,
        country,
        isRemote,
        salaryFormatted: salary.formatted,
        salaryMin: salary.min,
        salaryMax: salary.max,
        salaryCurrency: salary.currency,
        salaryPeriod: salary.period,
        employmentType,
        postedDate: fmtDate(jsonLd.datePosted),
        validThrough: fmtDate(jsonLd.validThrough),
        description: jsonLd.description ?? '',
        url: jsonLd.url || requestUrl,
    };
}

// Pure page-state classifier for the search-results page.
//   results          → real results page, anchors are extractable
//   empty_confirmed  → real "0 results" page (no false alarm)
//   soft_blocked     → Cloudflare / access-denied page (defensive)
//   dom_changed      → page rendered fully but the anchors we expect are absent
//   network_error    → page didn't render meaningfully (small body, nothing positive)
const DICE_DOM_CHANGED_BYTES_THRESHOLD = 50_000;

export function classifyDiceSearchPage({ url, bodyText, anchorCount, bytes }) {
    const u = String(url ?? '');
    const t = String(bodyText ?? '');
    if (/cloudflare|access denied|please verify|ray id|verify you are human/i.test(t) ||
        /captcha|challenge/i.test(u)) {
        return { state: 'soft_blocked', signal: 'cloudflare-style block page' };
    }
    if (anchorCount > 0) {
        return { state: 'results', signal: `anchors=${anchorCount}` };
    }
    if (/no jobs (found|match)|0 results/i.test(t)) {
        return { state: 'empty_confirmed', signal: 'no-jobs-found text' };
    }
    if ((bytes ?? 0) >= DICE_DOM_CHANGED_BYTES_THRESHOLD) {
        return { state: 'dom_changed', signal: `large render (${bytes}b) but 0 anchors and no empty-results text` };
    }
    return { state: 'network_error', signal: `small body (${bytes}b), no positive signal` };
}

// Reads the skills list from the rendered detail page. The Skills heading
// is an <h3>. Returns [] when the heading is absent (Dice has been known to
// ship pages without it).
export function extractSkills($job) {
    const heading = $job('h3').filter((_, el) => $job(el).text().trim() === 'Skills');
    if (!heading.length) return [];
    // Two markup shapes:
    //   LEGACY  - the list is the heading's immediate <ul> sibling.
    //   CURRENT (observed live 2026-07-24) - the list is nested inside a
    //     wrapper <div>, alongside an `aria-hidden="true"` duplicate <ul>
    //     that Dice renders purely to measure badge widths.
    // Matching only the legacy shape returned [] for EVERY job (silent total
    // skill loss, 0/40 on a live run); matching every <li> under the
    // container instead returns each skill twice, via the aria-hidden decoy.
    // Scope strictly to the heading's IMMEDIATE next sibling. Widening to
    // heading.parent() pulls in neighbouring <ul>s (description bullets,
    // "Dice Id"/"Posted" metadata) - live check returned 14 bogus entries.
    const legacy = heading.next('ul');
    const lists = legacy.length
        ? legacy
        : heading.next().find('ul:not([aria-hidden="true"])');
    const seen = new Set();
    const skills = [];
    lists.find('li').each((_, el) => {
        const v = $job(el).text().trim();
        if (v && !seen.has(v)) { seen.add(v); skills.push(v); }
    });
    return skills;
}

// Reads the workplace-type badge text (e.g. "Remote", "Hybrid", "On-site").
// Returns null when absent.
export function extractWorkplaceType($job) {
    const badge = $job('[data-testid="locationTypeBadge"]');
    if (!badge.length) return null;
    return badge.text().trim() || null;
}

function intEnv(name, fallback) {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const CONFIG = {
    MAX_PAGES: 5,
    MAX_JOBS: 40,   // detail-page count drives proxy bandwidth; 40 keeps cost sane
    SEARCH_NAV_TIMEOUT_MS: 30000,
    SEARCH_RENDER_WAIT_MS: intEnv('DICE_SEARCH_RENDER_WAIT_MS', 2000),
    DETAIL_NAV_TIMEOUT_MS: 30000,
    // The detail page's payload is the server-rendered jobDetailStructuredData
    // JSON-LD, which is in the HTML at domcontentloaded — waiting for React to
    // hydrate bought nothing but cost 2s on every job. Kept tunable in case a
    // future Dice layout does need hydration; a rise in "Detail dropped
    // (dom_changed)" is the signal that it does.
    DETAIL_RENDER_WAIT_MS: intEnv('DICE_DETAIL_RENDER_WAIT_MS', 0),
    DETAIL_CONCURRENCY: intEnv('DICE_DETAIL_CONCURRENCY', 10),
    DETAIL_CONTEXTS: 5,
    DETAIL_DOM_CHANGED_THRESHOLD: 0.30,  // > 30% bad rows = batch DOM changed
};

// Wall-clock ceiling for one detail job, replacing CheerioCrawler's
// requestHandlerTimeoutSecs. The navigation has its own 30s timeout but
// page.content() and the parse below have none, so without this one wedged
// page holds a concurrency slot forever.
const DETAIL_JOB_TIMEOUT_MS = 180_000;

/**
 * Run `worker` over every item with at most `limit` in flight.
 *
 * Rejections are contained per item: one bad detail page must not abort the
 * other 39. The worker is expected to do its own error accounting, so this
 * returns nothing.
 */
export async function mapWithConcurrency(items, limit, worker) {
    const sem = new Semaphore(limit);
    await Promise.all(items.map(async (item, index) => {
        const release = await sem.acquire();
        try {
            await worker(item, index);
        } finally {
            release();
        }
    }));
}

/** Reject after `ms`, so a wedged page cannot hold its slot indefinitely. */
export function withDeadline(promise, ms, label) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Distinct URLs, order preserved.
 *
 * CheerioCrawler's RequestQueue used to provide this. Dropping it without
 * replacing it would let a search page that lists the same job twice be
 * fetched, parsed and collected twice.
 */
export function dedupeUrls(urls) {
    return [...new Set(urls)];
}

export function buildSearchUrl(jobTitle, location, pageNum) {
    const q = encodeURIComponent(jobTitle);
    const w = encodeURIComponent(location);
    return `https://www.dice.com/jobs?q=${q}&location=${w}&filters.postedDate=SEVEN&page=${pageNum}`;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function scrapeDice(jobTitle, location, sessionId = null) {
    logProgress('Dice', `Searching for "${jobTitle}" in "${location}"`);
    // Dice has no real anti-bot layer (vanilla Playwright works 100%), so it
    // runs DIRECT — no proxy. Keeps the limited proxy quota for the
    // Cloudflare/DataDome platforms that actually need a residential IP.
    const browser = await launch({ headless: true });
    const contextsToCleanup = [];
    const collectedJobs = [];
    let collectedAnything = false;

    try {
        // ─── Stage 1: search-page URL collection ──────────────────────────
        const searchContext = await browser.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 } });
        contextsToCleanup.push(searchContext);
        await applyResourceBlocking(searchContext);
        const searchPage = await searchContext.newPage();
        const seenUrls = new Set();
        const jobUrls = [];
        let consecutiveEmpty = 0;

        for (let pageNum = 1; pageNum <= CONFIG.MAX_PAGES && jobUrls.length < CONFIG.MAX_JOBS; pageNum++) {
            const url = buildSearchUrl(jobTitle, location, pageNum);
            logProgress('Dice', `Search page ${pageNum}: ${url}`);
            try {
                await searchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.SEARCH_NAV_TIMEOUT_MS });
            } catch (e) {
                if (jobUrls.length === 0) throw new NetworkError(`Dice search goto failed: ${e.message}`, { platform: 'dice', cause: e });
                logProgress('Dice', `Search page ${pageNum} nav failed — returning ${jobUrls.length} URLs collected so far`);
                break;
            }
            // Soft wait for the cards (best-effort — classifier owns the verdict).
            await searchPage.waitForSelector('a[href*="/job-detail/"]', { timeout: 5000 }).catch(() => {});

            const probe = await searchPage.evaluate(() => {
                const primary = [...new Set([...document.querySelectorAll('a[href*="/job-detail/"]')]
                    .map((a) => a.href).filter(Boolean))];
                const backup = [...new Set([...document.querySelectorAll('[data-testid*="job-card"] a[href*="/job-detail/"]')]
                    .map((a) => a.href).filter(Boolean))];
                return {
                    bodyText: (document.body?.innerText || '').slice(0, 4000),
                    bytes: document.documentElement?.outerHTML?.length ?? 0,
                    primary,
                    backup,
                };
            });
            const anchors = probe.primary.length > 0 ? probe.primary : probe.backup;
            const verdict = classifyDiceSearchPage({
                url: searchPage.url(),
                bodyText: probe.bodyText,
                anchorCount: anchors.length,
                bytes: probe.bytes,
            });
            logProgress('Dice', `Page ${pageNum} classified: ${verdict.state} (${verdict.signal})`);

            if (verdict.state === 'soft_blocked') {
                if (jobUrls.length === 0) throw new BlockedError(`Dice blocked: ${verdict.signal}`, { platform: 'dice', kind: 'cloudflare' });
                break;
            }
            if (verdict.state === 'dom_changed') {
                if (jobUrls.length === 0) throw new DomChangedError(`Dice DOM changed: ${verdict.signal}`, { platform: 'dice' });
                break;
            }
            if (verdict.state === 'network_error') {
                if (jobUrls.length === 0) throw new NetworkError(`Dice search didn't render: ${verdict.signal}`, { platform: 'dice' });
                break;
            }
            if (verdict.state === 'empty_confirmed') {
                consecutiveEmpty++;
                if (consecutiveEmpty >= 2) break;
                continue;
            }
            // results
            let newCount = 0;
            for (const u of anchors) {
                if (seenUrls.has(u)) continue;
                seenUrls.add(u);
                jobUrls.push(u);
                newCount++;
                if (jobUrls.length >= CONFIG.MAX_JOBS) break;
            }
            logProgress('Dice', `Page ${pageNum}: ${anchors.length} anchors, ${newCount} new unique, total: ${jobUrls.length}`);
            if (newCount === 0) consecutiveEmpty++; else consecutiveEmpty = 0;
            if (consecutiveEmpty >= 2) break;
        }
        await searchContext.close();

        if (jobUrls.length === 0) {
            // Reached natural end-of-results without throwing — confirmed empty.
            return { jobs: [], emptyConfirmed: true };
        }

        // ─── Stage 2: per-job detail extraction ───────────────────────────
        const jobsToProcess = jobUrls.slice(0, CONFIG.MAX_JOBS);
        const jobContexts = [];
        for (let i = 0; i < CONFIG.DETAIL_CONTEXTS; i++) {
            const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true, bypassCSP: true });
            jobContexts.push(ctx);
            contextsToCleanup.push(ctx);
            await applyResourceBlocking(ctx);
        }
        let ctxRR = 0;
        const getCtx = () => { const c = jobContexts[ctxRR]; ctxRR = (ctxRR + 1) % jobContexts.length; return c; };

        let domChangedCount = 0;
        let processedCount = 0;

        // ─── Why this is a plain semaphore and not CheerioCrawler ─────────
        //
        // This stage used to run through crawlee's CheerioCrawler, which was a
        // straight doubling of Dice's traffic and time. CheerioCrawler ALWAYS
        // performs its own HTTP GET of the request URL before invoking the
        // handler, and this handler ignored that response entirely and
        // re-fetched the same URL through Playwright, because the JSON-LD is
        // only reliably present on the browser-rendered page. Every Dice detail
        // page was pulled twice, once for nothing.
        //
        // Crawlee was providing four things; all four are cheaper here:
        //   - concurrency        -> Semaphore, the house primitive
        //   - a per-job timeout  -> withDeadline (crawlee's 180s, preserved)
        //   - URL dedup          -> dedupeUrls
        //   - retries            -> dropped deliberately, see below
        //
        // Dropping retries is not a regression. `maxRequestRetries: 2` only
        // ever fired when the HANDLER threw, and the handler caught its own
        // navigation failures and returned normally, so nav failures - the one
        // genuinely transient class here - were never retried in the first
        // place. What could reach crawlee's retry was a parse or normalize
        // throw, which is deterministic and produces the identical failure on
        // attempts two and three. Retrying it burned a slot to reach the same
        // answer.
        //
        // It also retires the process-persistent RequestQueue whose cross-run
        // URL dedup silently skipped repeat jobs (handler never ran,
        // processedCount stayed 0, a 20-anchor page reported "confirmed
        // empty"). The ephemeral per-session queue was the workaround for
        // that; with no queue at all the failure mode is gone, not worked
        // around.
        const detailUrls = dedupeUrls(jobsToProcess);

        await mapWithConcurrency(detailUrls, CONFIG.DETAIL_CONCURRENCY, async (url) => {
            processedCount++;
            logProgress('Dice', `Detail ${processedCount}/${detailUrls.length}: ${url}`);

            let pageHtml = '';
            try {
                pageHtml = await withDeadline(
                    (async () => {
                        const jobPage = await getCtx().newPage();
                        try {
                            await jobPage.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.DETAIL_NAV_TIMEOUT_MS });
                            if (CONFIG.DETAIL_RENDER_WAIT_MS > 0) await jobPage.waitForTimeout(CONFIG.DETAIL_RENDER_WAIT_MS);
                            return await jobPage.content();
                        } finally {
                            try { await jobPage.close(); } catch {}
                        }
                    })(),
                    DETAIL_JOB_TIMEOUT_MS,
                    `Dice detail ${url}`,
                );
            } catch (e) {
                // The same disposition crawlee's handler chose: give up on this
                // page and do NOT count it as DOM-changed. A network failure is
                // not evidence that Dice's markup moved, and letting it inflate
                // domChangedCount would trip the batch gate on a bad network.
                logProgress('Dice', `Detail nav failed: ${url} - ${e.message}`);
                return;
            }

            const $job = cheerio.load(pageHtml);
            const scriptBody = $job('script[id="jobDetailStructuredData"]').html();
            const { data: jsonLd, error: parseErr } = parseStructuredData(scriptBody ?? '');
            if (parseErr) {
                logProgress('Dice', `Detail dropped (${parseErr}): ${url}`);
                domChangedCount++;
                return;
            }
            if (jsonLd['@type'] !== 'JobPosting') {
                logProgress('Dice', `Detail dropped (@type=${jsonLd['@type']}): ${url}`);
                domChangedCount++;
                return;
            }
            const row = extractJobFromStructuredData(jsonLd, url);
            if (row.__domChanged) {
                logProgress('Dice', `Detail dropped (${row.reason}): ${url}`);
                domChangedCount++;
                return;
            }
            // Skills + workplace type still pulled via Cheerio.
            const skills = extractSkills($job);
            const workplaceType = extractWorkplaceType($job);

            const normalized = normalizeJobData({
                id: row.jobId,
                title: row.title,
                company: row.company,
                companyProfileUrl: row.companyProfileUrl,
                companyLogoUrl: row.companyLogoUrl,
                location: row.locationFormatted,
                city: row.city,
                state: row.state,
                country: row.country,
                isRemote: row.isRemote,
                workplaceType,
                salary: row.salaryFormatted,
                salary_min: row.salaryMin,
                salary_max: row.salaryMax,
                salary_currency: row.salaryCurrency,
                salary_period: row.salaryPeriod,
                postedDate: row.postedDate,
                validThrough: row.validThrough,
                description: stripHtmlTags(row.description),
                employmentType: row.employmentType,
                skills,
                url: row.url,
            }, 'Dice');
            collectedJobs.push(normalized);
            collectedAnything = true;
            logProgress('Dice', `✅ ${row.title} at ${row.company} (total ${collectedJobs.length})`);
        });

        // Batch-level DOM-changed gate.
        if (processedCount > 0) {
            const rate = domChangedCount / processedCount;
            if (rate > CONFIG.DETAIL_DOM_CHANGED_THRESHOLD) {
                if (collectedAnything) {
                    return { jobs: collectedJobs, emptyConfirmed: false, partial: true };
                }
                throw new DomChangedError(
                    `Dice detail-page DOM-changed rate too high (${domChangedCount}/${processedCount}, threshold ${CONFIG.DETAIL_DOM_CHANGED_THRESHOLD})`,
                    { platform: 'dice' },
                );
            }
        }

        logProgress('Dice', `Completed: ${collectedJobs.length} jobs (${domChangedCount}/${processedCount} dropped)`);
        if (collectedJobs.length === 0) return { jobs: [], emptyConfirmed: true };
        return collectedJobs;
    } finally {
        for (const ctx of contextsToCleanup) {
            try { await ctx.close(); } catch (err) {
                log.warn(`Failed to close context: ${err.message}`);
                getMetrics().recordBrowserCleanupFailure('dice');  // feeds BrowserLeakDetected (audit H1)
            }
        }
        try { await browser.close(); } catch (err) {
            log.warn(`Failed to close browser: ${err.message}`);
            getMetrics().recordBrowserCleanupFailure('dice');  // feeds BrowserLeakDetected (audit H1)
        }
    }
}
