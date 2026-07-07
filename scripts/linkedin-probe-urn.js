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

    // Hook fetch + XHR IN-PAGE (reliable where Playwright's reactive
    // response.text() can't read LinkedIn's GraphQL/normalized-JSON bodies).
    // Records every voyager/graphql/api call the page's OWN code makes, and
    // whether it carries post URNs — so we learn if the search results are
    // interceptable (the safe "A-bridge" = Option C for free).
    await context.addInitScript(() => {
        window.__apiCaptures = [];
        const rec = (url, body) => {
            try {
                const u = String(url || '');
                if (!/voyager|graphql|\/api\//i.test(u)) return;
                const b = String(body || '');
                const act = b.match(/urn:li:activity:(\d+)/g) || [];
                const ugc = b.match(/urn:li:ugcPost:(\d+)/g) || [];
                const share = b.match(/urn:li:share:(\d+)/g) || [];
                const fsd = b.match(/urn:li:fsd_update|urn:li:fs_updateV2/g) || [];
                if (!act.length && !ugc.length && !share.length && !fsd.length && !/search|feed|content/i.test(u)) return;
                const cap = {
                    url: u.split('?')[0].replace(/^https?:\/\/[^/]+/, '').slice(0, 90),
                    graphql: /graphql/i.test(u),
                    queryId: (u.match(/queryId=([^&]+)/) || [])[1] || null,
                    bytes: b.length,
                    activity: act.length, uActivity: new Set(act).size,
                    ugcPost: ugc.length, share: share.length, fsdUpdate: fsd.length,
                };
                // First capture that actually has an activity URN: keep a structure snippet.
                if (act.length && !window.__urnSnippet) {
                    const i = b.indexOf(act[0]);
                    window.__urnSnippet = b.slice(Math.max(0, i - 160), i + 220);
                }
                window.__apiCaptures.push(cap);
            } catch (e) { /* ignore */ }
        };
        const of = window.fetch;
        window.fetch = function (...a) {
            const p = of.apply(this, a);
            try {
                const url = (a[0] && a[0].url) || a[0];
                p.then((r) => { try { r.clone().text().then((t) => rec(url, t)).catch(() => {}); } catch (e) {} });
            } catch (e) {}
            return p;
        };
        const oo = XMLHttpRequest.prototype.open;
        const os2 = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, url) { this.__u = url; return oo.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
            this.addEventListener('load', () => { try { rec(this.__u, this.responseText || ''); } catch (e) {} });
            return os2.apply(this, arguments);
        };
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

    const api = await page.evaluate(() => ({
        captures: window.__apiCaptures || [],
        snippet: window.__urnSnippet || null,
    })).catch(() => ({ captures: [], snippet: null }));

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
    console.log('\n[1] In-page fetch/XHR captures (voyager/graphql/api the page itself made):');
    if (!api.captures.length) {
        console.log('   NONE captured — search data did not flow through a hooked fetch/XHR.');
    } else {
        for (const h of api.captures.slice(0, 16)) {
            console.log(`   ${h.url}${h.graphql ? ' [graphql]' : ''}  qId=${h.queryId || '-'}  act=${h.activity}(u${h.uActivity}) ugc=${h.ugcPost} share=${h.share} fsd=${h.fsdUpdate}  ${h.bytes}b`);
        }
        if (api.captures.length > 16) console.log(`   … +${api.captures.length - 16} more`);
    }
    if (api.snippet) console.log(`   structure around first activity URN:\n     …${api.snippet.replace(/\n/g, ' ')}…`);
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
    console.log('   • [1] a search/graphql capture with act>0 (or ugc/share) → A-bridge: hook fetch/XHR');
    console.log('     in the scraper and read post URNs from the response the page already fetches (best).');
    console.log('   • [1] captures exist but 0 URNs → the search payload lacks post URNs; menu stays needed.');
    console.log('   • [1] empty & [2]/[3] empty → URN only via the menu; do A2 (trim menu delays).');
    console.log('═══════════════════════════════════════════════════');
    return 0;
}

main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => { console.error('linkedin-probe-urn failed:', err); process.exit(1); });
