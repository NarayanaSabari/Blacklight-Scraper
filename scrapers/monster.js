// Monster Job Scraper Module
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { humanDelay } from '../src/core/delays.js';
import { stripHtmlTags } from '../src/core/html.js';

const log = createLogger('monster');

// Public Monster.com web-app constants — reverse-engineered from the
// browser frontend. These aren't secrets; they're the same values every
// monster.com visitor sends. Inlined so the scraper needs zero config.
const MONSTER_API_KEY = 'hkp1igv13sjt7ltv5kfdhjpj';
const MONSTER_DATADOME_CLIENT_ID = 'jcq2Bhd0iT8Ca3HzJ1r21Z_reNQ3HUjjnRSB7lKP2LuvVcLndhl3yFVrADzdIyMCeOkSQ0uvT1DThly2wkEJZAWZYjvAP480CIP8LYqtI9z9fEtKaiIEkm1LbnGycdM6';

export async function scrapeMonster(jobTitle, location) {
    log.info(`Searching for "${jobTitle}" in "${location}"`);

    const apiUrl = `https://appsapi.monster.io/jobs-svx-service/v2/monster/search-jobs/samsearch/en-US?apikey=${MONSTER_API_KEY}`;

    const headers = {
        'accept': 'application/json',
        'accept-language': 'en-US,en;q=0.9,en-IN;q=0.8',
        'content-type': 'application/json; charset=UTF-8',
        'origin': 'https://www.monster.com',
        'priority': 'u=1, i',
        'referer': `https://www.monster.com/jobs/search?q=${encodeURIComponent(jobTitle)}&where=${encodeURIComponent(location)}&page=1&recency=last+week&so=m.s.sh`,
        'request-starttime': Date.now().toString(),
        'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 Edg/143.0.0.0',
        'x-datadome-clientid': MONSTER_DATADOME_CLIENT_ID,
    };

    let country = 'us';
    let address = location;
    
    if (location.includes(',')) {
        const parts = location.split(',').map(p => p.trim());
        address = parts[0];
        if (parts[1] && parts[1].length === 2) {
            country = parts[1].toLowerCase();
        }
    }

    const baseData = {
        "jobQuery": {
            "query": jobTitle,
            "locations": [{"country": country, "address": address, "radius": {"unit": "mi", "value": 30}}],
            "datePosted": "last week"
        },
        "jobAdsRequest": {
            "position": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18],
            "placement": {
                "channel": "WEB",
                "location": "JobSearchPage",
                "property": "monster.com",
                "type": "JOB_SEARCH",
                "view": "SPLIT"
            }
        },
        "fingerprintId": "z5155923fe9543392e709bd648773ebf5",
        "pageSize": 18,
        "includeJobs": [],
        "freeJobsOnly": true,
        "siteId": "monster.com"
    };

    const allJobs = [];
    const seenUrls = new Set(); // Track unique job URLs
    let offset = 0;
    let searchId = null; // Store searchId from first response
    const maxJobs = 100;
    let consecutiveEmptyPages = 0;

    while (allJobs.length < maxJobs) {
        const data = { ...baseData, offset };
        
        // Add searchId to subsequent requests (after first request)
        if (searchId) {
            data.searchId = searchId;
            delete data.includeJobs; // Not needed after first request
        }
        
        // Update request-starttime for each request
        headers['request-starttime'] = Date.now().toString();
        
        await humanDelay();

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'No error details');
            log.info(`API returned ${response.status}: ${errorText.substring(0, 200)}`);
            throw new Error(`API call failed: ${response.status} - ${response.statusText}`);
        }

        const json = await response.json();
        
        // Capture searchId from first response
        if (!searchId && json.searchId) {
            searchId = json.searchId;
            log.info(`Search ID captured: ${searchId}`);
        }
        
        const jobs = json.jobResults || [];

        if (jobs.length === 0) break;

        const extractedJobs = jobs.map(job => normalizeJobData({
            title: job.jobPosting?.title,
            url: job.canonicalUrl || job.jobPosting?.url,
            description: stripHtmlTags(job.jobPosting?.description),
            datePosted: job.jobPosting?.datePosted,
            employmentType: job.jobPosting?.employmentType?.join(', '),
            hiringOrganization: job.jobPosting?.hiringOrganization?.name,
            jobLocation: job.jobPosting?.jobLocation?.map(loc => 
                `${loc.address?.addressLocality}, ${loc.address?.addressRegion}`
            ).join('; '),
            applyUrl: job.apply?.applyUrl
        }, 'Monster'));

        // Filter out duplicates based on URL
        let newJobsCount = 0;
        for (const job of extractedJobs) {
            const jobUrl = job.job?.url || '';
            if (!seenUrls.has(jobUrl) && jobUrl !== 'N/A' && jobUrl !== '') {
                seenUrls.add(jobUrl);
                allJobs.push(job);
                newJobsCount++;
                
                if (allJobs.length >= maxJobs) break;
            }
        }

        offset += 18;

        log.info(`Fetched ${jobs.length} jobs, ${newJobsCount} new unique jobs, total unique: ${allJobs.length}`);

        // If we got no new jobs, increment counter
        if (newJobsCount === 0) {
            consecutiveEmptyPages++;
            // Stop if we've seen 3 consecutive pages with no new jobs
            if (consecutiveEmptyPages >= 3) {
                log.info('No new unique jobs found in last 3 pages. Stopping...');
                break;
            }
        } else {
            consecutiveEmptyPages = 0;
        }

        if (allJobs.length >= maxJobs) break;
    }

    const jobsToReturn = allJobs.slice(0, maxJobs);
    log.info(`Completed! Found ${jobsToReturn.length} unique jobs`);
    
    return jobsToReturn;
}
