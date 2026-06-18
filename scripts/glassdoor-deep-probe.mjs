// Deep investigation of glassdoor.com — NOT part of the runtime scraper. Run by hand.
//
// Probes:
//   1. Anonymous search page (CloakBrowser, homepage warmup like the scraper) — reachability + selector enumeration
//   2. Structured data — JSON-LD, __NEXT_DATA__, Apollo state
//   3. No-results signal — garbage query
//   4. "Load more" button presence (the scraper's loadAllJobs loop depends on it)
//   5. Card + detail-page HTML snapshots → /tmp fixtures
//   6. Reliability hammer — 5 sequential search hits
//
// Outputs /tmp/glassdoor-deep-probe.json + /tmp/glassdoor-*.html

import fs from 'node:fs';
import { launch } from 'cloakbrowser';

const ROLE = process.env.PROBE_ROLE || 'software engineer';
const LOC  = process.env.PROBE_LOC  || 'United States';
const DOMAIN = 'glassdoor.com';

const SEARCH_URL = (kw, loc) =>
    `https://www.${DOMAIN}/Job/jobs.htm?sc.keyword=${encodeURIComponent(kw)}&locT=N&locId=&jobType=&context=Jobs&sc.location=${encodeURIComponent(loc)}&fromAge=7`;

const findings = { timestamp: new Date().toISOString(), role: ROLE, location: LOC, phases: {} };
const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CARD_SELECTORS = [
    '.jobCard',
    '[data-test="jobListing"]',
    'li[data-test="jobListing"]',
    '[class*="JobsList_jobListItem"]',
    '[data-jobid]',
    'a[data-test="job-title"]',
    'a[data-test="job-link"]',
    '[class*="JobCard_jobCardContainer"]',
    'li[data-brandviews]',
];

async function snapshotSelectors(page) {
    return page.evaluate((sels) => {
        const out = {};
        for (const s of sels) { try { out[s] = document.querySelectorAll(s).length; } catch { out[s] = 'err'; } }
        return out;
    }, CARD_SELECTORS);
}

async function pageMeta(page) {
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
    return {
        url: page.url(),
        title: await page.title().catch(() => ''),
        bytes: (await page.content()).length,
        blocked: /cloudflare|verify you are human|just a moment|ray id|help us protect|security check/i.test(bodyText),
        bodySnippet: bodyText.slice(0, 300).replace(/\s+/g, ' '),
    };
}

const browser = await launch({ headless: true });
const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
});
const page = await context.newPage();

// ─── Phase 1: homepage warmup + search (mirrors scraper flow) ───────
log('Phase 1: homepage warmup + anonymous search...');
try {
    await page.goto(`https://www.${DOMAIN}/index.htm`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const homeMeta = await pageMeta(page);
    log(`  homepage: ${homeMeta.title.slice(0, 60)} blocked:${homeMeta.blocked}`);

    await page.goto(SEARCH_URL(ROLE, LOC), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(8000);
    const meta = await pageMeta(page);
    const selectors = await snapshotSelectors(page);
    const html = await page.content();
    fs.writeFileSync('/tmp/glassdoor-search.html', html);
    findings.phases.p1_search = { ...meta, selectors };
    log(`  search: bytes=${meta.bytes} blocked=${meta.blocked} url=${meta.url.slice(0, 90)}`);
    log('  selectors:', selectors);
} catch (e) {
    findings.phases.p1_search = { error: e.message };
    log('  ERR', e.message);
}

// ─── Phase 2: structured data ───────────────────────────────────────
log('Phase 2: structured data...');
try {
    const embeds = await page.evaluate(() => {
        const out = { jsonLd: [], hasNextData: false, hasApollo: false, scriptCount: 0 };
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try { const j = JSON.parse(s.textContent); out.jsonLd.push({ type: j?.['@type'] || (Array.isArray(j) ? 'array' : '?'), bytes: s.textContent.length }); }
            catch { out.jsonLd.push({ type: 'unparseable' }); }
        }
        out.hasNextData = !!document.querySelector('script#__NEXT_DATA__');
        out.hasApollo = !!(window.__APOLLO_STATE__ || window.appCache);
        out.scriptCount = document.querySelectorAll('script').length;
        // NEXT_DATA size + whether it embeds job listings
        const nd = document.querySelector('script#__NEXT_DATA__');
        if (nd) {
            out.nextDataBytes = nd.textContent.length;
            out.nextDataHasJobListings = /jobListing|jobTitleText|jobview/i.test(nd.textContent.slice(0, 500000));
        }
        return out;
    });
    findings.phases.p2_embeds = embeds;
    log('  embeds:', embeds);
} catch (e) {
    findings.phases.p2_embeds = { error: e.message };
}

// ─── Phase 3: card snapshot + first job link ────────────────────────
log('Phase 3: card snapshot...');
try {
    const cardSnap = await page.evaluate(() => {
        const sels = ['.jobCard', '[data-test="jobListing"]', 'li[data-test="jobListing"]', '[class*="JobsList_jobListItem"]'];
        for (const s of sels) {
            const el = document.querySelector(s);
            if (el) return { matchedSelector: s, tagName: el.tagName, bytes: el.outerHTML.length, snippet: el.outerHTML.slice(0, 4000) };
        }
        return null;
    });
    if (cardSnap) {
        fs.writeFileSync('/tmp/glassdoor-card.html', cardSnap.snippet);
        findings.phases.p3_card = { matchedSelector: cardSnap.matchedSelector, tagName: cardSnap.tagName, bytes: cardSnap.bytes };
        log('  card:', findings.phases.p3_card);
    } else {
        findings.phases.p3_card = null;
        log('  no card matched any selector');
    }

    const firstJobLink = await page.evaluate(() => {
        const a = document.querySelector('a[data-test="job-title"], a[data-test="job-link"], .jobCard a[href*="/job-listing/"], a[href*="/job-listing/"], a[href*="/partner/jobListing"]');
        return a ? a.href : null;
    });
    findings.phases.p3_firstJobLink = firstJobLink;
    log('  first job link:', firstJobLink ? firstJobLink.slice(0, 110) : 'none');
} catch (e) {
    findings.phases.p3_card = { error: e.message };
}

// ─── Phase 4: load-more button (loadAllJobs dependency) ─────────────
log('Phase 4: load-more / pagination affordance...');
try {
    const loadMore = await page.evaluate(() => {
        const tests = {
            dataTestLoadMore: !!document.querySelector('[data-test="load-more"]'),
            showMoreJobsText: [...document.querySelectorAll('button')].some((b) => /show more|load more|see more jobs/i.test(b.innerText || '')),
            buttonCount: document.querySelectorAll('button').length,
            nextPageLink: !!document.querySelector('[data-test="pagination-next"], a[aria-label*="Next"]'),
        };
        return tests;
    });
    findings.phases.p4_loadMore = loadMore;
    log('  load-more:', loadMore);
} catch (e) {
    findings.phases.p4_loadMore = { error: e.message };
}

// ─── Phase 5: detail page snapshot ──────────────────────────────────
log('Phase 5: detail page...');
try {
    const link = findings.phases.p3_firstJobLink;
    if (link) {
        const dpage = await context.newPage();
        await dpage.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(6000);
        const dmeta = await pageMeta(dpage);
        const dhtml = await dpage.content();
        fs.writeFileSync('/tmp/glassdoor-detail.html', dhtml);
        const detailSelectors = await dpage.evaluate(() => ({
            jobDescriptionContent: !!document.querySelector('.jobDescriptionContent, [class*="JobDetails_jobDescription"]'),
            jsonLdJobPosting: [...document.querySelectorAll('script[type="application/ld+json"]')].some((s) => /JobPosting/.test(s.textContent || '')),
            salaryEstimate: !!document.querySelector('[class*="SalaryEstimate"], [data-test="detailSalary"]'),
        }));
        findings.phases.p5_detail = { ...dmeta, detailSelectors };
        log(`  detail: bytes=${dmeta.bytes} blocked=${dmeta.blocked}`, detailSelectors);
        await dpage.close();
    } else {
        findings.phases.p5_detail = { skipped: 'no job link found' };
    }
} catch (e) {
    findings.phases.p5_detail = { error: e.message };
    log('  ERR', e.message);
}

// ─── Phase 6: no-results signal ─────────────────────────────────────
log('Phase 6: no-results signal...');
try {
    await page.goto(SEARCH_URL('xyzqqqzzz12345unobtanium', LOC), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    const meta = await pageMeta(page);
    const selectors = await snapshotSelectors(page);
    const noResHtml = await page.content();
    fs.writeFileSync('/tmp/glassdoor-no-results.html', noResHtml);
    const noResSignals = await page.evaluate(() => ({
        noResultsText: /no.{0,20}(results|jobs)|couldn.t find|0 jobs/i.test(document.body?.innerText || ''),
        bodySnippet: (document.body?.innerText || '').slice(0, 400).replace(/\s+/g, ' '),
    }));
    findings.phases.p6_noResults = { ...meta, selectors, ...noResSignals };
    log('  no-results:', { blocked: meta.blocked, cardCounts: selectors['.jobCard'], noResultsText: noResSignals.noResultsText });
} catch (e) {
    findings.phases.p6_noResults = { error: e.message };
}

// ─── Phase 7: reliability hammer ────────────────────────────────────
log('Phase 7: 5x reliability hammer...');
const hammer = [];
for (let i = 0; i < 5; i++) {
    const t = Date.now();
    try {
        await page.goto(SEARCH_URL(ROLE, LOC), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);
        const ms = Date.now() - t;
        const meta = await pageMeta(page);
        const sels = await snapshotSelectors(page);
        const bestCount = Math.max(...Object.values(sels).filter((v) => typeof v === 'number'));
        hammer.push({ i, ms, bytes: meta.bytes, blocked: meta.blocked, bestCardCount: bestCount });
        log(`  run ${i + 1}: ${ms}ms cards=${bestCount}${meta.blocked ? ' BLOCKED' : ''}`);
    } catch (e) {
        hammer.push({ i, error: e.message });
        log(`  run ${i + 1}: ERR ${e.message}`);
    }
    await sleep(2000);
}
findings.phases.p7_hammer = hammer;
const okCount = hammer.filter((h) => !h.error && !h.blocked && (h.bestCardCount ?? 0) > 0).length;
log(`  reliability: ${okCount}/5 ok`);

fs.writeFileSync('/tmp/glassdoor-deep-probe.json', JSON.stringify(findings, null, 2));
log('Wrote /tmp/glassdoor-deep-probe.json');
await browser.close().catch(() => {});
process.exit(0);
