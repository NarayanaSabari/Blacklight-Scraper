#!/usr/bin/env node
// Is LinkedIn refusing ALL content search, or only the filtered/recent slice?
//
// WHY THIS MATTERS
// The quota back-off treats "search returns nothing" as one condition. But
// LinkedIn's content search has several axes, and they are not necessarily
// metered together:
//
//   • the date filter (past-24h is the one every sweep uses)
//   • sorting by recency vs relevance
//   • content search at all, vs people/jobs search
//
// If the unfiltered search still works while `past-24h` does not, the block is
// on the FILTER, and the remedy is to widen the window rather than to wait.
// If nothing returns, it is a blanket content-search block and only time helps.
// These lead to opposite actions, so guessing is expensive.
//
// Read-only, drives a real browser (so it measures what LinkedIn shows a human
// on this profile, not what our HTTP transport gets).
//
//     node scripts/linkedin-search-scope.js

import { launchPersistentContext } from '../src/core/browser-pool.js';
import { linkedInProfileDir, profileDirFor } from '../src/core/linkedin-profile.js';

const BASE = 'https://www.linkedin.com/search/results';

// Ordered narrowest-constraint-last, so the first thing that works tells us the
// widest slice still available to us.
const PROBES = [
    { label: 'content, no filters ', url: `${BASE}/content/?keywords=hiring` },
    { label: 'content, past-week  ', url: `${BASE}/content/?keywords=hiring&datePosted=${encodeURIComponent('["past-week"]')}` },
    { label: 'content, past-24h   ', url: `${BASE}/content/?keywords=hiring&datePosted=${encodeURIComponent('["past-24h"]')}` },
    { label: 'content, other term ', url: `${BASE}/content/?keywords=python` },
    // Different search VERTICALS. If these work while content search does not,
    // the metering is specific to content search rather than the account.
    { label: 'people search       ', url: `${BASE}/people/?keywords=recruiter` },
    { label: 'jobs search         ', url: `${BASE}/jobs/?keywords=developer` },
    { label: 'all search          ', url: `${BASE}/all/?keywords=hiring` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const profileKey = process.env.LINKEDIN_PROFILE_KEY || null;
    const userDataDir = profileKey ? profileDirFor(profileKey) : linkedInProfileDir();
    console.log('profile:', userDataDir);
    console.log('');

    const context = await launchPersistentContext({ userDataDir, headless: false, humanize: true });
    try {
        const page = context.pages()[0] || await context.newPage();
        for (const probe of PROBES) {
            try {
                await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await sleep(7000);
                const html = await page.content();
                const text = await page.evaluate(() => document.body.innerText).catch(() => '');

                // Result-ish signals that survive class-name churn.
                const activities = new Set([...html.matchAll(/urn:li:activity:(\d+)/g)].map((m) => m[1]));
                const profiles = new Set([...html.matchAll(/\/in\/([a-z0-9-]{5,})/gi)].map((m) => m[1]));
                const jobs = new Set([...html.matchAll(/urn:li:jobPosting:(\d+)/g)].map((m) => m[1]));
                const noResults = /No results found/i.test(text);

                console.log(
                    `  ${probe.label} activities=${String(activities.size).padStart(3)} `
                    + `profiles=${String(profiles.size).padStart(3)} jobs=${String(jobs.size).padStart(3)} `
                    + `${noResults ? 'NO-RESULTS' : ''}`,
                );
            } catch (err) {
                console.log(`  ${probe.label} ERROR ${err?.message?.slice(0, 60)}`);
            }
            await sleep(4000);
        }
    } finally {
        await context.close().catch(() => {});
    }

    console.log('\nRead: if the unfiltered/other verticals return results while past-24h does not,');
    console.log('the metering is on the FILTER and widening the window is the remedy.');
    console.log('If everything is empty, it is a blanket content-search block and only time helps.');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
