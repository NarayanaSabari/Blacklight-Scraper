// Focused probe: how often does the Dice recruiter feature actually
// surface data today? Visits 10 detail pages, counts how many have a
// recruiterId regex hit, then for each recruiterId follows the profile
// page and counts how many parse cleanly (firstName/lastName/companyName).

import fs from 'node:fs';
import { launch } from 'cloakbrowser';

const ROLE = process.env.PROBE_ROLE || 'software engineer';
const LOC  = process.env.PROBE_LOC  || 'United States';
const SAMPLE_SIZE = 10;

const browser = await launch({ headless: true });
const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
});
const page = await context.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[probe]', ...a);

// 1. Collect job URLs
log(`Collecting ${SAMPLE_SIZE} job URLs for "${ROLE}" in "${LOC}"...`);
await page.goto(
    `https://www.dice.com/jobs?q=${encodeURIComponent(ROLE)}&location=${encodeURIComponent(LOC)}&filters.postedDate=SEVEN&page=1`,
    { waitUntil: 'domcontentloaded', timeout: 30000 },
);
await sleep(3000);
const jobUrls = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('a[href*="/job-detail/"]')].map(a => a.href))]
).then(arr => arr.slice(0, 10));
log(`Got ${jobUrls.length} URLs`);

const results = [];

for (let i = 0; i < jobUrls.length; i++) {
    const url = jobUrls[i];
    log(`#${i + 1} ${url}`);
    const row = { i: i + 1, url, hasStructuredData: false, hasRecruiterIdRegex: false, recruiterId: null, recruiterProfileParsed: null };
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1500);
        const checks = await page.evaluate(() => {
            const sd = document.querySelector('script[id="jobDetailStructuredData"]');
            const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '');
            let recruiterId = null;
            for (const s of scripts) {
                if (!s.includes('recruiterId')) continue;
                const m = s.match(/"recruiterId"\s*:\s*"([a-f0-9-]{36})"/);
                if (m) { recruiterId = m[1]; break; }
            }
            return { sdPresent: !!sd, recruiterId };
        });
        row.hasStructuredData = checks.sdPresent;
        row.recruiterId = checks.recruiterId;
        row.hasRecruiterIdRegex = !!checks.recruiterId;

        if (checks.recruiterId) {
            const ru = `https://www.dice.com/recruiter-profile/${checks.recruiterId}`;
            try {
                await page.goto(ru, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await sleep(1200);
                const profile = await page.evaluate(() => {
                    const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '');
                    let firstName = null, lastName = null, jobTitle = null, companyName = null;
                    for (const s of scripts) {
                        const f = s.match(/"firstName"\s*:\s*"([^"]+)"/);
                        const l = s.match(/"lastName"\s*:\s*"([^"]+)"/);
                        const t = s.match(/"jobTitle"\s*:\s*"([^"]+)"/);
                        const c = s.match(/"companyName"\s*:\s*"([^"]+)"/);
                        if (f && !firstName) firstName = f[1];
                        if (l && !lastName)  lastName  = l[1];
                        if (t && !jobTitle)  jobTitle  = t[1];
                        if (c && !companyName) companyName = c[1];
                    }
                    return { firstName, lastName, jobTitle, companyName };
                });
                row.recruiterProfileParsed = profile;
            } catch (e) {
                row.recruiterProfileError = e.message;
            }
        }
    } catch (e) {
        row.detailError = e.message;
    }
    results.push(row);
    log(`  SD=${row.hasStructuredData} recruiterIdHit=${row.hasRecruiterIdRegex} parsed=${row.recruiterProfileParsed ? Object.values(row.recruiterProfileParsed).filter(Boolean).length : '(no recruiterId)'}`);
}

await browser.close().catch(() => {});

const totals = {
    sample: results.length,
    sdPresent: results.filter(r => r.hasStructuredData).length,
    recruiterIdFound: results.filter(r => r.hasRecruiterIdRegex).length,
    recruiterProfileParsedAll4: results.filter(r => r.recruiterProfileParsed && Object.values(r.recruiterProfileParsed).filter(Boolean).length === 4).length,
    recruiterProfileParsedAny: results.filter(r => r.recruiterProfileParsed && Object.values(r.recruiterProfileParsed).filter(Boolean).length > 0).length,
};

console.log('\n=== Recruiter probe summary ===');
console.log(JSON.stringify({ totals, perJob: results }, null, 2));
fs.writeFileSync('/tmp/dice-recruiter-probe.json', JSON.stringify({ totals, perJob: results }, null, 2));
