#!/usr/bin/env node
// Test harness — runs scrapeTechFetch live for one keyword and analyzes
// per-job field completeness. Mirrors the other harnesses. Anonymous-first:
// no credential needed for the happy path.
//   npm run techfetch:test-scrape -- "java developer"
//   TECHFETCH_TEST_LOC="Texas" npm run techfetch:test-scrape -- "java developer"
import { scrapeTechFetch } from '../scrapers/techfetch.js';

const role = process.argv.slice(2).join(' ').trim() || 'java developer';
const loc  = process.env.TECHFETCH_TEST_LOC || '';
console.log(`Keyword  : ${role}`);
console.log(`Location : ${loc || '(any — TechFetch is keyword-driven)'}\n`);

async function main() {
    const t0 = Date.now();
    let result;
    try {
        result = await scrapeTechFetch(role, loc, null);
    } catch (e) {
        console.log(`\n❌ Scrape threw ${e.name}${e.kind ? `(${e.kind})` : ''}: ${e.message}`);
        if (e?.name === 'AuthError') {
            console.log('(TechFetch needed login but no credential is available in the API)');
            process.exit(4);
        }
        if (e?.name === 'BlockedError' && e?.kind === 'blocked-cooldown') {
            console.log('(in active TechFetch cooldown — the IP was served a stub/block page)');
            process.exit(4);
        }
        process.exit(2);
    }
    const elapsed = Date.now() - t0;
    const jobs = Array.isArray(result) ? result : result.jobs;
    const emptyConfirmed = Array.isArray(result) ? false : !!result.emptyConfirmed;
    const partial = Array.isArray(result) ? false : !!result.partial;
    console.log(`\n=== Scraped ${jobs.length} job(s) in ${elapsed}ms ===`);
    console.log(`emptyConfirmed=${emptyConfirmed} partial=${partial}\n`);

    let badTitle = 0, badCompany = 0, badUrl = 0;
    jobs.forEach((j, i) => {
        const title = j.job?.title ?? '';
        const company = j.company?.name ?? '';
        const url = j.job?.url ?? '';
        if (!title || title === 'N/A' || title.length <= 1) badTitle++;
        if (!company || company === 'N/A') badCompany++;
        if (!url || url === 'N/A' || !url.includes('techfetch.com/job-description/')) badUrl++;
        if (i < 5) console.log(`#${i + 1} ${title} @ ${company}\n   ${url}\n`);
    });
    console.log('=== quality ===');
    console.log(`   bad title  : ${badTitle} (must be 0)`);
    console.log(`   bad company: ${badCompany} (must be 0)`);
    console.log(`   bad url    : ${badUrl} (must be 0)`);
    if (jobs.length > 0 && (badTitle > 0 || badCompany > 0 || badUrl / jobs.length > 0.1)) {
        console.log('\n⚠ Bad rows detected — extractor likely broken.');
        process.exit(3);
    }
    process.exit(0);
}
main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
