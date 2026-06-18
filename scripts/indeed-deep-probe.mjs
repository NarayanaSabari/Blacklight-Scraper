// Deep investigation of indeed.com — NOT part of the runtime scraper. Run by hand.
//
// Probes:
//   1. Anonymous search page — Cloudflare reachability + card selector enumeration
//   2. Pagination — anonymous cap (the current scraper claims page 1 only); try start=10/50
//   3. No-results signal — search for a guaranteed-empty query, verify indeedNoResults() still matches
//   4. Structured data — JSON-LD, __NEXT_DATA__, RSC payloads
//   5. Job-detail page (if accessible) — what's the per-job HTML shape today
//   6. Reliability hammer — 5 sequential search-page hits, count Cloudflare interrupts
//   7. Block-page signature — what Cloudflare's "Additional Verification" page looks like (if we ever see it)
//
// Outputs to /tmp/indeed-deep-probe.json + saves HTML snapshots to /tmp/indeed-*.html

import fs from 'node:fs';
import { launch } from 'cloakbrowser';

const ROLE = process.env.PROBE_ROLE || 'software engineer';
const LOC  = process.env.PROBE_LOC  || 'United States';
const ROLE_ENC = encodeURIComponent(ROLE);
const LOC_ENC  = encodeURIComponent(LOC);
const DOMAIN   = 'www.indeed.com';

const SEARCH_URL = (start = 0) =>
    `https://${DOMAIN}/jobs?q=${ROLE_ENC}&l=${LOC_ENC}&fromage=7&sort=date${start ? `&start=${start}` : ''}`;
const NO_RESULTS_URL = `https://${DOMAIN}/jobs?q=${encodeURIComponent('xyzqqqzzz12345unobtanium')}&l=${LOC_ENC}`;

const findings = {
    timestamp: new Date().toISOString(),
    role: ROLE,
    location: LOC,
    phases: {},
};

const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ headless: true, humanize: true });
const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
});

const page = await context.newPage();

// ─── Phase 1: anonymous search page ─────────────────────────────────
log('Phase 1: anonymous search page (Cloudflare reachability)...');
const t0 = Date.now();
let resp;
try {
    resp = await page.goto(SEARCH_URL(0), { waitUntil: 'load', timeout: 45000 });
    await sleep(10000); // matches scraper's 10s Cloudflare grace
} catch (e) {
    findings.phases.p1_search = { error: e.message };
    log('  ERR', e.message);
}
const tMs = Date.now() - t0;
const html = await page.content();
fs.writeFileSync('/tmp/indeed-search.html', html);
const status = resp?.status() ?? null;
const finalUrl = page.url();
const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '');
const cloudflare = /verify you are human|just a moment|cloudflare|ray id|additional verification required/i.test(bodyText);
log(`  status ${status} ${tMs}ms bytes ${html.length} cloudflare:${cloudflare} finalUrl:${finalUrl.slice(0, 100)}`);

const cardCounts = await page.evaluate(() => {
    const sels = [
        '.job_seen_beacon',
        '.jobsearch-ResultsList > li',
        '[data-testid="job-card"]',
        '.resultContent',
        'li[data-jk]',
        'div[data-jk]',
        // Speculative additions:
        'a[data-jk]',
        '[data-empn]',
        'div[id^="job_"]',
        'article[id^="job"]',
        'mosaic-provider-jobcards li',
    ];
    const out = {};
    for (const s of sels) try { out[s] = document.querySelectorAll(s).length; } catch { out[s] = 'err'; }
    return out;
});
findings.phases.p1_search = {
    status, finalUrl, tMs, bytes: html.length, cloudflareBlock: cloudflare,
    title: await page.title().catch(() => ''),
    bodySnippet: bodyText.slice(0, 300).replace(/\s+/g, ' '),
    cardSelectors: cardCounts,
};
log('  card selectors:', cardCounts);

// ─── Phase 2: pagination ────────────────────────────────────────────
log('Phase 2: pagination (anonymous cap claim — current scraper says page 1 only)...');
const paginationCounts = {};
for (const start of [10, 20, 50]) {
    await page.goto(SEARCH_URL(start), { waitUntil: 'load', timeout: 45000 });
    await sleep(6000);
    paginationCounts[`start=${start}`] = await page.evaluate(() => ({
        cards_dataJk: document.querySelectorAll('[data-jk]').length,
        cards_seenBeacon: document.querySelectorAll('.job_seen_beacon').length,
        url: window.location.href,
        bouncedToLogin: /signin|login|secure\.indeed/i.test(window.location.href),
        bodyHasSignIn: /Sign in to Indeed/i.test(document.body?.innerText || ''),
    }));
}
findings.phases.p2_pagination = paginationCounts;
log('  pagination:', paginationCounts);

// ─── Phase 3: no-results signal ─────────────────────────────────────
log('Phase 3: no-results signal (verify indeedNoResults matches today)...');
await page.goto(NO_RESULTS_URL, { waitUntil: 'load', timeout: 45000 });
await sleep(8000);
const noResultsHtml = await page.content();
fs.writeFileSync('/tmp/indeed-no-results.html', noResultsHtml);
const noResultsSig = {
    hasJobsearchNoResult: noResultsHtml.includes('jobsearch-NoResult'),
    hasDidNotMatch: /did not match any jobs/i.test(noResultsHtml),
    cardCount: await page.evaluate(() => document.querySelectorAll('[data-jk]').length),
    bodySnippet: (await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '')).slice(0, 400),
};
findings.phases.p3_no_results = noResultsSig;
log('  no-results signals:', noResultsSig);

// ─── Phase 4: structured data / __NEXT_DATA__ / JSON-LD ─────────────
log('Phase 4: structured-data embeds...');
await page.goto(SEARCH_URL(0), { waitUntil: 'load', timeout: 45000 });
await sleep(8000);
const embeds = await page.evaluate(() => {
    const out = { jsonLd: [], hasNextData: false, mosaicData: null, scriptCount: 0 };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { out.jsonLd.push({ type: JSON.parse(s.textContent)?.['@type'] || '?', bytes: s.textContent.length }); }
        catch { /* */ }
    }
    out.hasNextData = !!document.querySelector('script#__NEXT_DATA__');
    if (window.mosaic?.providerData?.['mosaic-provider-jobcards']) {
        out.mosaicData = Object.keys(window.mosaic.providerData['mosaic-provider-jobcards']);
    }
    out.scriptCount = document.querySelectorAll('script').length;
    return out;
});
findings.phases.p4_embeds = embeds;
log('  embeds:', embeds);

// ─── Phase 5: sample job-card HTML snapshot ─────────────────────────
log('Phase 5: card HTML snapshot...');
const cardSnap = await page.evaluate(() => {
    const card = document.querySelector('.job_seen_beacon, [data-jk]');
    if (!card) return null;
    return { tagName: card.tagName, dataJk: card.getAttribute('data-jk'), outerHTMLLen: card.outerHTML.length, snippet: card.outerHTML.slice(0, 2500) };
});
findings.phases.p5_card_sample = cardSnap;
if (cardSnap) fs.writeFileSync('/tmp/indeed-card.html', cardSnap.snippet);
log('  card sample:', cardSnap ? { tagName: cardSnap.tagName, dataJk: cardSnap.dataJk, bytes: cardSnap.outerHTMLLen } : 'none');

// ─── Phase 6: reliability hammer ────────────────────────────────────
log('Phase 6: 5x reliability hammer...');
const hammer = [];
for (let i = 0; i < 5; i++) {
    const t = Date.now();
    try {
        const r = await page.goto(SEARCH_URL(0), { waitUntil: 'load', timeout: 45000 });
        await sleep(4000);
        const ms = Date.now() - t;
        const body = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
        const blocked = /just a moment|cloudflare|ray id|additional verification|access denied/i.test(body);
        const cardCount = await page.evaluate(() => document.querySelectorAll('[data-jk]').length);
        hammer.push({ i, status: r?.status() ?? null, ms, cardCount, blocked });
        log(`  run ${i + 1}: ${r?.status()} ${ms}ms cards=${cardCount}${blocked ? ' BLOCKED' : ''}`);
    } catch (e) {
        hammer.push({ i, error: e.message });
        log(`  run ${i + 1}: ERR ${e.message}`);
    }
    await sleep(2000);
}
findings.phases.p6_hammer = hammer;
const okCount = hammer.filter(h => h.status === 200 && !h.blocked && (h.cardCount ?? 0) > 0).length;
log(`  reliability: ${okCount}/5 ok`);

fs.writeFileSync('/tmp/indeed-deep-probe.json', JSON.stringify(findings, null, 2));
log('Wrote /tmp/indeed-deep-probe.json');

await browser.close().catch(() => {});
process.exit(0);
