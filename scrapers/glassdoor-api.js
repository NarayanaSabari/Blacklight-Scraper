// Glassdoor via its /graph GraphQL API instead of the browser.
//
// Glassdoor's website is Cloudflare-protected (browser path unreliable). The
// /graph API IS reachable with TLS-impersonation (randomized JA3) via
// node-tls-client — plain Node fetch gets TLS-reset, but the Go tls-client
// passes Cloudflare. Uses the public job-search-next CSRF token (override via
// GLASSDOOR_CSRF_TOKEN). The /graph response carries a harmless `seoData`
// sub-error (Glassdoor-internal DNS); we ignore it and read jobListings.
//
// Verified 2026-06-17: HTTP 200, 30 real jobs/page through the residential
// proxy. Method derived from JobSpy (speedyapply/JobSpy) glassdoor module.
import fs from 'node:fs';
import { launch } from '../src/core/browser-pool.js';
import { initTLS, Session } from 'node-tls-client';
import { normalizeJobData } from '../src/core/normalize.js';
import { getProxyPool } from '../src/core/proxy-pool.js';
import { createLogger } from '../src/logger/index.js';
import { NetworkError, BlockedError } from '../src/core/errors.js';
import { stealthLaunchOptions } from '../src/core/launch-config.js';
import { applyResourceBlocking } from '../src/core/resource-blocking.js';
import { extractJobDetailsFromHTML, isBlockedPage } from '../src/core/glassdoor-jd.js';

const log = createLogger('glassdoor-api');
const QUERY = fs.readFileSync(new URL('./glassdoor-query.graphql', import.meta.url), 'utf8');
// Cloudflare hands out the cookies /graph requires only on a real page hit, so
// every session GETs this first. Must be a /Job/*.htm path — the bare homepage
// is itself 403 and works as no warm-up at all.
const WARMUP_URL = process.env.GLASSDOOR_WARMUP_URL || 'https://www.glassdoor.com/Job/computer-science-jobs.htm';
const WARMUP_ATTEMPTS = Number.parseInt(process.env.GLASSDOOR_WARMUP_ATTEMPTS, 10) || 3;
const WARMUP_BACKOFF_MS = Number.parseInt(process.env.GLASSDOOR_WARMUP_BACKOFF_MS, 10) || 1500;
// Glassdoor's own session cookies. __cf_bm alone means Cloudflare answered with
// the challenge page instead of Glassdoor, which /graph then rejects.
const SESSION_COOKIES = ['gdsid', 'gdId'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hasSessionCookie(response) {
    const raw = response?.headers?.['set-cookie'] ?? response?.headers?.['Set-Cookie'];
    if (!raw) return false;
    const names = (Array.isArray(raw) ? raw : [raw]).map((c) => String(c).split('=')[0].trim());
    return SESSION_COOKIES.some((n) => names.includes(n));
}
const DEFAULT_TOKEN = 'Ft6oHEWlRZrxDww95Cpazw:0pGUrkb2y3TyOpAIqF2vbPmUXoXVkD3oEGDVkvfeCerceQ5-n8mBg3BovySUIjmCPHCaW0H2nQVdqzbtsYqf4Q:wcqRqeegRUa9MVLJGyujVXB7vWFPjdaS1CtrrzJq-ok';

let _tlsInit = null;
const ensureTLS = () => (_tlsInit ??= initTLS());

function gdHeaders(env) {
    return {
        'apollographql-client-name': 'job-search-next',
        'apollographql-client-version': '4.65.5',
        'content-type': 'application/json',
        'gd-csrf-token': env.GLASSDOOR_CSRF_TOKEN || DEFAULT_TOKEN,
        origin: 'https://www.glassdoor.com',
        referer: 'https://www.glassdoor.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
}
function proxyStr(proxy) {
    if (!proxy?.server) return undefined;
    const hp = String(proxy.server).replace(/^https?:\/\//, '');
    return proxy.username ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${hp}` : `http://${hp}`;
}
// Listing age in days from the Glassdoor header (null when unknown).
export function listingAgeDays(l) {
    const age = l?.jobview?.header?.ageInDays;
    return typeof age === 'number' ? age : null;
}
// Within the recency cutoff? Unknown age → keep (don't over-drop on missing data).
export function isFreshListing(l, maxAgeDays) {
    const age = listingAgeDays(l);
    return age === null || age <= maxAgeDays;
}
function mapListing(l, description) {
    const h = l?.jobview?.header;
    if (!h?.jobTitleText) return null;
    const url = h.jobLink ? `https://www.glassdoor.com${h.jobLink}` : 'N/A';
    let datePosted = 'N/A';
    if (typeof h.ageInDays === 'number') datePosted = new Date(Date.now() - h.ageInDays * 86400000).toISOString();
    return normalizeJobData({
        title: h.jobTitleText,
        company: h.employerNameFromSearch || 'N/A',
        location: h.locationName || 'N/A',
        url,
        jobLink: url,
        description: description || 'N/A',
        datePosted,
    }, 'Glassdoor');
}

// The API's `jobview.job.description` field is empty for every listing
// (verified 2026-07-28) — Glassdoor only serves the real description on the
// job's own page, server-rendered into a JSON-LD block. Fetch each listing's
// page with ONE shared CloakBrowser and a small worker pool so descriptions
// arrive in seconds rather than the 3-5s/job the full browser scraper path
// costs. domcontentloaded is enough: the JSON-LD is present before any JS
// runs, so no humanDelay/sleep is added here on purpose — that would
// reintroduce the exact per-job cost this path exists to avoid.
//
// Fault-tolerant by design: any single page failing/timing out just leaves
// that listing without a description (mapListing falls back to 'N/A') and
// never fails the scrape. Returns a Map keyed by the listing's index in
// `listings`.
async function enrichDescriptions(listings, { proxy, onBlocked } = {}) {
    const results = new Map();
    const urls = listings.map((l) => {
        const link = l?.jobview?.header?.jobLink;
        return link ? `https://www.glassdoor.com${link}` : null;
    });
    if (urls.every((u) => !u)) return results;

    const concurrency = Math.max(1, Number.parseInt(process.env.GLASSDOOR_DESC_CONCURRENCY, 10) || 6);
    let browser = null;
    try {
        browser = await launch(stealthLaunchOptions({ proxy }));
        const context = await browser.newContext({
            viewport: { width: 1366, height: 900 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
        });
        await applyResourceBlocking(context);

        let cursor = 0;
        // Once this IP is rate-limited every remaining fetch returns the same
        // denial page, so stop the whole batch on the first one rather than
        // grinding through the rest for nothing.
        let blocked = false;
        async function worker() {
            const page = await context.newPage();
            try {
                while (cursor < urls.length && !blocked) {
                    const i = cursor++;
                    const url = urls[i];
                    if (!url) continue;
                    try {
                        const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
                        const html = await page.content();
                        if (isBlockedPage(resp?.status(), html)) {
                            blocked = true;
                            break;
                        }
                        const details = extractJobDetailsFromHTML(html);
                        if (details?.fullDescription) results.set(i, details.fullDescription);
                    } catch (e) {
                        log.warn('Glassdoor description fetch failed', { url, error: e?.message });
                    }
                }
            } finally {
                await page.close().catch(() => {});
            }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
        if (blocked) {
            log.warn('Glassdoor rate-limited the job-page fetches — cooling this IP', {
                proxy: proxy?.server || 'direct', enriched: results.size, of: urls.length,
            });
            onBlocked?.();
        }
    } catch (e) {
        log.warn('Glassdoor description enrichment failed', { error: e?.message });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
    return results;
}

// Returns { jobs, emptyConfirmed }. Throws on hard failure so BaseScraper records
// it and the caller can fall back to the browser path.
export async function scrapeGlassdoorViaApi(jobTitle, location, sessionId, options = {}, deps = {}) {
    const maxJobs = options.maxJobs || 30;
    // Client-side recency cutoff (days). Mirrors the importer's 7-day too_old
    // filter so stale Glassdoor listings are dropped before submission, not
    // after. Tunable via GLASSDOOR_MAX_AGE_DAYS.
    const MAX_AGE_DAYS = Number.parseInt(process.env.GLASSDOOR_MAX_AGE_DAYS, 10) || 7;
    const locationId = Number.parseInt(process.env.GLASSDOOR_LOCATION_ID, 10) || 11047; // US (JobSpy default)
    // Injectable so unit tests don't need network — initTLS() fetches the
    // tls-client binary's version from GitHub on first call.
    await (deps.ensureTLS || ensureTLS)();
    const pool = (deps.getProxyPool || getProxyPool)();
    const SessionCtor = deps.Session || Session;
    const session = new SessionCtor({ clientIdentifier: 'chrome_120', randomTlsExtensionOrder: true, timeout: 30000 });
    const rawListings = []; // fresh listings, collected before enrichment/mapping
    let proxy = null;
    try {
        // A cold /graph POST is 403 no matter how valid the CSRF token is; the
        // same POST succeeds once the session holds Glassdoor's cookies. Getting
        // them means clearing Cloudflare on a real page hit, which only sometimes
        // works from a given IP — so retry, rotating the proxy each time, and
        // only then give up. Verified 2026-07-28: a warm-up that returns the
        // Cloudflare challenge page yields __cf_bm alone and the POST is always
        // 403; one that gets through yields gdsid/gdId and the POST returns 200.
        let warmed = false;
        for (let attempt = 1; attempt <= WARMUP_ATTEMPTS && !warmed; attempt++) {
            proxy = pool.acquire('glassdoor');
            let detail;
            try {
                const w = await session.get(WARMUP_URL, {
                    headers: {
                        'user-agent': gdHeaders(process.env)['user-agent'],
                        'accept-language': 'en-US,en;q=0.9',
                        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                    proxy: proxyStr(proxy),
                });
                await w.text?.().catch(() => {});
                warmed = hasSessionCookie(w);
                detail = `HTTP ${w.status}`;
            } catch (e) {
                detail = e?.message;
            }
            if (warmed) break;
            // No usable cookies: this IP is being challenged. Cool it so the next
            // attempt (and the next role) lands on a different one.
            pool.reportBlocked('glassdoor');
            log.warn('Glassdoor warm-up did not yield session cookies', { attempt, of: WARMUP_ATTEMPTS, detail });
            if (attempt < WARMUP_ATTEMPTS) await sleep(WARMUP_BACKOFF_MS * attempt);
        }
        if (!warmed) {
            // Skip the POST — without these cookies it is a guaranteed 403.
            throw new BlockedError('Glassdoor warm-up challenged (no session cookies)', { platform: 'glassdoor', kind: 'warmup_block' });
        }

        let pageNumber = 1;
        let cursor = null;
        for (let i = 0; i < 4 && rawListings.length < maxJobs; i++) {
            const payload = [{
                operationName: 'JobSearchResultsQuery',
                variables: {
                    excludeJobListingIds: [], filterParams: [], keyword: jobTitle,
                    numJobsToShow: 30, locationType: 'STATE', locationId,
                    parameterUrlInput: `IL.0,12_ISTATE${locationId}`,
                    pageNumber, pageCursor: cursor, fromage: null, sort: 'date',
                },
                query: QUERY,
            }];
            const r = await session.post('https://www.glassdoor.com/graph', { headers: gdHeaders(process.env), body: JSON.stringify(payload), proxy: proxyStr(proxy) });
            if (r.status === 403 || r.status === 429 || r.status === 401) {
                throw new BlockedError(`Glassdoor API HTTP ${r.status}`, { platform: 'glassdoor', kind: 'api_block' });
            }
            const text = await r.text();
            let body; try { body = JSON.parse(text); } catch { throw new NetworkError(`Glassdoor API non-JSON (HTTP ${r.status})`, { platform: 'glassdoor' }); }
            const j = Array.isArray(body) ? body[0] : body;
            const data = j?.data?.jobListings;          // present even alongside the seoData sub-error
            const listings = data?.jobListings;
            if (!Array.isArray(listings)) throw new NetworkError(`Glassdoor API returned no jobListings (HTTP ${r.status})`, { platform: 'glassdoor' });
            if (listings.length === 0) { if (rawListings.length === 0) return { jobs: [], emptyConfirmed: true }; break; }
            // Recency filter at the SOURCE: Glassdoor is queried with fromage:null
            // (no server-side date filter) and for most roles ~79% of what it
            // returns is older than the 7-day import cutoff — those jobs were
            // being shipped only to be dropped as "too_old" downstream (~445K/12h
            // of pure waste). Drop stale listings here (h.ageInDays) so they
            // never enter the pipeline. Since sort:'date' is newest-first, a
            // FULLY-stale page means every later page is stale too → stop.
            let freshOnPage = 0;
            for (const l of listings) {
                if (!isFreshListing(l, MAX_AGE_DAYS)) continue; // drop stale at source
                freshOnPage++;
                rawListings.push(l);
                if (rawListings.length >= maxJobs) break;
            }
            if (freshOnPage === 0) break; // entire page stale → later pages older still
            const next = (data.paginationCursors || []).find((c) => c.pageNumber === pageNumber + 1);
            if (!next?.cursor) break;
            cursor = next.cursor; pageNumber += 1;
        }
    } finally { await session.close().catch(() => {}); }

    // Descriptions come from a per-job page fetch (the /graph API's own
    // description field is empty) — see enrichDescriptions() above. Mapped
    // LAST, after every page of listings is in hand, so this single browser
    // launch enriches the whole batch instead of one per page.
    let descriptions = new Map();
    if (process.env.GLASSDOOR_FETCH_DESCRIPTIONS !== 'false' && rawListings.length > 0) {
        try {
            // Leased under its OWN pool key, because discovery and enrichment want
            // opposite network paths (verified 2026-07-28): Cloudflare challenges
            // the tls-client /graph POST from ISP-proxy IPs, so discovery has to
            // stay direct via PROXY_EXCLUDE_PLATFORMS=glassdoor — but CloakBrowser
            // DOES clear Cloudflare on those same IPs, and routing the per-job page
            // fetches through the pool is what stops one direct IP degrading into
            // "Access denied" after a few dozen requests. Exclude 'glassdoor-jd'
            // too if a host genuinely needs both paths direct.
            const jdProxy = pool.acquire('glassdoor-jd');
            descriptions = await (deps.enrichDescriptions || enrichDescriptions)(rawListings, {
                proxy: jdProxy,
                onBlocked: () => pool.reportBlocked('glassdoor-jd'),
            });
        } catch (e) {
            log.warn('Glassdoor description enrichment threw — continuing with N/A descriptions', { error: e?.message });
        }
    }
    const jobs = [];
    rawListings.forEach((l, i) => {
        const job = mapListing(l, descriptions.get(i));
        if (job) jobs.push(job);
    });
    log.info('Glassdoor API scrape complete', { jobCount: jobs.length, proxy: proxy?.server || 'direct' });
    return { jobs: jobs.slice(0, maxJobs), emptyConfirmed: jobs.length === 0 };
}
