// LinkedIn selector diagnostic — non-interactive.
//
// Launches a persistent Playwright Chrome (visible). Reuses the saved
// profile at /tmp/linkedin-diag-profile. If not logged in, waits 90s
// for the user to log in manually. Then navigates to a content search
// and dumps the new DOM structure so we can fix scrapers/linkedin.js.

import { chromium } from 'playwright';
import path from 'path';
import os from 'os';

const PROFILE_DIR = path.join(os.tmpdir(), 'linkedin-diag-profile');
const SEARCH_QUERY = '"Senior Java Developer" AND (c2c OR W2 OR 1099)';
const SEARCH_URL = `https://www.linkedin.com/search/results/content/?datePosted=%22past-week%22&keywords=${encodeURIComponent(SEARCH_QUERY)}&origin=FACETED_SEARCH`;
const LOGIN_WAIT_MS = 90_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
    console.log(`\n=== LinkedIn selector diagnostic ===`);
    console.log(`Profile: ${PROFILE_DIR}`);
    console.log(`Search URL: ${SEARCH_URL}\n`);

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1366, height: 900 },
    });

    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    let loggedIn = !page.url().includes('/login') && !page.url().includes('/uas/');
    if (!loggedIn) {
        console.log(`Not logged in. Browser is open — please log in within ${LOGIN_WAIT_MS / 1000}s.`);
        const start = Date.now();
        while (Date.now() - start < LOGIN_WAIT_MS) {
            await sleep(2000);
            const url = page.url();
            if (!url.includes('/login') && !url.includes('/uas/') && !url.includes('checkpoint')) {
                console.log(`✓ Logged in (now at ${url})`);
                loggedIn = true;
                break;
            }
        }
        if (!loggedIn) {
            console.log('Timed out waiting for login. Run again after logging in.');
            await context.close();
            process.exit(1);
        }
    } else {
        console.log(`Already logged in (at ${page.url()})`);
    }

    console.log('Navigating to content search...');
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    console.log(`At: ${page.url()}`);
    console.log(`Title: ${await page.title()}`);

    const report = await page.evaluate(() => {
        const out = {};
        out.dataUrnCount = document.querySelectorAll('[data-urn]').length;
        out.dataUrnActivityCount = document.querySelectorAll('[data-urn*="activity:"]').length;
        out.dataIdCount = document.querySelectorAll('[data-id]').length;
        out.dataIdActivityCount = document.querySelectorAll('[data-id*="activity:"]').length;

        out.dataUrnSamples = [...document.querySelectorAll('[data-urn]')].slice(0, 5).map(el => ({
            tag: el.tagName.toLowerCase(),
            urn: el.getAttribute('data-urn'),
            classes: (el.className || '').slice(0, 120),
            childCount: el.children.length,
        }));

        const candidates = [
            'article',
            '[data-urn]',
            '[data-urn*="activity:"]',
            '[data-id]',
            '[data-id*="activity:"]',
            '.feed-shared-update-v2',
            '.occludable-update',
            '.reusable-search__result-container',
            '.search-results__list li',
            '.entity-result',
            '.update-components-actor',
            '.feed-shared-text',
            '.update-components-update-v2__commentary',
            'main li',
            'main article',
            'main [role="article"]',
            'main [role="list"] > li',
            'main [role="list"] > div',
            'main div[role="list"] > *',
            'main div[componentkey]',
            'main div[componentkey] > div',
        ];
        out.candidateSelectors = {};
        for (const sel of candidates) {
            try { out.candidateSelectors[sel] = document.querySelectorAll(sel).length; }
            catch { out.candidateSelectors[sel] = 'ERR'; }
        }

        const main = document.querySelector('main');
        out.mainChildren = main ? [...main.children].slice(0, 5).map((el, i) => ({
            i,
            tag: el.tagName.toLowerCase(),
            classes: (el.className || '').slice(0, 120),
            id: el.id || null,
            innerLen: el.innerText?.length || 0,
        })) : [];

        const posts = [...document.querySelectorAll('[data-urn*="activity:"]')].slice(0, 3);
        out.postSamples = posts.map((el, i) => ({
            i,
            tag: el.tagName.toLowerCase(),
            urn: el.getAttribute('data-urn'),
            classes: (el.className || '').slice(0, 120),
            outer: el.outerHTML.slice(0, 600).replace(/\s+/g, ' '),
            innerHead: (el.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
        }));

        // NEW: drill into `main li` (likely the post containers in the
        // post-data-urn world) and `main div[componentkey]` (LinkedIn's
        // new component wrapping). We need to find:
        //  - what attribute uniquely identifies each post
        //  - selectors for author, body text, link
        out.mainLiSamples = [...document.querySelectorAll('main li')].slice(0, 3).map((el, i) => {
            const links = [...el.querySelectorAll('a[href]')].slice(0, 6).map(a => a.href);
            const attrs = [...el.attributes].map(a => `${a.name}="${a.value.slice(0, 60)}"`);
            const childTags = [...el.children].map(c => c.tagName.toLowerCase()).join(',');
            return {
                i,
                tag: el.tagName.toLowerCase(),
                classes: (el.className || '').slice(0, 120),
                attrs,
                childTags,
                innerLen: (el.innerText || '').length,
                innerHead: (el.innerText || '').slice(0, 250).replace(/\s+/g, ' '),
                links,
                outer: el.outerHTML.slice(0, 1200).replace(/\s+/g, ' '),
            };
        });

        // What componentkey values are most common?
        const keyCounts = {};
        for (const el of document.querySelectorAll('main div[componentkey]')) {
            const k = el.getAttribute('componentkey') || '';
            keyCounts[k] = (keyCounts[k] || 0) + 1;
        }
        out.componentkeyCounts = Object.entries(keyCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([k, n]) => ({ componentkey: k.slice(0, 80), count: n }));

        // NEW: drill into first 2 'expanded...FLAGSHIP_SEARCH' post cards.
        // Look for selectors that survive class-name hashing:
        //   - <time> elements (post date)
        //   - a[href*="/in/"] (author profile)
        //   - a[href*="/feed/update/"] (post permalink)
        //   - <img alt> (author avatar w/ name in alt)
        //   - aria-label attrs
        out.postCardSamples = [...document.querySelectorAll(
            'main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]'
        )].slice(0, 2).map((card, i) => {
            const authorLinks = [...card.querySelectorAll('a[href*="/in/"]')].slice(0, 3).map(a => ({
                href: a.href,
                text: (a.innerText || '').slice(0, 60).replace(/\s+/g, ' '),
                ariaLabel: a.getAttribute('aria-label'),
            }));
            const permalinkLinks = [...card.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"], a[href*="urn:li:activity"]')].slice(0, 3).map(a => a.href);
            const times = [...card.querySelectorAll('time')].slice(0, 2).map(t => ({
                text: (t.innerText || '').slice(0, 40),
                datetime: t.getAttribute('datetime'),
            }));
            const imgs = [...card.querySelectorAll('img[alt]')].slice(0, 2).map(im => ({
                alt: (im.alt || '').slice(0, 80),
                src: im.src?.slice(0, 80),
            }));
            const ariaLabels = [...card.querySelectorAll('[aria-label]')].slice(0, 6).map(el => ({
                tag: el.tagName.toLowerCase(),
                label: (el.getAttribute('aria-label') || '').slice(0, 80),
            }));
            return {
                i,
                componentkey: card.getAttribute('componentkey'),
                innerLen: (card.innerText || '').length,
                innerHead: (card.innerText || '').slice(0, 400).replace(/\s+/g, ' '),
                authorLinks,
                permalinkLinks,
                times,
                imgs,
                ariaLabels,
            };
        });

        if (out.postSamples.length === 0) {
            const fallbackEls = [...document.querySelectorAll('main *')]
                .filter(el => {
                    const c = el.className;
                    return typeof c === 'string' &&
                        (c.includes('update') || c.includes('post') || c.includes('feed-shared') || c.includes('result'));
                })
                .slice(0, 5);
            out.fallbackSamples = fallbackEls.map((el, i) => ({
                i,
                tag: el.tagName.toLowerCase(),
                classes: (el.className || '').slice(0, 120),
                innerHead: (el.innerText || '').slice(0, 120).replace(/\s+/g, ' '),
            }));
        }

        return out;
    });

    console.log('\n=== STRUCTURE REPORT ===\n');
    console.log(`Elements with data-urn anywhere: ${report.dataUrnCount}`);
    console.log(`Elements with data-urn*="activity:": ${report.dataUrnActivityCount}`);
    console.log(`Elements with data-id anywhere: ${report.dataIdCount}`);
    console.log(`Elements with data-id*="activity:": ${report.dataIdActivityCount}`);

    if (report.dataUrnSamples.length) {
        console.log('\nFirst 5 [data-urn] elements:');
        for (const e of report.dataUrnSamples) {
            console.log(`  <${e.tag} data-urn="${e.urn}"  childCount=${e.childCount}>`);
            console.log(`     classes: ${e.classes || '<none>'}`);
        }
    }

    console.log('\nCandidate selector counts (>=3 marked with ★):');
    const ranked = Object.entries(report.candidateSelectors)
        .filter(([, n]) => typeof n === 'number')
        .sort((a, b) => b[1] - a[1]);
    for (const [sel, n] of ranked) {
        if (n === 0) continue;
        const mark = n >= 3 ? ' ★' : '';
        console.log(`  ${n.toString().padStart(4)}  ${sel}${mark}`);
    }

    console.log('\n<main> direct children:');
    for (const c of report.mainChildren) {
        console.log(`  [${c.i}] <${c.tag} id="${c.id || ''}" classes="${c.classes}" innerLen=${c.innerLen}`);
    }

    if (report.postSamples.length) {
        console.log(`\nPost samples (${report.postSamples.length}, from [data-urn*="activity:"]):`);
        for (const p of report.postSamples) {
            console.log(`  [${p.i}] urn=${p.urn}`);
            console.log(`        tag=${p.tag} classes="${p.classes}"`);
            console.log(`        text head: ${p.innerHead}…`);
            console.log(`        outer head: ${p.outer}…`);
        }
    } else if (report.fallbackSamples?.length) {
        console.log('\nNo [data-urn*="activity:"] posts found. Fallback samples:');
        for (const f of report.fallbackSamples) {
            console.log(`  [${f.i}] <${f.tag}> classes="${f.classes}"`);
            console.log(`        text: ${f.innerHead}…`);
        }
    }

    if (report.mainLiSamples?.length) {
        console.log(`\n=== main li samples (likely the new post containers) ===`);
        for (const li of report.mainLiSamples) {
            console.log(`\n[${li.i}] <${li.tag}> innerLen=${li.innerLen} childTags=${li.childTags}`);
            console.log(`     classes: ${li.classes}`);
            console.log(`     attrs: ${li.attrs.join(' | ')}`);
            console.log(`     text head: ${li.innerHead}…`);
            console.log(`     links: ${li.links.slice(0, 4).join(' | ')}`);
            console.log(`     outer head: ${li.outer.slice(0, 500)}…`);
        }
    }

    if (report.componentkeyCounts?.length) {
        console.log('\n=== componentkey values (most common) ===');
        for (const c of report.componentkeyCounts) {
            console.log(`  ${c.count.toString().padStart(4)}  componentkey="${c.componentkey}"`);
        }
    }

    if (report.postCardSamples?.length) {
        console.log('\n=== POST CARD DETAILS (expanded*FLAGSHIP_SEARCH) ===');
        for (const p of report.postCardSamples) {
            console.log(`\n[${p.i}] componentkey: ${p.componentkey}`);
            console.log(`     innerLen: ${p.innerLen}`);
            console.log(`     text head: ${p.innerHead}…`);
            console.log(`     author a[href*="/in/"]: (${p.authorLinks.length})`);
            for (const a of p.authorLinks) console.log(`       href: ${a.href}`);
            for (const a of p.authorLinks) if (a.text) console.log(`       text: "${a.text}"`);
            console.log(`     permalink-ish a[href*=feed/update or /posts/ or urn:activity]: (${p.permalinkLinks.length})`);
            for (const h of p.permalinkLinks) console.log(`       ${h}`);
            console.log(`     <time>: (${p.times.length})`);
            for (const t of p.times) console.log(`       text="${t.text}" datetime="${t.datetime}"`);
            console.log(`     <img alt>: (${p.imgs.length})`);
            for (const im of p.imgs) console.log(`       alt="${im.alt}"`);
            console.log(`     aria-label (first 6):`);
            for (const al of p.ariaLabels) console.log(`       <${al.tag}> "${al.label}"`);
        }
    }

    console.log('\n=== DIAGNOSTIC COMPLETE — closing in 30s ===');
    await sleep(30_000);
    await context.close();
})().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
