#!/usr/bin/env node
// Test harness — runs scrapeDice live for one role and analyzes the
// URL quality + per-job field completeness. Mirrors test-monster-scrape.js.
//   npm run dice:test-scrape -- "software engineer"        (role)
//   DICE_TEST_LOC="United States" npm run dice:test-scrape
import { scrapeDice } from '../scrapers/dice.js';
import { classifyUrl } from '../src/core/url-quality.js';

const role = process.argv.slice(2).join(' ').trim() || 'software engineer';
const loc  = process.env.DICE_TEST_LOC || 'United States';

console.log(`Role     : ${role}`);
console.log(`Location : ${loc}\n`);

async function main() {
    const t0 = Date.now();
    let result;
    try {
        result = await scrapeDice(role, loc, null);
    } catch (e) {
        console.log(`\n❌ Scrape threw ${e.name}: ${e.message}`);
        process.exit(2);
    }
    const elapsed = Date.now() - t0;
    const jobs = Array.isArray(result) ? result : result.jobs;
    const emptyConfirmed = Array.isArray(result) ? false : !!result.emptyConfirmed;
    const partial = Array.isArray(result) ? false : !!result.partial;

    console.log(`\n=== Scraped ${jobs.length} job(s) in ${elapsed}ms ===`);
    console.log(`emptyConfirmed=${emptyConfirmed} partial=${partial}\n`);

    const counts = { permalink: 0, profile_in: 0, empty: 0, other: 0 };
    const badTitle = []; const badCompany = [];
    jobs.forEach((j, i) => {
        const url = j.job?.url ?? 'N/A';
        const q = classifyUrl(url === 'N/A' ? '' : url);
        counts[q]++;
        const titleVal = j.job?.title ?? '';
        const companyVal = j.company?.name ?? '';
        if (!titleVal || titleVal === 'N/A' || titleVal.length <= 1) badTitle.push(i);
        if (!companyVal || companyVal === 'N/A') badCompany.push(i);
        if (i < 5) {
            console.log(`#${i + 1} [${q}]`);
            console.log(`   title    : ${titleVal || '(missing)'}`);
            console.log(`   company  : ${companyVal || '(missing)'}`);
            console.log(`   location : ${j.location?.formatted ?? j.location}`);
            console.log(`   url      : ${url}`);
            console.log('');
        }
    });

    console.log('=== URL quality summary ===');
    console.log(`   PERMALINK : ${counts.permalink}/${jobs.length}`);
    console.log(`   OTHER     : ${counts.other}/${jobs.length}`);
    console.log(`   EMPTY     : ${counts.empty}/${jobs.length}`);
    console.log(`   PROFILE_IN: ${counts.profile_in}/${jobs.length} (must be 0)`);
    console.log(`   bad title : ${badTitle.length} (must be 0)`);
    console.log(`   bad company: ${badCompany.length} (must be 0)`);

    if (jobs.length > 0 && counts.permalink / jobs.length < 0.5) {
        console.log('\n⚠ PERMALINK rate < 50% — extractor likely broken.');
        process.exit(3);
    }
    process.exit(0);
}
main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
