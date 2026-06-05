// Deep investigation of dice.com — NOT part of the runtime scraper. Run by hand.
//
// Probes:
//   1. Search-page DOM — count job anchors, snapshot the surrounding card HTML
//   2. Pagination — ?page=N, plus the &filters.postedDate=SEVEN filter, plus alt URLs
//   3. Job-detail page — fetch one detail page; verify <script id="jobDetailStructuredData">
//      is present, parseable, and has the fields the current scraper relies on
//   4. RSC payloads — look for recruiterId + easyApply regex hits in detail HTML
//   5. Recruiter profile page — fetch one /recruiter-profile/<id> and check shape
//   6. Reliability hammer — 10 sequential search-page requests, watch for 403/empty
//   7. Network capture — list every fetch/xhr URL hit during search + detail loads
//
// Writes findings to /tmp/dice-deep-probe.json + HTML snapshots to
// /tmp/dice-search.html, /tmp/dice-detail.html, /tmp/dice-recruiter.html

import fs from 'node:fs';
import { launch } from 'cloakbrowser';

const ROLE = process.env.PROBE_ROLE || 'software engineer';
const LOC  = process.env.PROBE_LOC  || 'United States';
const ROLE_ENC = encodeURIComponent(ROLE);
const LOC_ENC  = encodeURIComponent(LOC);

const SEARCH_URL = (page = 1) =>
    `https://www.dice.com/jobs?q=${ROLE_ENC}&location=${LOC_ENC}&filters.postedDate=SEVEN&page=${page}`;

const findings = {
    timestamp: new Date().toISOString(),
    role: ROLE,
    location: LOC,
    phases: {},
};

const log = (...a) => console.log('[probe]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ headless: true });
const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
});

const netLog = [];
context.on('request', (req) => {
    const type = req.resourceType?.() ?? 'other';
    if (['xhr', 'fetch', 'document'].includes(type)) netLog.push({ method: req.method?.(), url: req.url(), type });
});

const page = await context.newPage();

// ─── Phase 1: search-page DOM ────────────────────────────────────────
log('Phase 1: search page...');
const t0 = Date.now();
const r = await page.goto(SEARCH_URL(1), { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(3000);
const tMs = Date.now() - t0;
const html = await page.content();
fs.writeFileSync('/tmp/dice-search.html', html);
log(`  status ${r?.status()} bytes ${html.length} ms ${tMs}`);

const cardEnum = await page.evaluate(() => {
    const selectors = [
        'a[href*="/job-detail/"]',
        'a[href*="/jobs/detail/"]',
        '[data-testid*="job-card"]',
        '[data-testid*="JobCard"]',
        'article',
        'article[data-testid]',
        'div[data-cy*="job"]',
        '.search-result-row',
    ];
    const out = {};
    for (const s of selectors) try { out[s] = document.querySelectorAll(s).length; } catch { out[s] = 'err' }
    return out;
});
findings.phases.p1_search = { status: r?.status(), bytes: html.length, ms: tMs, cardCounts: cardEnum };
log('  card selectors:', cardEnum);

// Grab first 3 job URLs for downstream
const jobUrls = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('a[href*="/job-detail/"]')].map(a => a.href))].slice(0, 3),
);
findings.phases.p1_sample_job_urls = jobUrls;
log('  sample job URLs:', jobUrls.length);

// ─── Phase 2: pagination probes ──────────────────────────────────────
log('Phase 2: pagination...');
const paginationCounts = {};
for (const p of [2, 3, 5]) {
    await page.goto(SEARCH_URL(p), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    paginationCounts[`page=${p}`] = await page.evaluate(() => document.querySelectorAll('a[href*="/job-detail/"]').length);
}
findings.phases.p2_pagination = paginationCounts;
log('  pagination:', paginationCounts);

// ─── Phase 3: job-detail structured data ─────────────────────────────
let recruiterIdFromDetail = null;
if (jobUrls.length > 0) {
    log('Phase 3: detail page structured data...');
    const dt = Date.now();
    await page.goto(jobUrls[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const detailHtml = await page.content();
    fs.writeFileSync('/tmp/dice-detail.html', detailHtml);
    const detailMs = Date.now() - dt;

    const structured = await page.evaluate(() => {
        const el = document.querySelector('script[id="jobDetailStructuredData"]');
        if (!el) return { present: false };
        const raw = el.textContent || '';
        try {
            const j = JSON.parse(raw);
            return {
                present: true,
                bytes: raw.length,
                type: j?.['@type'],
                topKeys: Object.keys(j ?? {}),
                hasTitle: !!j?.title,
                hasHiringOrg: !!j?.hiringOrganization?.name,
                hasJobLocation: !!j?.jobLocation,
                hasBaseSalary: !!j?.baseSalary,
                employmentType: j?.employmentType ?? null,
                identifier: j?.identifier ?? null,
                sampleTitle: j?.title?.slice?.(0, 80),
                sampleCompany: j?.hiringOrganization?.name,
            };
        } catch (e) { return { present: true, parseError: e.message, snippet: raw.slice(0, 200) }; }
    });
    findings.phases.p3_detail = { url: jobUrls[0], ms: detailMs, bytes: detailHtml.length, structured };
    log('  detail structured:', structured);

    // ─── Phase 4: RSC payload regex hits ────────────────────────────
    const rscHits = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '');
        const out = { recruiterIdMatches: 0, easyApplyMatches: 0, recruiterIdFirst: null, easyApplyFirst: null };
        for (const s of scripts) {
            if (s.includes('recruiterId')) {
                out.recruiterIdMatches++;
                if (!out.recruiterIdFirst) {
                    const m = s.match(/"recruiterId"\s*:\s*"([a-f0-9-]{36})"/);
                    if (m) out.recruiterIdFirst = m[1];
                }
            }
            if (s.includes('"easyApply"')) {
                out.easyApplyMatches++;
                if (!out.easyApplyFirst) {
                    const m = s.match(/"easyApply"\s*:\s*(true|false)/);
                    if (m) out.easyApplyFirst = m[1];
                }
            }
        }
        return out;
    });
    findings.phases.p4_rsc_payloads = rscHits;
    log('  RSC payloads:', rscHits);
    recruiterIdFromDetail = rscHits.recruiterIdFirst;

    // SeuiInfoBadge presence (skills + salary fallback)
    const badges = await page.evaluate(() => ({
        seuiInfoBadge: document.querySelectorAll('.SeuiInfoBadge').length,
        locationTypeBadge: document.querySelectorAll('[data-testid="locationTypeBadge"]').length,
        skillsHeadingPresent: [...document.querySelectorAll('h3')].some(h => h.textContent?.trim() === 'Skills'),
    }));
    findings.phases.p4_badges = badges;
    log('  badges:', badges);
}

// ─── Phase 5: recruiter profile fetch ────────────────────────────────
if (recruiterIdFromDetail) {
    log(`Phase 5: recruiter profile (${recruiterIdFromDetail})...`);
    const recruiterUrl = `https://www.dice.com/recruiter-profile/${recruiterIdFromDetail}`;
    await page.goto(recruiterUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);
    const rhtml = await page.content();
    fs.writeFileSync('/tmp/dice-recruiter.html', rhtml);

    const rcheck = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '');
        let firstName = null, lastName = null, jobTitle = null, companyName = null;
        for (const s of scripts) {
            const f = s.match(/"firstName"\s*:\s*"([^"]+)"/);
            const l = s.match(/"lastName"\s*:\s*"([^"]+)"/);
            const t = s.match(/"jobTitle"\s*:\s*"([^"]+)"/);
            const c = s.match(/"companyName"\s*:\s*"([^"]+)"/);
            if (f && !firstName) firstName = f[1];
            if (l && !lastName)  lastName  = l[1];
            if (t && !jobTitle)  jobTitle  = t[1];
            if (c && !companyName) companyName = c[1];
        }
        return { firstName, lastName, jobTitle, companyName };
    });
    findings.phases.p5_recruiter = { url: recruiterUrl, parsed: rcheck };
    log('  recruiter parsed:', rcheck);
} else {
    findings.phases.p5_recruiter = { skipped: 'no recruiterId found in sample detail' };
}

// ─── Phase 6: reliability hammer ─────────────────────────────────────
log('Phase 6: 10x reliability hammer...');
const hammer = [];
for (let i = 0; i < 10; i++) {
    const ts = Date.now();
    const resp = await page.goto(SEARCH_URL(1), { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ms = Date.now() - ts;
    const status = resp?.status();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
    const blocked = /verify you are human|access denied|cloudflare|forbidden|ray id|datadome/i.test(bodyText);
    const anchors = await page.evaluate(() => document.querySelectorAll('a[href*="/job-detail/"]').length).catch(() => 0);
    hammer.push({ i, status, ms, anchors, blocked });
    log(`  run ${i + 1}: ${status} ${ms}ms anchors=${anchors}${blocked ? ' BLOCKED' : ''}`);
    await sleep(1200);
}
findings.phases.p6_hammer = hammer;
const ok = hammer.filter(h => h.status === 200 && !h.blocked && h.anchors > 0).length;
const avg = Math.round(hammer.reduce((s, h) => s + h.ms, 0) / hammer.length);
findings.phases.p6_summary = { okRate: `${ok}/10`, avgMs: avg };
log(`  reliability: ${ok}/10 ok, avg ${avg}ms`);

// ─── Phase 7: network log ────────────────────────────────────────────
findings.phases.p7_network = {
    totalRequests: netLog.length,
    fetchXhrCount: netLog.filter(n => n.type !== 'document').length,
    uniqueOrigins: [...new Set(netLog.map(n => new URL(n.url).origin))].slice(0, 12),
};
log(`  network: ${netLog.length} total reqs, ${findings.phases.p7_network.fetchXhrCount} fetch/xhr`);

fs.writeFileSync('/tmp/dice-deep-probe.json', JSON.stringify(findings, null, 2));
log('Wrote /tmp/dice-deep-probe.json');

await browser.close().catch(() => {});
process.exit(0);
