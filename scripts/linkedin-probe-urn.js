#!/usr/bin/env node
// One-shot DIAGNOSTIC probe (not part of the scrape pipeline). Opens the
// logged-in LinkedIn profile, runs a real content search, and reports where a
// post's canonical permalink / urn:li:activity ID can be recovered WITHOUT the
// slow per-post "Copy link" menu dance. Answers the Option-A feasibility
// question:
//
//   (1) Is the activity URN present in the page's EMBEDDED JSON
//       (script[type=application/json] / <code> hydration blocks) and mappable
//       to the rendered posts?  → enables A1 (parse embedded JSON).
//   (2) Do LinkedIn's own Voyager XHR responses (voyager/api/*) carry the URNs?
//       → enables passively intercepting traffic the browser ALREADY makes
//         (a low-risk bridge to Option C — no extra requests, no menu).
//   (3) Does the post CARD carry any urn / /posts/ link at all?
//
// Read-only: navigates + scrolls + reads; never posts or mutates. Refuses to
// run while the scraper is up (it would fight the profile lock).
//
// Run on the LinkedIn host (Windows-us), scraper stopped:
//   nssm stop qp-scraper
//   node scripts/linkedin-probe-urn.js
//   nssm start qp-scraper
import os from 'node:os';
import { launchPersistentProfile } from '../scrapers/linkedin.js';
import { defaultAsk } from '../src/setup/io.js';

const SEARCH_QUERY = '"Data Engineer" AND (c2c OR W2 OR 1099)';

async function scraperRunning(port) {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
        return r.status > 0;
    } catch { return false; }
}

async function main() {
    const port = process.env.PORT || 3001;
    if (await scraperRunning(port)) {
        console.error(`✗ Scraper is running on :${port}. Stop it first (nssm stop qp-scraper), then re-run.`);
        return 2;
    }

    const ask = defaultAsk();
    let profileKey;
    try {
        const a = await ask('Profile key to open (blank = li-acct-1):');
        profileKey = a && String(a).trim() ? String(a).trim() : 'li-acct-1';
    } finally {
        ask.close();
    }

    const searchUrl = 'https://www.linkedin.com/search/results/content/?'
        + `keywords=${encodeURIComponent(SEARCH_QUERY)}`
        + '&origin=FACETED_SEARCH'
        + `&datePosted=${encodeURIComponent('["past-24h"]')}`;

    console.log(`Opening profile "${profileKey}" (headed)…`);
    const context = await launchPersistentProfile({ profileKey, proxy: null });

    // Capture Voyager XHR responses BEFORE navigating so we see the search fetch.
    const voyagerHits = [];
    context.on('response', async (resp) => {
        const url = resp.url();
        if (!url.includes('/voyager/api')) return;
        try {
            const ct = (resp.headers()['content-type'] || '').toLowerCase();
            if (!ct.includes('json')) return;
            const text = await resp.text();
            const urns = text.match(/urn:li:activity:(\d+)/g) || [];
            if (urns.length) {
                voyagerHits.push({
                    url: url.split('?')[0].replace('https://www.linkedin.com', '') + (url.includes('graphql') ? '?graphql' : ''),
                    queryId: (url.match(/queryId=([^&]+)/) || [])[1] || null,
                    urnCount: urns.length,
                    uniqueUrns: new Set(urns).size,
                    bytes: text.length,
                });
            }
        } catch { /* body already consumed / non-text — ignore */ }
    });

    const page = context.pages()[0] || await context.newPage();
    console.log('Navigating to content search…');
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // Let the SPA hydrate + fetch results, then scroll to force lazy loads.
    await page.waitForTimeout(6000);
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
            const m = document.querySelector('main');
            if (m && m.scrollHeight > m.clientHeight + 50) m.scrollTop = m.scrollHeight;
            else window.scrollTo(0, document.documentElement.scrollHeight);
        }).catch(() => {});
        await page.waitForTimeout(3500);
    }

    console.log('Analyzing embedded JSON + post DOM…');
    const probe = await page.evaluate(() => {
        const out = {};
        const jsonScripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        const codeBlocks = Array.from(document.querySelectorAll('code'));
        out.jsonScriptCount = jsonScripts.length;
        out.codeBlockCount = codeBlocks.length;
        const allJson = [...jsonScripts, ...codeBlocks].map((e) => e.textContent || '').join('\n');
        out.embeddedJsonChars = allJson.length;
        const urnMatches = allJson.match(/urn:li:activity:(\d+)/g) || [];
        const uniqueUrns = [...new Set(urnMatches)];
        out.urnsInEmbeddedJson = urnMatches.length;
        out.uniqueUrnsInEmbeddedJson = uniqueUrns.length;
        out.sampleUrns = uniqueUrns.slice(0, 6);

        const posts = Array.from(document.querySelectorAll('main div[componentkey^="expanded"]'));
        out.renderedPosts = posts.length;
        out.postDiag = posts.slice(0, 4).map((el) => {
            const compKey = el.getAttribute('componentkey') || '';
            const hash = compKey.replace(/^expanded/, '').replace(/FeedType_[A-Z_]+$/, '');
            const elUrn = (el.outerHTML.match(/urn:li:activity:(\d+)/) || [])[1] || null;
            const perma = el.querySelector('a[href*="/posts/"], a[href*="/feed/update/"]');
            const dataAttrs = [];
            el.querySelectorAll('*').forEach((n) => {
                for (const at of n.attributes) {
                    if (at.name.startsWith('data-') && /urn|activity|entity|tracking|id$/i.test(at.name)) {
                        dataAttrs.push(`${at.name}=${String(at.value).slice(0, 50)}`);
                    }
                }
            });
            return {
                hash: hash.slice(0, 24),
                elUrn,
                hasCardPermalink: !!perma,
                cardPermalinkHref: perma ? perma.getAttribute('href').slice(0, 90) : null,
                hashAppearsInJson: hash ? allJson.includes(hash) : false,
                dataAttrs: dataAttrs.slice(0, 8),
            };
        });
        if (uniqueUrns.length) {
            const i = allJson.indexOf(uniqueUrns[0]);
            out.urnJsonContext = allJson.slice(Math.max(0, i - 120), i + 160);
        }
        return out;
    }).catch((e) => ({ error: String(e && e.message) }));

    await context.close().catch(() => {});

    // ── Report ──────────────────────────────────────────────────────────────
    console.log('\n════════════════ URN PROBE RESULT ════════════════');
    console.log('search query:', SEARCH_QUERY);
    console.log('\n[1] Voyager XHR responses carrying activity URNs (passive-intercept feasibility):');
    if (voyagerHits.length === 0) {
        console.log('   NONE — the page did not expose search results via a JSON voyager/api response.');
    } else {
        for (const h of voyagerHits.slice(0, 12)) {
            console.log(`   ${h.url}  queryId=${h.queryId || '-'}  urns=${h.urnCount} (uniq ${h.uniqueUrns})  ${h.bytes}b`);
        }
    }
    console.log('\n[2] Embedded page JSON (script/code hydration blocks):');
    console.log(`   jsonScripts=${probe.jsonScriptCount} codeBlocks=${probe.codeBlockCount} chars=${probe.embeddedJsonChars}`);
    console.log(`   activity URNs in embedded JSON: ${probe.urnsInEmbeddedJson} (unique ${probe.uniqueUrnsInEmbeddedJson})`);
    console.log(`   sample URNs: ${JSON.stringify(probe.sampleUrns)}`);
    if (probe.urnJsonContext) console.log(`   context around first URN: …${probe.urnJsonContext}…`);
    console.log('\n[3] Rendered post cards:');
    console.log(`   rendered posts: ${probe.renderedPosts}`);
    for (const p of probe.postDiag || []) {
        console.log(`   • hash=${p.hash} elUrn=${p.elUrn || '—'} cardPermalink=${p.hasCardPermalink ? p.cardPermalinkHref : 'none'} hashInJson=${p.hashAppearsInJson}`);
        if (p.dataAttrs?.length) console.log(`     data-*: ${p.dataAttrs.join('  ')}`);
    }
    console.log('\nVERDICT HINTS:');
    console.log('   • [1] non-empty  → A-bridge: intercept the voyager response, read URNs passively (best).');
    console.log('   • [2] URNs>0 AND a post hash appears in JSON → A1: map card→URN via embedded JSON.');
    console.log('   • both empty, [3] elUrn/cardPermalink all none → URN only via the menu; do A2 (trim menu delays).');
    console.log('═══════════════════════════════════════════════════');
    return 0;
}

main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => { console.error('linkedin-probe-urn failed:', err); process.exit(1); });
