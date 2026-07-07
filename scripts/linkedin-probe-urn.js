#!/usr/bin/env node
// One-shot DIAGNOSTIC probe (not part of the scrape pipeline). Opens the
// logged-in LinkedIn profile, runs a real content search, and reports where a
// post's urn:li:activity can be recovered WITHOUT the per-post "Copy link" menu.
//
// v3: reliably hooks the page's own fetch/XHR (page.addInitScript on a fresh
// page — context-level addInitScript did not install under CloakBrowser), lists
// EVERY request the page makes as a sanity check, and scans the WHOLE rendered
// DOM for URNs — not just the post cards.
//
// Read-only. Refuses to run while the scraper is up (profile lock).
//   nssm stop qp-scraper
//   node scripts/linkedin-probe-urn.js
//   nssm start qp-scraper
import { launchPersistentProfile } from '../scrapers/linkedin.js';
import { defaultAsk } from '../src/setup/io.js';

const SEARCH_QUERY = '"Data Engineer" AND (c2c OR W2 OR 1099)';

async function scraperRunning(port) {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
        return r.status > 0;
    } catch { return false; }
}

// Runs at document-start in the page: wraps fetch + XHR so we record every
// request the page's own code makes and whether the response carries post URNs.
function installHook() {
    window.__all = [];
    window.__caps = [];
    const rec = (url, body) => {
        try {
            const u = String(url || '');
            if (window.__all.length < 200) window.__all.push(u.split('?')[0].replace(/^https?:\/\/[^/]+/, '').slice(0, 70));
            const b = String(body || '');
            const act = b.match(/urn:li:activity:(\d+)/g) || [];
            const ugc = b.match(/urn:li:ugcPost:(\d+)/g) || [];
            const share = b.match(/urn:li:share:(\d+)/g) || [];
            if (!act.length && !ugc.length && !share.length) return;
            if (act.length && !window.__snip) {
                const i = b.indexOf(act[0]);
                window.__snip = b.slice(Math.max(0, i - 160), i + 220);
            }
            window.__caps.push({
                url: u.split('?')[0].replace(/^https?:\/\/[^/]+/, '').slice(0, 80),
                graphql: /graphql/i.test(u),
                queryId: (u.match(/queryId=([^&]+)/) || [])[1] || null,
                bytes: b.length, activity: act.length, uActivity: new Set(act).size,
                ugcPost: ugc.length, share: share.length,
            });
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
    const oss = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, url) { this.__u = url; return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', () => { try { rec(this.__u, this.responseText || ''); } catch (e) {} });
        return oss.apply(this, arguments);
    };
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
    } finally { ask.close(); }

    const searchUrl = 'https://www.linkedin.com/search/results/content/?'
        + `keywords=${encodeURIComponent(SEARCH_QUERY)}&origin=FACETED_SEARCH`
        + `&datePosted=${encodeURIComponent('["past-24h"]')}`;

    console.log(`Opening profile "${profileKey}" (headed)…`);
    const context = await launchPersistentProfile({ profileKey, proxy: null });

    // Reactive URL inventory (reliable — no body read) as a backup signal.
    const seenResponses = [];
    context.on('response', (resp) => {
        try {
            const u = resp.url();
            if (/voyager|graphql|\/api\/|search/i.test(u)) {
                seenResponses.push(`${resp.status()} ${(resp.headers()['content-type'] || '').split(';')[0]} ${u.split('?')[0].replace(/^https?:\/\/[^/]+/, '').slice(0, 60)}`);
            }
        } catch (e) {}
    });

    // Fresh page + page-level init script (installs reliably under CloakBrowser).
    const page = await context.newPage();
    await page.addInitScript(installHook);

    console.log('Navigating to content search…');
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
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
        all: window.__all || [], caps: window.__caps || [], snip: window.__snip || null,
    })).catch(() => ({ all: [], caps: [], snip: null }));

    console.log('Analyzing DOM…');
    const probe = await page.evaluate(() => {
        const out = {};
        // Global: is a post URN ANYWHERE in the final rendered DOM?
        const html = document.documentElement.outerHTML;
        out.domChars = html.length;
        const gAct = html.match(/urn:li:activity:(\d+)/g) || [];
        const gUgc = html.match(/urn:li:ugcPost:(\d+)/g) || [];
        const gShare = html.match(/urn:li:share:(\d+)/g) || [];
        out.globalActivity = gAct.length; out.globalUgc = gUgc.length; out.globalShare = gShare.length;
        out.globalSampleUrns = [...new Set([...gAct, ...gUgc, ...gShare])].slice(0, 5);
        // Any <script> (not just application/json)
        out.scriptCount = document.querySelectorAll('script').length;
        out.jsonScriptCount = document.querySelectorAll('script[type="application/json"]').length;
        // Rendered posts
        const posts = Array.from(document.querySelectorAll('main div[componentkey^="expanded"]'));
        out.renderedPosts = posts.length;
        return out;
    }).catch((e) => ({ error: String(e && e.message) }));

    await context.close().catch(() => {});

    console.log('\n════════════════ URN PROBE v3 RESULT ════════════════');
    console.log('query:', SEARCH_QUERY);
    console.log(`\n[0] HOOK SANITY — fetch/XHR the page made (in-page hook): ${api.all.length} calls`);
    if (api.all.length === 0) console.log('   ⚠ hook still caught 0 calls — the page may fetch via a Service Worker / streaming.');
    else console.log('   sample: ' + api.all.slice(0, 24).join('  '));
    console.log(`\n   reactive listener saw ${seenResponses.length} voyager/graphql/api/search responses:`);
    for (const r of seenResponses.slice(0, 20)) console.log('     ' + r);

    console.log('\n[1] Captures carrying post URNs (in-page fetch/XHR):');
    if (!api.caps.length) console.log('   NONE — no fetched response contained activity/ugcPost/share URNs.');
    else for (const h of api.caps.slice(0, 16)) {
        console.log(`   ${h.url}${h.graphql ? ' [graphql]' : ''} qId=${h.queryId || '-'} act=${h.activity}(u${h.uActivity}) ugc=${h.ugcPost} share=${h.share} ${h.bytes}b`);
    }
    if (api.snip) console.log('   structure around first activity URN:\n     …' + api.snip.replace(/\s+/g, ' ') + '…');

    console.log('\n[2] URNs ANYWHERE in the final rendered DOM (global scan):');
    console.log(`   domChars=${probe.domChars} scripts=${probe.scriptCount} jsonScripts=${probe.jsonScriptCount}`);
    console.log(`   activity=${probe.globalActivity} ugcPost=${probe.globalUgc} share=${probe.globalShare}  posts=${probe.renderedPosts}`);
    console.log(`   sample: ${JSON.stringify(probe.globalSampleUrns)}`);

    console.log('\nVERDICT:');
    console.log('   • [1] act>0 → hook the search response in the scraper, read URNs passively (best, A-bridge).');
    console.log('   • [1] empty but [2] global URNs>0 → the URN is in the DOM/scripts; parse it directly (A1b).');
    console.log('   • [0] shows a graphql/search call but its body has 0 URNs, and [2]=0 → URN truly only via menu → A2.');
    console.log('   • [0] shows 0 calls → search is SW/streamed; different interception needed.');
    console.log('══════════════════════════════════════════════════════');
    return 0;
}

main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => { console.error('linkedin-probe-urn failed:', err); process.exit(1); });
