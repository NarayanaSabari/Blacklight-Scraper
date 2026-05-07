// Monster Job Scraper Module
//
// Sits behind DataDome bot mitigation. Every API request must carry a
// valid `x-datadome-clientid` + `datadome` cookie pair, otherwise we
// get 403 → captcha redirect.
//
// Two-tier session strategy:
//
//   1. Manual session (preferred) — cookies + clientid exported from a
//      real browser that solved the captcha (see src/core/datadome.js).
//      Loaded from config/credentials.json, hot-reloaded on file change.
//      Yields ~100% success while the cookie is fresh (typically ~24h).
//
//   2. Legacy hardcoded path (fallback) — single clientid + headers
//      reverse-engineered when this scraper was first written. Yields
//      ~80% success in production; the other ~20% gets challenged when
//      DataDome's reputation drift catches up. Kept as a safety net so
//      Monster never goes to 0% if the manual session is missing or
//      stale.
//
// Mid-scrape 403 handling: if the manual session 403s on any request,
// we transparently retry that single request with legacy headers and
// continue the loop on the legacy path. The scrape never throws on a
// recoverable 403 — worst case = today's legacy behavior.
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { humanDelay } from '../src/core/delays.js';
import { stripHtmlTags } from '../src/core/html.js';
import { loadMonsterSession } from '../src/core/datadome.js';
import { getMetrics } from '../src/metrics/registry.js';

const log = createLogger('monster');

const MONSTER_API_KEY = 'hkp1igv13sjt7ltv5kfdhjpj';
const MONSTER_API_URL = `https://appsapi.monster.io/jobs-svx-service/v2/monster/search-jobs/samsearch/en-US?apikey=${MONSTER_API_KEY}`;

// Reverse-engineered constant clientid for the fallback path. Same value
// every monster.com web visitor sends; not a secret. Inlined so the
// scraper still works when no manual session is configured.
const LEGACY_DATADOME_CLIENT_ID =
    'jcq2Bhd0iT8Ca3HzJ1r21Z_reNQ3HUjjnRSB7lKP2LuvVcLndhl3yFVrADzdIyMCeOkSQ0uvT1DThly2wkEJZAWZYjvAP480CIP8LYqtI9z9fEtKaiIEkm1LbnGycdM6';

const MAX_JOBS = 100;
const PAGE_SIZE = 18;
const MAX_CONSECUTIVE_EMPTY_PAGES = 3;

function legacyHeaders(jobTitle, location) {
    return {
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9,en-IN;q=0.8',
        'content-type': 'application/json; charset=UTF-8',
        origin: 'https://www.monster.com',
        priority: 'u=1, i',
        referer: `https://www.monster.com/jobs/search?q=${encodeURIComponent(jobTitle)}&where=${encodeURIComponent(location)}&page=1&recency=last+week&so=m.s.sh`,
        'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'user-agent':
            'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 Edg/143.0.0.0',
        'x-datadome-clientid': LEGACY_DATADOME_CLIENT_ID,
    };
}

function buildBody(jobTitle, location, offset, searchId) {
    let country = 'us';
    let address = location;
    if (location.includes(',')) {
        const parts = location.split(',').map((p) => p.trim());
        address = parts[0];
        if (parts[1] && parts[1].length === 2) country = parts[1].toLowerCase();
    }
    const body = {
        jobQuery: {
            query: jobTitle,
            locations: [{ country, address, radius: { unit: 'mi', value: 30 } }],
            datePosted: 'last week',
        },
        jobAdsRequest: {
            position: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
            placement: {
                channel: 'WEB',
                location: 'JobSearchPage',
                property: 'monster.com',
                type: 'JOB_SEARCH',
                view: 'SPLIT',
            },
        },
        fingerprintId: 'z5155923fe9543392e709bd648773ebf5',
        pageSize: PAGE_SIZE,
        freeJobsOnly: true,
        siteId: 'monster.com',
        offset,
    };
    if (searchId) body.searchId = searchId;
    else body.includeJobs = [];
    return body;
}

async function postSearch(headers, body) {
    return fetch(MONSTER_API_URL, {
        method: 'POST',
        headers: { ...headers, 'request-starttime': Date.now().toString() },
        body: JSON.stringify(body),
    });
}

export async function scrapeMonster(jobTitle, location) {
    log.info(`Searching for "${jobTitle}" in "${location}"`);

    const session = loadMonsterSession();
    let activeHeaders = session ? session.headers : legacyHeaders(jobTitle, location);
    // path tracks what we end up using. Starts as manual or legacy and
    // promotes to "fallback" if we degrade mid-scrape.
    let path = session ? 'manual' : 'legacy';
    log.info(`Using ${path} DataDome session`);

    const allJobs = [];
    const seenUrls = new Set();
    let offset = 0;
    let searchId = null;
    let consecutiveEmptyPages = 0;
    const metrics = getMetrics();

    try {
        while (allJobs.length < MAX_JOBS) {
            const body = buildBody(jobTitle, location, offset, searchId);
            await humanDelay();
            let response = await postSearch(activeHeaders, body);

            // Mid-scrape fallback: if we're on the manual path and got
            // 403 (DataDome challenge), retry this same request with
            // legacy headers and run the rest of the loop on legacy.
            if (response.status === 403 && path === 'manual') {
                log.warn(
                    'Manual DataDome session got 403 — falling back to legacy clientid for this scrape',
                );
                activeHeaders = legacyHeaders(jobTitle, location);
                path = 'fallback';
                response = await postSearch(activeHeaders, body);
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'No error details');
                log.info(`API returned ${response.status}: ${errorText.substring(0, 200)}`);
                throw new Error(`API call failed: ${response.status} - ${response.statusText}`);
            }

            const json = await response.json();
            if (!searchId && json.searchId) {
                searchId = json.searchId;
                log.info(`Search ID captured: ${searchId}`);
            }

            const jobs = json.jobResults || [];
            if (jobs.length === 0) break;

            const extractedJobs = jobs.map((job) =>
                normalizeJobData(
                    {
                        title: job.jobPosting?.title,
                        url: job.canonicalUrl || job.jobPosting?.url,
                        description: stripHtmlTags(job.jobPosting?.description),
                        datePosted: job.jobPosting?.datePosted,
                        employmentType: job.jobPosting?.employmentType?.join(', '),
                        hiringOrganization: job.jobPosting?.hiringOrganization?.name,
                        jobLocation: job.jobPosting?.jobLocation
                            ?.map(
                                (loc) =>
                                    `${loc.address?.addressLocality}, ${loc.address?.addressRegion}`,
                            )
                            .join('; '),
                        applyUrl: job.apply?.applyUrl,
                    },
                    'Monster',
                ),
            );

            let newJobsCount = 0;
            for (const job of extractedJobs) {
                const jobUrl = job.job?.url || '';
                if (!seenUrls.has(jobUrl) && jobUrl !== 'N/A' && jobUrl !== '') {
                    seenUrls.add(jobUrl);
                    allJobs.push(job);
                    newJobsCount++;
                    if (allJobs.length >= MAX_JOBS) break;
                }
            }

            offset += PAGE_SIZE;
            log.info(
                `Fetched ${jobs.length} jobs, ${newJobsCount} new unique jobs, total unique: ${allJobs.length}`,
            );

            if (newJobsCount === 0) {
                consecutiveEmptyPages++;
                if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) {
                    log.info(
                        `No new unique jobs found in last ${MAX_CONSECUTIVE_EMPTY_PAGES} pages. Stopping...`,
                    );
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
            }

            if (allJobs.length >= MAX_JOBS) break;
        }

        const jobsToReturn = allJobs.slice(0, MAX_JOBS);
        log.info(`Completed! Found ${jobsToReturn.length} unique jobs (path=${path})`);
        metrics.recordMonsterDataDomePath(path, 'success');
        return jobsToReturn;
    } catch (err) {
        metrics.recordMonsterDataDomePath(path, 'failed');
        throw err;
    }
}
