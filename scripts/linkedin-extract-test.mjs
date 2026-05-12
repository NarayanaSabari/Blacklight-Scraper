// Standalone test of the NEW extractor logic.
// Uses the same persistent-context profile as the diag script (so login
// is reused). Runs the same page.evaluate block we just shipped in
// scrapers/linkedin.js and prints the extracted posts.

import { chromium } from 'playwright';
import path from 'path';
import os from 'os';

const PROFILE_DIR = path.join(os.tmpdir(), 'linkedin-diag-profile');
const SEARCH_QUERY = '"Senior Java Developer" AND (c2c OR W2 OR 1099)';
const SEARCH_URL = `https://www.linkedin.com/search/results/content/?datePosted=%22past-week%22&keywords=${encodeURIComponent(SEARCH_QUERY)}&origin=FACETED_SEARCH`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
    console.log(`\n=== LinkedIn extract test (NEW selectors) ===`);
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1366, height: 900 },
    });
    const page = context.pages()[0] || await context.newPage();

    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    console.log(`URL: ${page.url()}`);

    // Mirror the exact extraction block from scrapers/linkedin.js
    const posts = await page.evaluate((config) => {
        const isSearchPage = window.location.href.includes('/search/results/content/');
        const SEARCH_SELECTOR = 'main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]';
        const FALLBACK_SELECTOR = 'main div[componentkey^="expanded"]';

        let postElements = document.querySelectorAll(isSearchPage ? SEARCH_SELECTOR : FALLBACK_SELECTOR);
        if (postElements.length === 0) postElements = document.querySelectorAll(FALLBACK_SELECTOR);

        const results = [];
        const debugInfo = { sampleLinks: [], foundIds: [] };
        const seenInRun = new Set();

        postElements.forEach((element, index) => {
            try {
                if (element.querySelector('a[href*="/jobs/view/"]')) return;
                const compKey = element.getAttribute('componentkey') || '';
                const postId = compKey.replace(/^expanded/, '').replace(/FeedType_[A-Z_]+$/, '');
                if (!postId || seenInRun.has(postId)) return;
                seenInRun.add(postId);

                if (index === 0 && results.length === 0) {
                    debugInfo.elementInfo = {
                        componentkey: compKey.slice(0, 100),
                        extractedPostId: postId.slice(0, 40),
                    };
                }

                const authorEl = element.querySelector('a[href*="/in/"]');
                const authorProfileUrl = authorEl ? authorEl.href.split('?')[0] : '';
                let authorName = '';
                if (authorEl) {
                    authorName = (authorEl.innerText || '').trim().split('•')[0].trim();
                }
                if (!authorName) {
                    const ctlBtn = element.querySelector('button[aria-label^="Open control menu for post by"]');
                    if (ctlBtn) authorName = (ctlBtn.getAttribute('aria-label') || '').replace(/^Open control menu for post by\s+/i, '').trim();
                }

                const fullText = (element.innerText || '').trim();
                let postContent = '';
                const followSplit = fullText.split(/\s+•\s+Follow\s+/);
                if (followSplit.length > 1) {
                    postContent = followSplit.slice(1).join(' • Follow ').trim();
                } else {
                    const candidates = element.querySelectorAll('span[dir="ltr"], p, div[lang]');
                    let best = '';
                    for (const c of candidates) {
                        const t = (c.innerText || '').trim();
                        if (t.length > best.length) best = t;
                    }
                    postContent = best;
                }
                postContent = postContent.replace(/\s+(?:Like|Comment|Repost|Send)\s+.*$/s, '').trim();

                const headerStrip = followSplit[0] || fullText;
                const timeMatch = headerStrip.match(/(\d+[smhdwy])\s*$/);
                const timestamp = timeMatch ? timeMatch[1] : '';

                let postUrl = '';
                const updateLink = element.querySelector('a[href*="/feed/update/"], a[href*="/posts/"], a[href*="urn:li:activity"]');
                if (updateLink?.href) postUrl = updateLink.href.split('?')[0];

                if (authorName && postContent && postContent.length > 20) {
                    results.push({ id: postId, author: authorName, authorProfileUrl, content: postContent, timestamp, postUrl });
                }
            } catch (e) { /* skip */ }
        });

        return { results, debugInfo };
    }, { searchQuery: SEARCH_QUERY });

    console.log(`\n=== RESULT: ${posts.results.length} posts extracted ===`);
    console.log(`Debug: ${JSON.stringify(posts.debugInfo, null, 2)}`);
    console.log('');
    posts.results.slice(0, 5).forEach((p, i) => {
        console.log(`[${i + 1}] ${p.author}  (${p.timestamp || '-'})`);
        console.log(`    profile: ${p.authorProfileUrl}`);
        console.log(`    postUrl: ${p.postUrl || '(none)'}`);
        console.log(`    text:    ${p.content.slice(0, 150).replace(/\s+/g, ' ')}…`);
        console.log('');
    });
    if (posts.results.length > 5) console.log(`(+${posts.results.length - 5} more)`);

    console.log('\nClosing in 15s…');
    await sleep(15_000);
    await context.close();
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
