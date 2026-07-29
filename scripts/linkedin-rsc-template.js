#!/usr/bin/env node
// Capture the LinkedIn content-search pagination request template.
//
//   npm run linkedin:rsc-template
//
// The RSC scraper sends plain HTTP requests modelled on a request the real
// flagship web app makes. That request carries client-version headers and a body
// shape we cannot invent, so it is captured once per host from a live navigation
// and cached at config/linkedin-rsc-template.json.
//
// This is the ONLY step that drives a browser against LinkedIn. Re-run it if
// LinkedIn ships a client version that breaks the saved template (the scraper
// surfaces that as an auth/DOM failure, not a silent empty).
//
// Session state is deliberately stripped before writing: cookies and csrf-token
// are derived per-request from the account's live jar, so the template on disk
// holds no credentials.

import fs from 'fs';
import path from 'path';
import { launchPersistentProfile } from '../src/core/linkedin-browser.js';
import { linkedInProfileDir } from '../src/core/linkedin-profile.js';
import { templatePath } from '../src/scrapers/linkedin-rsc/session.js';

const PAGINATION_RE = /rsc-action\/actions\/pagination/;
const CONTENT_SEARCH_RE = /contentSearchResults/;
const PROBE_QUERY = process.env.RSC_TEMPLATE_QUERY || 'data engineer';
const SETTLE_MS = 6000;
const SCROLL_TRIES = 6;

// Headers that are session state or hop-by-hop: never persisted.
const STRIP_HEADER = /^(cookie|csrf-token|authorization|content-length|host|connection|accept-encoding)$/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitize(headers) {
    const kept = {};
    for (const [name, value] of Object.entries(headers)) {
        if (STRIP_HEADER.test(name)) continue;
        kept[name] = value;
    }
    return kept;
}

async function main() {
    const out = templatePath();
    console.log('LinkedIn RSC template capture');
    console.log(`  profile: ${linkedInProfileDir()}`);
    console.log(`  writing: ${out}`);

    const context = await launchPersistentProfile();
    let captured = null;

    context.on('request', (req) => {
        if (captured) return;
        const url = req.url();
        if (!PAGINATION_RE.test(url) || !CONTENT_SEARCH_RE.test(url)) return;
        captured = { url, headers: req.headers(), postData: req.postData() };
    });

    try {
        const jar = await context.cookies();
        if (!jar.some((c) => c.name === 'li_at')) {
            console.error('\n✗ This profile is not logged in (no li_at).');
            console.error('  Run `npm run linkedin:login` first, then re-run this.');
            process.exitCode = 2;
            return;
        }

        const page = await context.newPage();
        const searchUrl = 'https://www.linkedin.com/search/results/content/'
            + `?datePosted=${encodeURIComponent('["past-24h"]')}`
            + `&keywords=${encodeURIComponent(PROBE_QUERY)}&origin=FACETED_SEARCH`;

        console.log(`\n  navigating (query "${PROBE_QUERY}")...`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await wait(SETTLE_MS);

        // The first page is server-rendered; pagination only fires on scroll.
        for (let i = 0; i < SCROLL_TRIES && !captured; i++) {
            await page.evaluate(() => {
                const main = document.querySelector('main');
                const root = main && main.scrollHeight > main.clientHeight ? main : window;
                if (root === window) window.scrollBy(0, window.innerHeight);
                else root.scrollTop += root.clientHeight;
            }).catch(() => {});
            await wait(3000);
            process.stdout.write(`  scroll ${i + 1}/${SCROLL_TRIES}${captured ? ' — captured' : ''}\n`);
        }

        if (!captured) {
            console.error('\n✗ No pagination request observed.');
            console.error('  Either the query returned no results (try RSC_TEMPLATE_QUERY="java developer"),');
            console.error('  or LinkedIn changed the search page. Check results/ for a debug snapshot.');
            process.exitCode = 3;
            return;
        }
        if (!captured.postData) {
            console.error('\n✗ Captured a pagination request with no body — cannot build a template.');
            process.exitCode = 4;
            return;
        }

        const template = {
            url: captured.url,
            headers: sanitize(captured.headers),
            postData: captured.postData,
            capturedAt: new Date().toISOString(),
        };

        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(template, null, 2));

        const stripped = Object.keys(captured.headers).length - Object.keys(template.headers).length;
        console.log('\n✓ Template captured');
        console.log(`  url:      ${template.url.slice(0, 96)}`);
        console.log(`  headers:  ${Object.keys(template.headers).length} kept, ${stripped} session/hop-by-hop stripped`);
        console.log(`  body:     ${template.postData.length} bytes`);
        console.log(`  written:  ${out}`);
        console.log('\n  The scraper derives cookies and csrf-token per request, so this file holds no credentials.');
    } finally {
        await context.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error(`\n✗ Template capture failed: ${err?.message ?? err}`);
    process.exitCode = 1;
});
