// Deep investigation of techfetch.com — NOT part of the runtime scraper. Run by hand.
//
// SECURITY: this probe acquires a real credential lease from the API. It NEVER
// prints the email or password — only the credential ID and boolean outcomes.
//
// Probes:
//   1. Anonymous access — is the search page usable without login?
//   2. Login flow — js_login.aspx form fields still present? JSLogin cookie set?
//   3. Search + job-list DOM — [id*="_divJob"] row count, card snapshot
//   4. LoadJobs AJAX pagination — does the page-2 swap still work?
//   5. Detail page snapshot
//   6. No-results signal — garbage keyword
//
// Outputs /tmp/techfetch-deep-probe.json + /tmp/techfetch-*.html

import fs from 'node:fs';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getCredentialsAPIClient } from '../src/api/credentials.js';

chromium.use(StealthPlugin());

const findings = { timestamp: new Date().toISOString(), phases: {} };
const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
});
const page = await context.newPage();

// ─── Phase 1: anonymous access ──────────────────────────────────────
log('Phase 1: anonymous access to search + job list...');
try {
    await page.goto('https://www.techfetch.com/js/js_s_jobs.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    const anon = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        hasKeywordField: !!document.querySelector('#txtKeyword'),
        hasLoginForm: !!document.querySelector('input[name="txtemailid"], #txtemailid'),
        redirectedToLogin: /login/i.test(window.location.href),
        bodySnippet: (document.body?.innerText || '').slice(0, 250).replace(/\s+/g, ' '),
    }));
    findings.phases.p1_anonymous = anon;
    log('  anonymous search page:', anon);

    // Can we also reach the job list anonymously?
    await page.goto('https://www.techfetch.com/js/js_job_list.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    const anonList = await page.evaluate(() => ({
        url: window.location.href,
        jobRows: document.querySelectorAll('[id*="_divJob"]').length,
        redirectedToLogin: /login/i.test(window.location.href),
    }));
    findings.phases.p1_anonymousJobList = anonList;
    log('  anonymous job list:', anonList);
} catch (e) {
    findings.phases.p1_anonymous = { error: e.message };
    log('  ERR', e.message);
}

// ─── Phase 2: credential + login ────────────────────────────────────
log('Phase 2: acquiring credential lease (output masked)...');
let lease = null;
try {
    lease = await getCredentialsAPIClient().acquire('techfetch', null);
} catch (e) {
    findings.phases.p2_login = { error: `credential acquire threw: ${e.message}` };
    log('  credential acquire threw:', e.message);
}

if (!lease) {
    findings.phases.p2_login = findings.phases.p2_login || { skipped: 'no credential available from API' };
    log('  no credential available — skipping authenticated phases');
} else {
    const credential = lease.credential;
    log(`  lease acquired: credential id=${credential.id ?? 'unknown'} (email/password masked)`);
    try {
        await page.goto('https://www.techfetch.com/js/js_login.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
        const formShape = await page.evaluate(() => ({
            hasEmailField: !!document.querySelector('input[name="txtemailid"], #txtemailid'),
            hasPwdField: !!document.querySelector('input[name="txtpwd"], #txtpwd'),
            submitCount: document.querySelectorAll('input[type="submit"], button[type="submit"]').length,
        }));
        log('  login form shape:', formShape);

        await page.fill('input[name="txtemailid"], #txtemailid', credential.email);
        await page.fill('input[name="txtpwd"], #txtpwd', credential.password);
        await page.click('input[type="submit"], button[type="submit"]');
        await sleep(6000);

        const cookies = await context.cookies();
        const hasJSLogin = cookies.some((c) => c.name === 'JSLogin');
        const postLoginUrl = page.url();
        findings.phases.p2_login = {
            formShape,
            hasJSLoginCookie: hasJSLogin,
            postLoginUrl: postLoginUrl.replace(/[?#].*$/, ''),  // strip query (may embed identifiers)
        };
        log(`  login: JSLogin cookie=${hasJSLogin} url=${findings.phases.p2_login.postLoginUrl}`);

        if (!hasJSLogin) {
            await lease.reportFailure('probe: login did not set JSLogin cookie', 0);
            log('  reported failure on lease (no cooldown)');
        }
    } catch (e) {
        findings.phases.p2_login = { error: e.message };
        log('  login ERR', e.message);
        try { await lease.reportFailure(`probe: login threw: ${e.message}`, 0); } catch { /* */ }
        lease = null;
    }
}

// ─── Phase 3: search + job list DOM (authenticated) ─────────────────
if (lease && findings.phases.p2_login?.hasJSLoginCookie) {
    log('Phase 3: search + job-list DOM...');
    try {
        // Mirror scraper: land on js_s_jobs.aspx, fill #txtKeyword, submit
        await page.goto('https://www.techfetch.com/js/js_s_jobs.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
        await page.waitForSelector('#txtKeyword', { timeout: 8000 });
        await page.fill('#txtKeyword', 'software engineer');
        await page.click('input[type="submit"], button[type="submit"], #btnSearch');
        await sleep(5000);

        try { await page.waitForSelector('[id*="_divJob"]', { timeout: 15000 }); } catch { /* 0 rows */ }
        const listShape = await page.evaluate(() => {
            const rows = document.querySelectorAll('[id*="_divJob"]');
            const first = rows[0];
            const titleA = document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a');
            return {
                url: window.location.href.replace(/[?#].*$/, ''),
                jobRows: rows.length,
                firstRowBytes: first ? first.outerHTML.length : 0,
                firstTitleHref: titleA ? titleA.href.slice(0, 120) : null,
                hasLoadJobsFn: typeof window.LoadJobs === 'function',
            };
        });
        findings.phases.p3_search = listShape;
        log('  job list:', listShape);

        const firstCardHtml = await page.evaluate(() => {
            const el = document.querySelector('[id*="_divJob"]');
            return el ? el.outerHTML.slice(0, 6000) : null;
        });
        if (firstCardHtml) fs.writeFileSync('/tmp/techfetch-card.html', firstCardHtml);
        const listHtml = await page.content();
        fs.writeFileSync('/tmp/techfetch-list.html', listHtml);

        // ─── Phase 4: LoadJobs pagination ───────────────────────────
        log('Phase 4: LoadJobs page-2 swap...');
        const prevHref = await page.evaluate(() => {
            const a = document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a');
            return a ? a.href : null;
        });
        await page.evaluate(() => {
            if (typeof window.LoadJobs === 'function') window.LoadJobs('/js/ajs_job_list.aspx?From=2');
        });
        let swapped = false;
        try {
            await page.waitForFunction((prev) => {
                const a = document.querySelector('[id*="_divJob"] [id*="_lblTitle"] a');
                return a && a.href !== prev;
            }, prevHref, { timeout: 12000 });
            swapped = true;
        } catch { /* didn't swap */ }
        const page2Shape = await page.evaluate(() => ({
            jobRows: document.querySelectorAll('[id*="_divJob"]').length,
        }));
        findings.phases.p4_pagination = { swapped, ...page2Shape };
        log(`  page-2 swap: ${swapped}, rows=${page2Shape.jobRows}`);

        // ─── Phase 5: detail page ───────────────────────────────────
        log('Phase 5: detail page...');
        const detailLink = findings.phases.p3_search.firstTitleHref;
        if (detailLink) {
            const dpage = await context.newPage();
            await dpage.goto(detailLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(3000);
            const dShape = await dpage.evaluate(() => ({
                url: window.location.href.replace(/[?#].*$/, ''),
                title: document.title,
                bytes: document.documentElement.outerHTML.length,
                hasDescription: !!document.querySelector('[id*="divDesc"], [id*="lblDesc"], [class*="job-desc"], [id*="JobDesc"]'),
            }));
            const dHtml = await dpage.content();
            fs.writeFileSync('/tmp/techfetch-detail.html', dHtml);
            findings.phases.p5_detail = dShape;
            log('  detail:', dShape);
            await dpage.close();
        } else {
            findings.phases.p5_detail = { skipped: 'no detail link' };
        }

        // ─── Phase 6: no-results ────────────────────────────────────
        log('Phase 6: no-results signal...');
        await page.goto('https://www.techfetch.com/js/js_s_jobs.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
        await page.waitForSelector('#txtKeyword', { timeout: 8000 });
        await page.fill('#txtKeyword', 'xyzqqqzzz12345unobtanium');
        await page.click('input[type="submit"], button[type="submit"], #btnSearch');
        await sleep(6000);
        const noRes = await page.evaluate(() => ({
            jobRows: document.querySelectorAll('[id*="_divJob"]').length,
            noResultsText: /no (more )?jobs|no results|0 jobs|not found/i.test(document.body?.innerText || ''),
            bodySnippet: (document.body?.innerText || '').slice(0, 300).replace(/\s+/g, ' '),
        }));
        const noResHtml = await page.content();
        fs.writeFileSync('/tmp/techfetch-no-results.html', noResHtml);
        findings.phases.p6_noResults = noRes;
        log('  no-results:', noRes);

        await lease.reportSuccess('probe: all phases complete');
        log('  lease released via reportSuccess');
    } catch (e) {
        findings.phases.p3_search = findings.phases.p3_search || { error: e.message };
        log('  authenticated phase ERR', e.message);
        try { await lease.reportSuccess('probe: partial (search phase threw)'); } catch { /* */ }
    }
}

fs.writeFileSync('/tmp/techfetch-deep-probe.json', JSON.stringify(findings, null, 2));
log('Wrote /tmp/techfetch-deep-probe.json');
await browser.close().catch(() => {});
process.exit(0);
