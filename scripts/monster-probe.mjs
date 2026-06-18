// Investigation harness — NOT part of the repo. Runs the existing
// scrapeMonster + a low-level page probe.
import { scrapeMonster } from '../scrapers/monster.js';
import { launch } from 'cloakbrowser';

const ROLE = process.env.PROBE_ROLE || 'software engineer';
const LOC  = process.env.PROBE_LOC  || 'United States';

async function lowLevelProbe() {
    console.log('=== Phase 1: low-level page probe ===');
    const browser = await launch({ headless: true, humanize: true });
    const probe = async (url) => {
        const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US' })).newPage();
        const t0 = Date.now();
        try {
            const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const status = r?.status() ?? '?';
            const ms = Date.now() - t0;
            const title = await page.title().catch(() => '');
            const bodySnippet = (await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
            console.log(`  ${status} ${ms}ms  ${url}`);
            console.log(`    title: ${title}`);
            console.log(`    body : ${bodySnippet}`);
            return { url, status, ms, title, bodySnippet };
        } catch (e) {
            console.log(`  ERR  ${url}  ${e.name}: ${e.message}`);
            return { url, status: 'ERR', err: e.message };
        } finally {
            await page.close().catch(() => {});
        }
    };
    const homepage = await probe('https://www.monster.com/');
    const p1 = await probe(`https://www.monster.com/jobs/search?q=${encodeURIComponent(ROLE)}&where=${encodeURIComponent(LOC)}&page=1`);
    const p3 = await probe(`https://www.monster.com/jobs/search?q=${encodeURIComponent(ROLE)}&where=${encodeURIComponent(LOC)}&page=3`);
    const p5 = await probe(`https://www.monster.com/jobs/search?q=${encodeURIComponent(ROLE)}&where=${encodeURIComponent(LOC)}&page=5`);
    await browser.close().catch(() => {});
    return { homepage, p1, p3, p5 };
}

async function fullScrape() {
    console.log('\n=== Phase 2: full scrapeMonster ===');
    const t0 = Date.now();
    try {
        const jobs = await scrapeMonster(ROLE, LOC, null);
        const ms = Date.now() - t0;
        console.log(`\nFinished in ${ms}ms — ${jobs.length} jobs returned.`);
        for (const j of jobs.slice(0, 3)) {
            console.log(`  - ${j.title} @ ${j.company || '(no company)'} — ${j.url}`);
        }
        return { ok: true, jobCount: jobs.length, ms };
    } catch (e) {
        const ms = Date.now() - t0;
        console.log(`\nFAILED in ${ms}ms — ${e.name}: ${e.message}`);
        return { ok: false, err: e.message, ms };
    }
}

const lowLevel = await lowLevelProbe();
const full = await fullScrape();
console.log('\n=== Summary ===');
console.log(JSON.stringify({ lowLevel, full }, null, 2));
process.exit(0);
