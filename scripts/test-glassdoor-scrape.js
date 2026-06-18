#!/usr/bin/env node
// Test harness — runs scrapeGlassdoor live for one role+location and
// analyzes per-job field completeness. Mirrors the other harnesses.
//   npm run glassdoor:test-scrape -- "software engineer"
//   GLASSDOOR_TEST_LOC="California" npm run glassdoor:test-scrape
//   GLASSDOOR_CLEAR_COOLDOWN=1 npm run glassdoor:test-scrape -- "<role>"
import fs from 'node:fs';
import { scrapeGlassdoor } from '../scrapers/glassdoor.js';
import { cooldownPath } from '../src/core/glassdoor-cooldown.js';

const role = process.argv.slice(2).join(' ').trim() || 'software engineer';
const loc  = process.env.GLASSDOOR_TEST_LOC || 'United States';
console.log(`Role     : ${role}`);
console.log(`Location : ${loc}\n`);

if (process.env.GLASSDOOR_CLEAR_COOLDOWN === '1') {
    try { fs.unlinkSync(cooldownPath()); console.log(`Cleared cooldown marker at ${cooldownPath()}`); }
    catch (e) { if (e.code !== 'ENOENT') console.log(`(cooldown clear: ${e.message})`); }
}

async function main() {
    const t0 = Date.now();
    let result;
    try {
        result = await scrapeGlassdoor(role, loc, null);
    } catch (e) {
        console.log(`\n❌ Scrape threw ${e.name}${e.kind ? `(${e.kind})` : ''}: ${e.message}`);
        if (e?.name === 'BlockedError' && e?.kind === 'cloudflare-cooldown') {
            console.log('(in active Glassdoor cooldown — pass GLASSDOOR_CLEAR_COOLDOWN=1 to override)');
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

    let badTitle = 0, badCompany = 0, badUrl = 0, usLoc = 0;
    jobs.forEach((j, i) => {
        const title = j.job?.title ?? '';
        const company = j.company?.name ?? '';
        const url = j.job?.url ?? '';
        const locStr = String(j.location?.formatted ?? j.location ?? '');
        if (!title || title === 'N/A' || title.length <= 1) badTitle++;
        if (!company || company === 'N/A') badCompany++;
        if (!url || url === 'N/A' || !/glassdoor\.(com|co\.in)/.test(url)) badUrl++;
        if (/,\s*[A-Z]{2}\b|United States|Remote/i.test(locStr)) usLoc++;
        if (i < 5) console.log(`#${i + 1} ${title} @ ${company} [${locStr}]\n   ${url}\n`);
    });
    console.log('=== quality ===');
    console.log(`   bad title  : ${badTitle} (must be 0)`);
    console.log(`   bad company: ${badCompany} (must be 0)`);
    console.log(`   bad url    : ${badUrl} (must be 0)`);
    console.log(`   US-shaped locations: ${usLoc}/${jobs.length} (geo check)`);
    if (jobs.length > 0 && (badTitle > 0 || badCompany > 0 || badUrl / jobs.length > 0.1)) {
        console.log('\n⚠ Bad rows detected — extractor likely broken.');
        process.exit(3);
    }
    process.exit(0);
}
main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
