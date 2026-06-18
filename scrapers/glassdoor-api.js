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
import { initTLS, Session } from 'node-tls-client';
import { normalizeJobData } from '../src/core/normalize.js';
import { getProxyPool } from '../src/core/proxy-pool.js';
import { createLogger } from '../src/logger/index.js';
import { NetworkError, BlockedError } from '../src/core/errors.js';

const log = createLogger('glassdoor-api');
const QUERY = fs.readFileSync(new URL('./glassdoor-query.graphql', import.meta.url), 'utf8');
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
function mapListing(l) {
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
        description: 'N/A',
        datePosted,
    }, 'Glassdoor');
}

// Returns { jobs, emptyConfirmed }. Throws on hard failure so BaseScraper records
// it and the caller can fall back to the browser path.
export async function scrapeGlassdoorViaApi(jobTitle, location, sessionId, options = {}, deps = {}) {
    const maxJobs = options.maxJobs || 30;
    const locationId = Number.parseInt(process.env.GLASSDOOR_LOCATION_ID, 10) || 11047; // US (JobSpy default)
    await ensureTLS();
    const proxy = (deps.getProxyPool || getProxyPool)().acquire('glassdoor');
    const SessionCtor = deps.Session || Session;
    const session = new SessionCtor({ clientIdentifier: 'chrome_120', randomTlsExtensionOrder: true, timeout: 30000 });
    const jobs = [];
    try {
        let pageNumber = 1;
        let cursor = null;
        for (let i = 0; i < 4 && jobs.length < maxJobs; i++) {
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
            if (listings.length === 0) { if (jobs.length === 0) return { jobs: [], emptyConfirmed: true }; break; }
            for (const l of listings) { const job = mapListing(l); if (job) jobs.push(job); if (jobs.length >= maxJobs) break; }
            const next = (data.paginationCursors || []).find((c) => c.pageNumber === pageNumber + 1);
            if (!next?.cursor) break;
            cursor = next.cursor; pageNumber += 1;
        }
    } finally { await session.close().catch(() => {}); }
    log.info('Glassdoor API scrape complete', { jobCount: jobs.length, proxy: proxy?.server || 'direct' });
    return { jobs: jobs.slice(0, maxJobs), emptyConfirmed: jobs.length === 0 };
}
