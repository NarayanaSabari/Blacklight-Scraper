// Deep investigation of monster.com — NOT part of the scraper, NOT committed.
// Goal: ground-truth what works TODAY for a robust extractor.
//
// Probes:
//   1. DOM — dump the outerHTML of the first 3 job cards so we can see the
//      real structure (data attrs, aria, classes). Search for the most
//      stable selectors.
//   2. Embeds — JSON-LD (schema.org JobPosting), Next.js __NEXT_DATA__,
//      Apollo state, GraphQL caches. Structured data is preferable to DOM.
//   3. Network — log every fetch/XHR URL hit during search nav. Look for
//      JSON APIs we could use directly (or at least intercept).
//   4. Pagination — try ?page=2, ?start=20, ?offset=20, and locate the
//      "Next" button. Report what advances results.
//   5. Reliability — hammer /jobs/search 10x sequentially, log status codes
//      + content-length + DataDome / Cloudflare challenge presence.
//   6. Total count — extract any "showing X of Y" / "Y jobs found" string.
//
// Writes findings to /tmp/monster-deep-probe.json + saves 2 HTML snapshots
// to /tmp/monster-search.html and /tmp/monster-card.html for offline review.

import fs from 'node:fs';
import { launch } from 'cloakbrowser';

const ROLE = 'software engineer';
const LOC  = 'United States';
const SEARCH_URL = (page = 1) =>
    `https://www.monster.com/jobs/search?q=${encodeURIComponent(ROLE)}&where=${encodeURIComponent(LOC)}&page=${page}`;

const findings = {
    timestamp: new Date('2026-06-03T00:00:00Z').toISOString(),  // can't use Date.now()
    role: ROLE,
    location: LOC,
    phases: {},
};

const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ headless: true, humanize: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York' });

// ─── Phase 5 helper: network log ─────────────────────────────────────
const netLog = [];
context.on('request', (req) => {
    const type = req.resourceType?.() ?? 'other';
    if (['xhr', 'fetch', 'document'].includes(type)) {
        netLog.push({ method: req.method?.() ?? '?', url: req.url(), type });
    }
});

// ─── Phase 1: load the search page, snapshot HTML, find cards ────────
log('Phase 1: loading search page...');
const page = await context.newPage();

// Warmup
await page.goto('https://www.monster.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(3000);

const t0 = Date.now();
const navResp = await page.goto(SEARCH_URL(1), { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(4000);
const tMs = Date.now() - t0;

const html = await page.content();
fs.writeFileSync('/tmp/monster-search.html', html);
log(`  HTML written to /tmp/monster-search.html (${html.length} bytes, status ${navResp?.status()}, ${tMs}ms)`);

findings.phases.p1_search = {
    status: navResp?.status() ?? null,
    bytes: html.length,
    timeMs: tMs,
    title: await page.title(),
};

// ─── Phase 1b: enumerate candidate card selectors and count ──────────
const cardCounts = await page.evaluate(() => {
    const selectors = [
        'a[href*="/job-openings/"]',
        'article',
        'article[data-testid*="job"]',
        '[data-testid*="JobCard"]',
        '[data-testid*="job-card"]',
        'div[role="article"]',
        '[class*="JobCard"]',
        '[class*="job-card"]',
        'li[data-testid]',
        'section[aria-label*="job"]',
        'section[aria-label*="result"]',
        'div[data-jobid]',
    ];
    const out = {};
    for (const sel of selectors) {
        try { out[sel] = document.querySelectorAll(sel).length; } catch { out[sel] = 'err'; }
    }
    return out;
});
findings.phases.p1_card_counts = cardCounts;
log('  Card-selector counts:', cardCounts);

// ─── Phase 1c: dump first 3 candidate cards' outerHTML ───────────────
const cardSnapshots = await page.evaluate(() => {
    const candidates = [
        ...document.querySelectorAll('article'),
        ...document.querySelectorAll('a[href*="/job-openings/"]'),
        ...document.querySelectorAll('[data-testid*="job"]'),
        ...document.querySelectorAll('[class*="JobCard"]'),
    ];
    const seen = new Set();
    const out = [];
    for (const el of candidates) {
        // Walk up to the outermost reasonable container
        let node = el;
        for (let i = 0; i < 4 && node.parentElement; i++) {
            const p = node.parentElement;
            if (p === document.body) break;
            const text = p.innerText || '';
            if (text.length > 1500) break;
            node = p;
        }
        const html = node.outerHTML.slice(0, 3000);
        if (seen.has(html.slice(0, 200))) continue;
        seen.add(html.slice(0, 200));
        out.push({
            tag: node.tagName,
            cls: node.className?.slice?.(0, 200) ?? '',
            id: node.id ?? '',
            innerText: (node.innerText || '').slice(0, 500),
            outerHTML: html,
            datasetKeys: Object.keys(node.dataset ?? {}),
        });
        if (out.length >= 3) break;
    }
    return out;
});
findings.phases.p1_card_snapshots = cardSnapshots;
fs.writeFileSync('/tmp/monster-card.html', cardSnapshots.map((c, i) => `<!-- CARD ${i} (${c.tag}) -->\n${c.outerHTML}\n\n`).join(''));
log(`  Wrote ${cardSnapshots.length} card snapshots to /tmp/monster-card.html`);

// ─── Phase 2: structured-data embeds ─────────────────────────────────
log('Phase 2: scanning for JSON-LD, __NEXT_DATA__, Apollo state...');
const embeds = await page.evaluate(() => {
    const out = { jsonLd: [], nextData: null, apollo: null, otherScripts: [] };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { out.jsonLd.push(JSON.parse(s.textContent || 'null')); } catch (e) { out.jsonLd.push({ parseError: e.message, snippet: (s.textContent || '').slice(0, 200) }); }
    }
    const nd = document.querySelector('script#__NEXT_DATA__');
    if (nd) {
        try { out.nextData = JSON.parse(nd.textContent || 'null'); } catch { out.nextData = (nd.textContent || '').slice(0, 1000); }
    }
    // Apollo / window state probes
    try { if (window.__APOLLO_STATE__) out.apollo = Object.keys(window.__APOLLO_STATE__).slice(0, 20); } catch {}
    for (const s of document.querySelectorAll('script:not([src])')) {
        const t = (s.textContent || '').trim();
        if (t.startsWith('window.') && t.length < 5000) out.otherScripts.push(t.slice(0, 300));
    }
    return out;
});
// Trim jsonLd for log size
findings.phases.p2_embeds = {
    jsonLdCount: embeds.jsonLd.length,
    jsonLdTypes: embeds.jsonLd.map((x) => x?.['@type'] ?? '?'),
    jsonLdSample: embeds.jsonLd.slice(0, 2),
    hasNextData: !!embeds.nextData,
    nextDataKeys: embeds.nextData && typeof embeds.nextData === 'object' ? Object.keys(embeds.nextData) : null,
    nextDataPagePropsKeys: embeds.nextData?.props?.pageProps ? Object.keys(embeds.nextData.props.pageProps) : null,
    apolloKeys: embeds.apollo,
    otherScriptCount: embeds.otherScripts.length,
};
log('  Embeds:', findings.phases.p2_embeds);

// ─── Phase 3: total count / "Y jobs found" ───────────────────────────
const totalCount = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const patterns = [
        /(\d[\d,]+)\s*(jobs?|results?|positions?)/i,
        /showing\s*\d+\s*(of|–|-)\s*(\d[\d,]+)/i,
        /(\d[\d,]+)\s*matches?/i,
    ];
    for (const re of patterns) {
        const m = bodyText.match(re);
        if (m) return { matched: m[0], regex: re.source };
    }
    return null;
});
findings.phases.p3_total_count = totalCount;
log('  Total count:', totalCount);

// ─── Phase 4: pagination probes ──────────────────────────────────────
log('Phase 4: pagination probes (?page=2 / ?start=20 / Next button)...');
const paginationProbes = {};
for (const p of [2, 3, 5]) {
    await page.goto(SEARCH_URL(p), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    const cards = await page.evaluate(() => document.querySelectorAll('a[href*="/job-openings/"]').length);
    paginationProbes[`page=${p}`] = { status: 'rendered', cards };
}
// Try ?start=20 variant
await page.goto(`https://www.monster.com/jobs/search?q=${encodeURIComponent(ROLE)}&where=${encodeURIComponent(LOC)}&start=20`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(3000);
paginationProbes['start=20'] = { cards: await page.evaluate(() => document.querySelectorAll('a[href*="/job-openings/"]').length) };

// Try ?offset=20 variant
await page.goto(`https://www.monster.com/jobs/search?q=${encodeURIComponent(ROLE)}&where=${encodeURIComponent(LOC)}&offset=20`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(3000);
paginationProbes['offset=20'] = { cards: await page.evaluate(() => document.querySelectorAll('a[href*="/job-openings/"]').length) };

// Try infinite scroll on page 1
await page.goto(SEARCH_URL(1), { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(2500);
const beforeScroll = await page.evaluate(() => document.querySelectorAll('a[href*="/job-openings/"]').length);
await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1000)); }
});
const afterScroll = await page.evaluate(() => document.querySelectorAll('a[href*="/job-openings/"]').length);
paginationProbes['scroll_8x'] = { before: beforeScroll, after: afterScroll, delta: afterScroll - beforeScroll };

// Look for a "Next" button
const nextButton = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('a, button')];
    const next = buttons.find((b) => /next/i.test(b.innerText || b.ariaLabel || '') && /next/i.test(b.innerText || '') && !/already/i.test(b.innerText || ''));
    return next ? { tag: next.tagName, text: (next.innerText || '').slice(0, 50), aria: next.ariaLabel, href: next.href ?? null } : null;
});
paginationProbes['next_button_found'] = nextButton;
findings.phases.p4_pagination = paginationProbes;
log('  Pagination probes:', paginationProbes);

// ─── Phase 5: 10x reliability hammer ─────────────────────────────────
log('Phase 5: 10x reliability hammer...');
const hammerResults = [];
for (let i = 0; i < 10; i++) {
    const t = Date.now();
    const resp = await page.goto(SEARCH_URL(1), { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ms = Date.now() - t;
    const status = resp?.status() ?? null;
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
    const blocked = /verify you are human|datadome|access denied|forbidden|cloudflare|ray id/i.test(bodyText);
    const cards = await page.evaluate(() => document.querySelectorAll('a[href*="/job-openings/"]').length).catch(() => 0);
    hammerResults.push({ i, status, ms, cards, blocked });
    log(`  run ${i + 1}: ${status} ${ms}ms cards=${cards}${blocked ? ' BLOCKED' : ''}`);
    await sleep(1500);
}
findings.phases.p5_hammer = hammerResults;
const okCount = hammerResults.filter((r) => r.status === 200 && !r.blocked).length;
const avgMs = Math.round(hammerResults.reduce((s, r) => s + r.ms, 0) / hammerResults.length);
findings.phases.p5_summary = { okRate: `${okCount}/10`, avgMs };
log(`  Reliability: ${okCount}/10 ok, avg ${avgMs}ms`);

// ─── Phase 6: network log summary ─────────────────────────────────────
findings.phases.p6_network = {
    totalRequests: netLog.length,
    fetchXhr: netLog.filter((n) => n.type !== 'document'),
    uniqueOrigins: [...new Set(netLog.map((n) => new URL(n.url).origin))],
};
log(`  Network requests captured: ${netLog.length} total (${findings.phases.p6_network.fetchXhr.length} fetch/xhr)`);

// ─── Done ─────────────────────────────────────────────────────────────
fs.writeFileSync('/tmp/monster-deep-probe.json', JSON.stringify(findings, null, 2));
log('Wrote /tmp/monster-deep-probe.json');

await browser.close().catch(() => {});
process.exit(0);
