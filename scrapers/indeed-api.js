// Indeed via the mobile GraphQL API (apis.indeed.com) instead of the website.
//
// The public Indeed website is behind a Cloudflare HARD block (our browser path
// scored ~0%). Indeed's iOS-app backend (apis.indeed.com/graphql) has NO
// Cloudflare wall — a plain authenticated POST returns clean job JSON in <1s.
// The api key is the public iOS-app key (same one JobSpy and other OSS tools
// use); override via INDEED_API_KEY. Routed through the residential proxy pool.
//
// Verified 2026-06-17: 25 jobs/page, paginable, ~0.6-2.2s through Decodo.
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { stripHtmlTags } from '../src/core/html.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { getProxyPool } from '../src/core/proxy-pool.js';
import { createLogger } from '../src/logger/index.js';
import { NetworkError, BlockedError } from '../src/core/errors.js';

const log = createLogger('indeed-api');
const ENDPOINT = 'https://apis.indeed.com/graphql';
const DEFAULT_KEY = '161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8';

export function apiHeaders(env = process.env) {
    return {
        Host: 'apis.indeed.com',
        'content-type': 'application/json',
        'indeed-api-key': env.INDEED_API_KEY || DEFAULT_KEY,
        accept: 'application/json',
        'indeed-locale': 'en-US',
        'indeed-co': 'US',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Indeed App 193.1',
        'indeed-app-info': 'appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone',
    };
}

export function buildQuery({ what, where, radius = 50, cursor = null }) {
    const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `query GetJobData {
  jobSearch(
    ${what ? `what: "${esc(what)}"` : ''}
    ${where ? `location: {where: "${esc(where)}", radius: ${Number(radius) || 50}, radiusUnit: MILES}` : ''}
    limit: 100
    ${cursor ? `cursor: "${esc(cursor)}"` : ''}
    sort: RELEVANCE
  ) {
    pageInfo { nextCursor }
    results { job {
      key title datePublished
      description { html }
      location { city admin1Code countryCode postalCode formatted { long } }
      employer { name }
      compensation { baseSalary { unitOfWork range { ... on Range { min max } } } currencyCode }
    } }
  }
}`;
}

function proxyDispatcher(proxy) {
    if (!proxy?.server) return undefined;
    const hostPort = String(proxy.server).replace(/^https?:\/\//, '');
    const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : '';
    return new ProxyAgent(`http://${auth}${hostPort}`);
}

function salaryString(comp) {
    const r = comp?.baseSalary?.range;
    if (!r || (r.min == null && r.max == null)) return '';
    const cur = comp.currencyCode || 'USD';
    const unit = (comp.baseSalary.unitOfWork || '').toLowerCase();
    const per = unit && unit !== 'unknown' ? ` / ${unit}` : '';
    if (r.min != null && r.max != null) return `${cur} ${r.min}–${r.max}${per}`;
    return `${cur} ${r.min ?? r.max}${per}`;
}

function mapJob(j) {
    if (!j?.title) return null;
    const loc = j.location?.formatted?.long
        || [j.location?.city, j.location?.admin1Code].filter(Boolean).join(', ')
        || 'N/A';
    let datePosted = 'N/A';
    if (j.datePublished != null) {
        const ms = Number(j.datePublished);
        if (Number.isFinite(ms)) datePosted = new Date(ms).toISOString();
    }
    const comp = j.compensation;
    const range = comp?.baseSalary?.range;
    const unit = (comp?.baseSalary?.unitOfWork || '').toLowerCase();
    return normalizeJobData({
        jobId: j.key,
        title: j.title,
        company: j.employer?.name || 'N/A',
        location: loc,
        city: j.location?.city || null,
        state: j.location?.admin1Code || null,
        country: j.location?.countryCode || null,
        url: j.key ? `https://www.indeed.com/viewjob?jk=${j.key}` : 'N/A',
        description: stripHtmlTags(j.description?.html || '') || 'N/A',
        datePosted,
        salary: salaryString(comp),
        salaryMin: range?.min ?? null,
        salaryMax: range?.max ?? null,
        salaryCurrency: comp?.currencyCode || null,
        salaryPeriod: unit && unit !== 'unknown' ? unit : null,
    }, 'Indeed');
}

// Returns { jobs, emptyConfirmed }. Throws BlockedError/NetworkError on failure
// so BaseScraper records it correctly (and the caller can fall back to browser).
export async function scrapeIndeedViaApi(jobTitle, location, sessionId, options = {}, deps = {}) {
    const maxJobs = options.maxJobs || 40;
    // Use undici's fetch (not Node's global) so it shares the same undici as the
    // ProxyAgent dispatcher — mixing versions throws "invalid onRequestStart method".
    const fetchFn = deps.fetch || undiciFetch;
    const proxy = (deps.getProxyPool || getProxyPool)().acquire('indeed');
    const dispatcher = deps.dispatcher || proxyDispatcher(proxy);
    const headers = apiHeaders();

    const jobs = [];
    let cursor = null;
    for (let page = 0; page < 12 && jobs.length < maxJobs; page++) {
        const body = JSON.stringify({ query: buildQuery({ what: jobTitle, where: location, cursor }) });
        let res; let text;
        try {
            res = await fetchFn(ENDPOINT, { method: 'POST', headers, body, ...(dispatcher ? { dispatcher } : {}) });
            text = await res.text();
        } catch (e) {
            throw new NetworkError(`Indeed API request failed: ${e.message}`, { platform: 'indeed', cause: e });
        }
        if (res.status === 403 || res.status === 429 || res.status === 401) {
            throw new BlockedError(`Indeed API HTTP ${res.status}`, { platform: 'indeed', kind: 'api_block' });
        }
        let data;
        try { data = JSON.parse(text); } catch {
            throw new NetworkError(`Indeed API non-JSON (HTTP ${res.status})`, { platform: 'indeed' });
        }
        const results = data?.data?.jobSearch?.results;
        if (!Array.isArray(results)) {
            if (data?.errors) throw new NetworkError(`Indeed API GraphQL error: ${JSON.stringify(data.errors).slice(0, 200)}`, { platform: 'indeed' });
            break;
        }
        if (results.length === 0) {
            if (jobs.length === 0) return { jobs: [], emptyConfirmed: true };
            break;
        }
        for (const r of results) {
            const job = mapJob(r.job);
            if (job) jobs.push(job);
            if (jobs.length >= maxJobs) break;
        }
        cursor = data.data.jobSearch.pageInfo?.nextCursor;
        if (!cursor) break;
    }
    log.info('Indeed API scrape complete', { jobCount: jobs.length, proxy: proxy?.server || 'direct' });
    return { jobs: jobs.slice(0, maxJobs), emptyConfirmed: jobs.length === 0 };
}
