// Investigation harness — NOT part of the runtime scraper. Captures one real
// Monster appsapi response body, derives the empty-payload variant.
// Run by hand when refreshing fixtures.
//
// Usage: node scripts/monster-appsapi-probe.mjs
//
// Writes:
//   test/fixtures/monster-appsapi-has-jobs.json  (real live response)
//   test/fixtures/monster-appsapi-empty.json     (clone with jobResults:[])

import fs from 'node:fs';
import path from 'node:path';
import { launch } from 'cloakbrowser';

const SEARCH_URL = 'https://www.monster.com/jobs/search?q=software%20engineer&where=United%20States&page=1';
const APPSAPI_RE = /\/jobs-svx-service\/v2\/monster\/search-jobs\//;
const FIXTURE_DIR = path.resolve('test/fixtures');

async function main() {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    console.log('[probe] launching CloakBrowser...');
    const browser = await launch({ headless: true, humanize: true });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    const page = await context.newPage();

    // Warmup so DataDome cookie is set
    await page.goto('https://www.monster.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    const apiBodyPromise = page.waitForResponse(
        (r) => APPSAPI_RE.test(r.url()) && r.request().method() === 'POST',
        { timeout: 20000 },
    ).then((resp) => resp.text());

    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const body = await apiBodyPromise;
    let parsed;
    try { parsed = JSON.parse(body); }
    catch (e) {
        console.error('[probe] appsapi body is not JSON; saving raw');
        fs.writeFileSync(path.join(FIXTURE_DIR, 'monster-appsapi-has-jobs.json'), body);
        await browser.close();
        process.exit(1);
    }

    fs.writeFileSync(
        path.join(FIXTURE_DIR, 'monster-appsapi-has-jobs.json'),
        JSON.stringify(parsed, null, 2) + '\n',
    );
    console.log('[probe] wrote monster-appsapi-has-jobs.json');

    // Derive the empty variant by cloning + clearing jobResults / jobs / results.
    const empty = JSON.parse(JSON.stringify(parsed));
    if (Array.isArray(empty.jobResults)) empty.jobResults = [];
    if (Array.isArray(empty.jobs)) empty.jobs = [];
    if (Array.isArray(empty.results)) empty.results = [];
    if (empty.searchResults && Array.isArray(empty.searchResults.jobs)) empty.searchResults.jobs = [];
    fs.writeFileSync(
        path.join(FIXTURE_DIR, 'monster-appsapi-empty.json'),
        JSON.stringify(empty, null, 2) + '\n',
    );
    console.log('[probe] wrote monster-appsapi-empty.json (derived empty variant)');

    await browser.close();
    process.exit(0);
}
main().catch((e) => { console.error('[probe] failed:', e); process.exit(1); });
