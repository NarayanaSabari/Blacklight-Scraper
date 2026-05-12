// Smoke-test the new CloakBrowser-based scrapers end-to-end.
// Calls scrapeMonster / scrapeGlassdoor / scrapeIndeed directly with
// one role each and prints the count + first 3 results.

import { scrapeMonster } from '../scrapers/monster.js';
import { scrapeGlassdoor } from '../scrapers/glassdoor.js';
import { scrapeIndeed } from '../scrapers/indeed.js';

const TESTS = [
    { name: 'monster', fn: scrapeMonster, role: 'Senior Java Developer' },
    { name: 'glassdoor', fn: scrapeGlassdoor, role: 'Senior Java Developer' },
    { name: 'indeed', fn: scrapeIndeed, role: 'Senior Java Developer' },
];

(async () => {
    for (const t of TESTS) {
        console.log(`\n=== ${t.name} (role: "${t.role}") ===`);
        const t0 = Date.now();
        try {
            const jobs = await t.fn(t.role, 'United States');
            const sec = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`OK in ${sec}s — ${jobs.length} jobs`);
            jobs.slice(0, 3).forEach((j, i) => {
                const title = j.title || j.job?.title || '<no title>';
                const company = j.company || j.job?.company || j.hiringOrganization || '?';
                const url = j.url || j.job?.url || '';
                console.log(`  [${i + 1}] ${title}  @ ${company}`);
                console.log(`        ${url.slice(0, 100)}`);
            });
        } catch (e) {
            const sec = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`FAILED in ${sec}s — ${e.message?.slice(0, 200)}`);
        }
    }
})().catch((e) => { console.error(e); process.exit(1); });
