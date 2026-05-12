// LinkedIn Scraper - CDP Connection Method
// Connects to your existing Chrome browser (no automation detection!)

import { chromium } from 'playwright';
import { createLogger } from '../src/logger/index.js';
import { normalizeJobData } from '../src/core/normalize.js';
import { getCredentialsAPIClient } from '../src/api/credentials.js';
import { getMetrics } from '../src/metrics/registry.js';

const log = createLogger('linkedin');
const logProgress = (_scope, msg) => log.info(msg);
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const CONFIG = {
    cdpUrl: 'http://localhost:9222',
    searchQuery: '',   // Will be built as a boolean query dynamically
    jobTitle: '',      // Will be set dynamically
    maxPosts: 100,
    scrollDelay: 2000,
    // LinkedIn credentials (fetched from API)
    email: null,
    password: null,
    credentialId: null,
    // Use search instead of feed for better job targeting
    useFeedInsteadOfSearch: false  // Set to true to use feed (has URLs but less relevant)
};

/**
 * Build a LinkedIn boolean search query.
 * 
 * LinkedIn content search supports: "exact phrase", AND, OR, NOT, parentheses.
 * 
 * Examples:
 *   jobTitle="DevOps Engineer"
 *   => "DevOps Engineer" AND (c2c OR W2 OR 1099)
 * 
 *   jobTitle="Product Owner"
 *   => "Product Owner" AND (c2c OR W2 OR 1099)
 * 
 *   jobTitle="SRE"
 *   => "SRE" AND (c2c OR W2 OR 1099)
 * 
 * @param {string} jobTitle - The job title/role to search for
 * @returns {string} LinkedIn boolean search query string
 */
function buildBooleanSearchQuery(jobTitle) {
    const titlePart = `"${jobTitle}"`;

    // Pattern: "Job Title" AND (c2c OR W2 OR 1099)
    return `${titlePart} AND (c2c OR W2 OR 1099)`;
}

// Helper: Wait function
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Random delay
const randomDelay = (min, max) => wait(min + Math.random() * (max - min));

// Helper: Check if Chrome is running on port 9222
async function isChromeRunning() {
    try {
        const response = await fetch('http://localhost:9222/json/version');
        return response.ok;
    } catch (error) {
        return false;
    }
}

// Helper: Start Chrome with remote debugging
async function startChromeWithDebugging() {
    return new Promise((resolve, reject) => {
        const chromePath = process.platform === 'win32'
            ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            : (process.env.CHROME_PATH || '/usr/bin/google-chrome');
        const userDataDir = join(process.env.HOME || process.env.USERPROFILE, 'chrome-debug-profile');
        
        logProgress('LinkedIn', '🚀 Starting Chrome with remote debugging...');
        
        const chromeProcess = spawn(chromePath, [
            '--remote-debugging-port=9222',
            `--user-data-dir=${userDataDir}`,
            'https://www.linkedin.com/feed/'
        ], {
            detached: true,
            stdio: 'ignore'
        });
        
        chromeProcess.unref();
        
        // Wait for Chrome to start and port to be available
        let attempts = 0;
        const maxAttempts = 20;
        
        const checkInterval = setInterval(async () => {
            attempts++;
            const isRunning = await isChromeRunning();
            
            if (isRunning) {
                clearInterval(checkInterval);
                logProgress('LinkedIn', '✅ Chrome started successfully on port 9222');
                resolve();
            } else if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                reject(new Error('Chrome failed to start within 10 seconds'));
            }
        }, 500);
    });
}

async function connectToChrome() {
    logProgress('LinkedIn', '🔗 Connecting to Chrome on port 9222...');
    
    // Check if Chrome is already running with debugging
    const isRunning = await isChromeRunning();
    
    if (!isRunning) {
        logProgress('LinkedIn', '⚠️  Chrome not running with debugging, attempting to start...');
        try {
            await startChromeWithDebugging();
            // Give Chrome a moment to fully initialize
            await wait(2000);
        } catch (error) {
            logProgress('LinkedIn', 'ERROR: ❌ Failed to start Chrome automatically');
            logProgress('LinkedIn', 'ERROR:    Please manually run: start-chrome.bat');
            throw error;
        }
    }
    
    try {
        const browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
        logProgress('LinkedIn', '✅ Connected to Chrome successfully!');
        return browser;
    } catch (error) {
        logProgress('LinkedIn', 'ERROR: ❌ Failed to connect to Chrome. Make sure:');
        logProgress('LinkedIn', 'ERROR:    1. Chrome is running with: start-chrome.bat');
        logProgress('LinkedIn', 'ERROR:    2. You are logged into LinkedIn');
        logProgress('LinkedIn', 'ERROR:    3. Port 9222 is not blocked');
        throw error;
    }
}

// Helper: Check if a URL indicates an unauthenticated/login page
function isLoginPage(url) {
    return url.includes('/login') || 
           url.includes('/uas/login') || 
           url.includes('/checkpoint/lg/') ||
           url.includes('/authwall') ||
           url.includes('session_redirect');
}

// Helper: Check if a URL indicates an authenticated page
function isAuthenticatedPage(url) {
    return (url.includes('/feed') || 
            url.includes('/mynetwork') || 
            url.includes('/search/results') ||
            url.includes('/in/') ||
            url.includes('/jobs')) &&
           !isLoginPage(url);
}

async function ensureLoggedIn(page) {
    logProgress('LinkedIn', '🔐 Verifying authentication status...');
    
    // Navigate to feed to reliably check login state
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(3000, 5000);
    
    const currentUrl = page.url();
    logProgress('LinkedIn', `   Current URL after feed navigation: ${currentUrl}`);
    
    // If we landed on the feed, we're logged in
    if (isAuthenticatedPage(currentUrl)) {
        logProgress('LinkedIn', '✅ Already logged in (verified via feed navigation)');
        return true;
    }
    
    // We got redirected to a login page - need to perform login
    logProgress('LinkedIn', '🔑 Not logged in, performing login...');
    await performLogin(page);
    return true;
}

async function performLogin(page) {
    const currentUrl = page.url();
    
    // Navigate to login page if not already there
    if (!currentUrl.includes('/login') && !currentUrl.includes('/uas/login')) {
        logProgress('LinkedIn', '📍 Navigating to login page...');
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomDelay(2000, 3000);
    }

    // Check if "Sign in using another account" button exists and click it
    try {
        const anotherAccountButton = await page.$('button.signin-other-account, button.artdeco-list__item.signin-other-account, .signin-other-account');
        if (anotherAccountButton) {
            const isVisible = await anotherAccountButton.isVisible();
            if (isVisible) {
                logProgress('LinkedIn', '🔘 Clicking "Sign in using another account" button...');
                await anotherAccountButton.click();
                await randomDelay(2000, 3000);
            }
        }
    } catch (error) {
        // Button not found, continue to email field
        logProgress('LinkedIn', '   No account selection page, proceeding to email field...');
    }

    // Fill email
    logProgress('LinkedIn', `📧 Entering email: ${CONFIG.email}`);
    await page.waitForSelector('#username', { timeout: 10000 });
    await page.click('#username');
    await randomDelay(300, 600);
    
    // Clear any existing text in email field
    await page.evaluate(() => {
        const emailField = document.querySelector('#username');
        if (emailField) emailField.value = '';
    });
    
    // Select all and delete as backup
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await randomDelay(200, 400);
    
    // Type new email
    for (let char of CONFIG.email) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    await randomDelay(500, 1000);
    
    // Fill password
    logProgress('LinkedIn', '🔒 Entering password...');
    await page.click('#password');
    await randomDelay(300, 600);
    
    // Clear any existing text in password field
    await page.evaluate(() => {
        const passwordField = document.querySelector('#password');
        if (passwordField) passwordField.value = '';
    });
    
    // Select all and delete as backup
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await randomDelay(200, 400);
    
    // Type new password
    for (let char of CONFIG.password) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    }
    
    await randomDelay(1000, 2000);
    
    // Click sign in button
    logProgress('LinkedIn', '🖱️  Clicking Sign in button...');
    const signInButton = await page.$('button[type="submit"]');
    if (signInButton) {
        await signInButton.click();
    } else {
        await page.keyboard.press('Enter');
    }
    
    // Wait for LinkedIn to process login and redirect
    logProgress('LinkedIn', '⏳ Waiting for login to complete...');
    
    // Wait for navigation away from login page (up to 15s)
    try {
        await page.waitForURL(url => !isLoginPage(url.toString()), { timeout: 15000 });
        logProgress('LinkedIn', '   Login redirect detected');
    } catch {
        logProgress('LinkedIn', '   Login redirect wait timed out, checking page state...');
    }
    
    await randomDelay(3000, 5000);
    
    // Check the result
    const finalUrl = page.url();
    logProgress('LinkedIn', `   Current URL: ${finalUrl}`);
    
    // First check: Are we successfully logged in? (on an authenticated page)
    if (isAuthenticatedPage(finalUrl)) {
        logProgress('LinkedIn', '✅ Login successful!');
        return true;
    }
    
    // Check for explicit error messages (only if still on login-related pages)
    if (isLoginPage(finalUrl)) {
        const hasError = await page.evaluate(() => {
            const errorText = document.body.innerText.toLowerCase();
            const hasErrorMessage = errorText.includes('wrong email or password') || 
                   errorText.includes('incorrect email or password') ||
                   errorText.includes("couldn't find a linkedin account") ||
                   errorText.includes('that password is incorrect');
            
            const hasErrorElement = document.querySelector('.alert-error, .error-message, .form__error') !== null;
            
            return hasErrorMessage || hasErrorElement;
        });
        
        if (hasError) {
            logProgress('LinkedIn', '❌ Wrong credentials detected on page!');
            throw new Error('Login failed: Invalid email or password');
        }
        
        // Still on login page but no error message = credentials likely wrong
        logProgress('LinkedIn', '❌ Still on login page - credentials likely wrong');
        throw new Error('Login failed: Invalid credentials (still on login page)');
    }
    
    // Check for security challenges/verification
    if (finalUrl.includes('/challenge') || finalUrl.includes('/checkpoint/challenge')) {
        logProgress('LinkedIn', '⚠️  Security challenge/verification required');
        throw new Error('Login failed: Security challenge detected - account may need verification');
    }
    
    // If we reached here and passed all checks, assume success
    logProgress('LinkedIn', '✅ Login successful - redirected to authenticated page');
    return true;
}

async function navigateToSearch(page, query) {
    logProgress('LinkedIn', `🔍 Boolean Search Query: ${CONFIG.searchQuery}`);
    
    // Verify login by navigating to feed (this also establishes session)
    await ensureLoggedIn(page);
    
    // Choose between feed (with URLs) or search (filtered but less reliable URLs)
    if (CONFIG.useFeedInsteadOfSearch) {
        logProgress('LinkedIn', '✅ Using main feed (posts will have URLs)');
        logProgress('LinkedIn', `🔍 Filtering: ${CONFIG.searchQuery}`);
        // Stay on feed page (ensureLoggedIn already navigated to feed)
    } else {
        // Use the boolean search query directly in the URL
        const encodedQuery = encodeURIComponent(CONFIG.searchQuery);
        const contentSearchUrl = `https://www.linkedin.com/search/results/content/?datePosted=%22past-week%22&keywords=${encodedQuery}&origin=FACETED_SEARCH&sid=*To`;
        
        logProgress('LinkedIn', `🔗 Navigating to content search page...`);
        logProgress('LinkedIn', `   Query: ${CONFIG.searchQuery}`);
        logProgress('LinkedIn', `   URL: ${contentSearchUrl}`);
        
        // Navigate directly to content search results
        await page.goto(contentSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await randomDelay(4000, 6000);
        
        // Check if LinkedIn redirected us to a login page (US behavior)
        const postNavUrl = page.url();
        if (isLoginPage(postNavUrl)) {
            logProgress('LinkedIn', '⚠️  Search page redirected to login (US LinkedIn behavior)');
            logProgress('LinkedIn', '🔑 Performing login and retrying search...');
            
            // Perform login
            await performLogin(page);
            await randomDelay(2000, 3000);
            
            // Retry the search navigation
            logProgress('LinkedIn', '🔄 Retrying content search navigation...');
            await page.goto(contentSearchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await randomDelay(4000, 6000);
            
            // If still redirected to login, try using the search bar from feed
            const retryUrl = page.url();
            if (isLoginPage(retryUrl)) {
                logProgress('LinkedIn', '⚠️  Still redirected to login after re-login');
                logProgress('LinkedIn', '🔄 Trying alternative: search from feed page...');
                
                // Go to feed first
                await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await randomDelay(3000, 5000);
                
                // Use the search bar on the feed page with the boolean query
                try {
                    const searchInput = await page.$('input.search-global-typeahead__input, input[placeholder*="Search"], input[role="combobox"]');
                    if (searchInput) {
                        logProgress('LinkedIn', `   Found search bar, typing boolean query: ${CONFIG.searchQuery}`);
                        await searchInput.click();
                        await randomDelay(500, 1000);
                        await searchInput.type(CONFIG.searchQuery, { delay: 50 });
                        await randomDelay(500, 1000);
                        await page.keyboard.press('Enter');
                        await randomDelay(3000, 5000);
                        
                        // Click on "Posts" filter tab to get content results
                        try {
                            const postsTab = await page.$('button[aria-label*="Posts"], a[href*="content"], button:has-text("Posts")');
                            if (postsTab) {
                                logProgress('LinkedIn', '   Clicking "Posts" filter tab...');
                                await postsTab.click();
                                await randomDelay(3000, 5000);
                            } else {
                                // Try clicking by text content
                                await page.evaluate(() => {
                                    const buttons = [...document.querySelectorAll('button, a')];
                                    const postsBtn = buttons.find(b => b.textContent.trim() === 'Posts');
                                    if (postsBtn) postsBtn.click();
                                });
                                await randomDelay(3000, 5000);
                            }
                        } catch (tabError) {
                            logProgress('LinkedIn', `   Could not find Posts tab: ${tabError.message}`);
                        }
                    } else {
                        logProgress('LinkedIn', '   Search bar not found, staying on feed page');
                    }
                } catch (searchError) {
                    logProgress('LinkedIn', `   Search bar approach failed: ${searchError.message}`);
                    logProgress('LinkedIn', '   Falling back to feed mode...');
                }
            }
        }
    }
    
    // Verify we're on the right page
    const currentUrl = page.url();
    logProgress('LinkedIn', `📍 Current URL: ${currentUrl}`);
    
    const isFeedPage = currentUrl.includes('/feed');
    const isSearchPage = currentUrl.includes('/search/results/content/');
    
    if (isFeedPage) {
        logProgress('LinkedIn', '✅ On main feed page (posts will include URLs)');
    } else if (isSearchPage) {
        logProgress('LinkedIn', '✅ On content search results page');
        logProgress('LinkedIn', '⚠️  Post URLs not available from search (use feed mode instead)');
    } else {
        logProgress('LinkedIn', '⚠️  Unexpected page, continuing anyway...');
    }
    
    // Check what's on the page
    const pageInfo = await page.evaluate(() => {
        return {
            title: document.title,
            hasResults: document.querySelector('.search-results-container, .scaffold-finite-scroll') !== null,
            hasFeed: document.querySelector('.feed-shared-update-v2, #main') !== null,
            bodyPreview: document.body.innerText.substring(0, 300)
        };
    });
    
    logProgress('LinkedIn', `📄 Page title: ${pageInfo.title}`);
    logProgress('LinkedIn', `📊 Has results container: ${pageInfo.hasResults || pageInfo.hasFeed}`);

    if (pageInfo.bodyPreview.includes('No results') || pageInfo.bodyPreview.includes('Try searching for')) {
        logProgress('LinkedIn', '⚠️  No results found for this search query');
    }

    // If we reach here without ANY recognizable container, the browser
    // is on something we don't understand — captcha challenge, expired
    // session redirect, partial render, etc. Save a snapshot so the
    // operator can see "browser is open but I see nothing".
    if (!pageInfo.hasResults && !pageInfo.hasFeed) {
        logProgress('LinkedIn',
            '⚠️  No recognizable LinkedIn container on page — likely a redirect / challenge / login');
        await dumpDebugSnapshot(page, 'no-container');
    }
}

// Save a screenshot + page snapshot of the current LinkedIn state to disk.
// Operator-facing diagnostic for the "browser is open but I can't see anything"
// class of issue — e.g. session expired silently, LinkedIn redirected to a
// security checkpoint, search returned a soft "no results" view, or
// the page got stuck on a loading state.
async function dumpDebugSnapshot(page, label) {
    // Hardened ordering: dump the cheap text artifact (URL/title/body
    // preview) FIRST. On hung pages, page.screenshot() can stall up to
    // 30s waiting for fonts and then time out — operator-visible mini
    // PC log showed exactly this:
    //   "could not write debug snapshot: page.screenshot: Timeout 30000ms
    //    exceeded — waiting for fonts to load"
    // The previous wrapper put both calls in one try-block, so a
    // screenshot timeout also dropped the text dump. Now they're
    // independent: text always lands, screenshot is best-effort with
    // a short timeout.
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'results');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const png = path.join(dir, `linkedin-debug-${label}-${stamp}.png`);
    const txt = path.join(dir, `linkedin-debug-${label}-${stamp}.txt`);

    // 1. Text snapshot — almost always succeeds because evaluate() only
    //    needs the JS context, not a rendered/painted frame. Adds a few
    //    structured signals so the operator can tell "blank page" from
    //    "auth wall" from "captcha" without opening the screenshot.
    let meta = null;
    try {
        meta = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            bodyPreview: (document.body?.innerText || '').slice(0, 1500),
            articles: document.querySelectorAll('article').length,
            feedUpdates: document.querySelectorAll('.feed-shared-update-v2').length,
            authPromptsDetected: /sign in|join now|verify it.s you|something went wrong/i.test(
                document.body?.innerText || '',
            ),
        }));
        fs.writeFileSync(
            txt,
            [
                `url: ${meta.url}`,
                `title: ${meta.title}`,
                `articles: ${meta.articles}`,
                `feedUpdates: ${meta.feedUpdates}`,
                `authPromptsDetected: ${meta.authPromptsDetected}`,
                '',
                '--- visible text (first 1500 chars) ---',
                meta.bodyPreview,
            ].join('\n'),
        );
        logProgress('LinkedIn', `🩺 Debug text:   ${txt}`);
        logProgress('LinkedIn', `   url=${meta.url}`);
        logProgress('LinkedIn', `   title="${meta.title}"`);
        logProgress('LinkedIn',
            `   articles=${meta.articles} feedUpdates=${meta.feedUpdates} ` +
            `authPromptsDetected=${meta.authPromptsDetected}`);
    } catch (err) {
        logProgress('LinkedIn', `   (text dump failed: ${err.message})`);
    }

    // 2. Screenshot — best-effort with a short timeout. Default 30s
    //    waits for fonts and stalls the whole scraper when the page is
    //    on a hung loading state. Cap at 5s; skip fullPage so we don't
    //    pay the layout-stable wait either.
    try {
        await page.screenshot({ path: png, fullPage: false, timeout: 5000 });
        logProgress('LinkedIn', `🩺 Debug screenshot: ${png}`);
    } catch (err) {
        const firstLine = (err.message || '').split('\n')[0];
        logProgress('LinkedIn', `   (screenshot skipped: ${firstLine})`);
    }
}

async function extractPosts(page, maxPosts) {
    logProgress('LinkedIn', `📦 Extracting up to ${maxPosts} posts...`);

    const isFeedMode = CONFIG.useFeedInsteadOfSearch;
    const keywords = CONFIG.searchQuery.toLowerCase().split(' ');

    if (isFeedMode) {
        logProgress('LinkedIn', `   📋 Boolean Query: ${CONFIG.searchQuery}\n`);
    } else {
        logProgress('LinkedIn', '   Note: Only extracting CONTENT posts (not people/jobs/companies)\n');
    }
    
    // Debug: probe the new LinkedIn structure (May 2026+). The legacy
    // class-based selectors (.feed-shared-update-v2, .reusable-search__*,
    // .entity-result) all return 0 on the current DOM. We now key off
    // componentkey attributes — keep the legacy probes here for
    // observability so a future regression jumps out in the logs.
    const debugInfo = await page.evaluate(() => {
        const selectors = {
            // NEW (May 2026+) — what we actually use:
            'main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]':
                document.querySelectorAll('main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]').length,
            'main div[componentkey^="expanded"]':
                document.querySelectorAll('main div[componentkey^="expanded"]').length,
            'main div[componentkey]':
                document.querySelectorAll('main div[componentkey]').length,
            // LEGACY — expected to be 0 now; non-zero means LinkedIn rolled back:
            '.feed-shared-update-v2': document.querySelectorAll('.feed-shared-update-v2').length,
            '[data-urn*="activity:"]': document.querySelectorAll('[data-urn*="activity:"]').length,
            '.reusable-search__result-container': document.querySelectorAll('.reusable-search__result-container').length,
        };

        // Sample HTML from a post container (new selector first, legacy fallback).
        const sampleElement =
            document.querySelector('main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]')
            || document.querySelector('main div[componentkey^="expanded"]')
            || document.querySelector('.feed-shared-update-v2, .reusable-search__result-container');
        const sampleHTML = sampleElement
            ? sampleElement.outerHTML.substring(0, 500)
            : 'No elements found';

        return { selectors, sampleHTML };
    });
    
    logProgress('LinkedIn', '\n🔍 DEBUG INFO - Elements found on page:');
    Object.entries(debugInfo.selectors).forEach(([selector, count]) => {
        logProgress('LinkedIn', `   ${count > 0 ? '✓' : '✗'} ${selector}: ${count}`);
    });
    logProgress('LinkedIn', '\n📄 Sample HTML (first element):');
    logProgress('LinkedIn', 'Sample HTML: ' + debugInfo.sampleHTML.substring(0, 300) + '...\n');
    
    const allPosts = [];
    const seenIds = new Set();
    const seenContentHashes = new Set(); // Track content to avoid duplicates
    let scrollAttempts = 0;
    const maxScrolls = 150;
    let noNewPostsCount = 0;
    
    while (allPosts.length < maxPosts && scrollAttempts < maxScrolls) {
        scrollAttempts++;
        logProgress('LinkedIn', `📜 Scroll ${scrollAttempts}/${maxScrolls} - Posts found: ${allPosts.length}`);
        
        // FIRST: Expand all "see more" buttons in the current viewport
        await page.evaluate(() => {
            // Find and click all "see more" buttons to expand truncated content
            const seeMoreButtons = document.querySelectorAll(
                'button[aria-label*="see more"], ' +
                'button.feed-shared-inline-show-more-text__button, ' +
                '.feed-shared-inline-show-more-text button, ' +
                'button.see-more, ' +
                'button[data-test-id="see-more-button"], ' +
                '.update-components-text__see-more-less-toggle, ' +
                'button.update-components-text__see-more-less-toggle'
            );
            
            seeMoreButtons.forEach(button => {
                try {
                    if (button.offsetParent !== null) { // Check if visible
                        button.click();
                    }
                } catch (e) {
                    // Ignore click errors
                }
            });
        });
        
        // Wait a moment for content to expand
        await randomDelay(500, 800);
        
        // THEN: Extract posts from current viewport
        //
        // LinkedIn rewrote their content-search DOM (verified May 2026):
        //   - `data-urn` / `data-id` attributes: gone
        //   - All `.feed-shared-update-v2` / `.update-components-*` /
        //     `.reusable-search__result-container` class names: gone
        //   - CSS classes are now hashed CSS-module garbage (`_8284c9ef …`)
        //
        // What survives — what we now key off of:
        //   - Post containers are `main div[componentkey^="expanded"]...` —
        //     for content search, each post wrapper carries
        //     componentkey="expanded<HASH>FeedType_FLAGSHIP_SEARCH".
        //     (Confirmed 24 elements / 12 unique posts on a real page.)
        //   - Each post renders TWICE (virtual-scroll buffer), so we
        //     dedupe by the hash inside this evaluate() pass.
        //   - Author profile link: `a[href*="/in/"]` (appears 3× per post).
        //   - Author name: split that link's innerText on " • " (drops the
        //     "• 3rd+" connection-degree suffix).
        //   - Post body text: the full innerText is shaped like
        //       "Feed post {Author} • 3rd+ {tagline} {age} • Follow {body}…"
        //     so a `split(' • Follow ')[1]` gives us a clean body.
        //   - Time-ago is now plain text ("5d", "3h"); no `<time>` element.
        //   - Permalink: not in the card. Selectors targeting
        //     /feed/update/, /posts/, urn:li:activity all return 0. We
        //     leave postUrl empty; downstream code already tolerates it.
        const posts = await page.evaluate((config) => {
            const isSearchPage = window.location.href.includes('/search/results/content/');

            // Primary post-container selector (search page).
            // For non-search pages, fall back to any expanded-prefixed
            // componentkey under <main> (the structure pattern is the
            // same; only the FeedType suffix differs).
            const SEARCH_SELECTOR = 'main div[componentkey^="expanded"][componentkey$="FLAGSHIP_SEARCH"]';
            const FALLBACK_SELECTOR = 'main div[componentkey^="expanded"]';

            let postElements = document.querySelectorAll(
                isSearchPage ? SEARCH_SELECTOR : FALLBACK_SELECTOR
            );
            if (postElements.length === 0) {
                postElements = document.querySelectorAll(FALLBACK_SELECTOR);
            }

            const results = [];
            const debugInfo = { sampleLinks: [], foundIds: [] };
            const seenInRun = new Set(); // per-page dedup (each post renders 2x)

            postElements.forEach((element, index) => {
                try {
                    // Skip job cards (different componentkey naming on those,
                    // but defensive check in case any leak through).
                    if (element.querySelector('a[href*="/jobs/view/"]')) return;

                    // Extract post id from the componentkey attribute.
                    //   expanded<HASH>FeedType_FLAGSHIP_SEARCH  →  <HASH>
                    const compKey = element.getAttribute('componentkey') || '';
                    const postId = compKey
                        .replace(/^expanded/, '')
                        .replace(/FeedType_[A-Z_]+$/, '');
                    if (!postId || seenInRun.has(postId)) return;
                    seenInRun.add(postId);

                    // Debug capture (first hit only)
                    if (index === 0 && results.length === 0) {
                        const sampleLinks = Array.from(element.querySelectorAll('a[href]')).slice(0, 8);
                        debugInfo.sampleLinks = sampleLinks.map(l => l.getAttribute('href'));
                        debugInfo.elementInfo = {
                            componentkey: compKey.slice(0, 100),
                            extractedPostId: postId.slice(0, 40),
                        };
                    }

                    // Author profile link
                    const authorEl = element.querySelector('a[href*="/in/"]');
                    const authorProfileUrl = authorEl ? authorEl.href.split('?')[0] : '';

                    // Author name: prefer the link's text (split off the
                    // "• 3rd+" suffix). If that's empty, fall back to the
                    // "Open control menu for post by X" button's aria-label.
                    let authorName = '';
                    if (authorEl) {
                        const linkText = (authorEl.innerText || '').trim();
                        authorName = linkText.split('•')[0].trim();
                    }
                    if (!authorName) {
                        const ctlBtn = element.querySelector('button[aria-label^="Open control menu for post by"]');
                        if (ctlBtn) {
                            authorName = (ctlBtn.getAttribute('aria-label') || '')
                                .replace(/^Open control menu for post by\s+/i, '')
                                .trim();
                        }
                    }

                    // Body text — split on " • Follow " (the boundary
                    // between the header strip and the user-authored
                    // body). If that pattern's absent, scan for the
                    // longest <span dir="ltr"> / <p> / <div lang> child.
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
                    // Trim trailing engagement noise that follows the body
                    // (likes/comments counters appear after the body in
                    // innerText). Cut at the first " · " separator that's
                    // followed by digits or "Like"/"Comment"/"Repost".
                    postContent = postContent.replace(
                        /\s+(?:Like|Comment|Repost|Send)\s+.*$/s, ''
                    ).trim();

                    // Time-ago: ends the header strip just before " • Follow".
                    // Pattern: "...{tagline} 5d • Follow {body}". Pull the
                    // last \d+[smhdwy] token before the " • Follow " split.
                    let timestamp = '';
                    const headerStrip = followSplit[0] || fullText;
                    const timeMatch = headerStrip.match(/(\d+[smhdwy])\s*$/);
                    if (timeMatch) {
                        timestamp = timeMatch[1];
                    }

                    // Permalink: usually absent in search results, but
                    // try the few selectors that still might catch it.
                    let postUrl = '';
                    const updateLink = element.querySelector(
                        'a[href*="/feed/update/"], a[href*="/posts/"], a[href*="urn:li:activity"]'
                    );
                    if (updateLink?.href) {
                        postUrl = updateLink.href.split('?')[0];
                    }

                    // Track for debug on first successful extraction
                    if (debugInfo.foundIds.length === 0) {
                        debugInfo.foundIds.push({
                            postId: postId.slice(0, 30),
                            hasUrl: !!postUrl,
                            author: authorName,
                            contentLen: postContent.length,
                        });
                    }

                    // Content hash for cross-cycle dedup (the outer scroll
                    // loop dedupes across scroll iterations).
                    const contentHash = postContent.substring(0, 100) + authorName;

                    if (authorName && postContent && postContent.length > 20) {
                        results.push({
                            id: postId,
                            author: authorName,
                            authorProfileUrl,
                            content: postContent,
                            timestamp,
                            postUrl,
                            contentLength: postContent.length,
                            contentHash,
                        });
                    }
                } catch (e) {
                    // Skip invalid posts
                }
            });

            return { results, debugInfo };
        }, CONFIG);
        
        // Log debug info for first scroll
        if (scrollAttempts === 1 && posts.debugInfo) {
            logProgress('LinkedIn', '\n🔍 DEBUG - First post analysis:');
            logProgress('LinkedIn', 'Element info: ' + JSON.stringify(posts.debugInfo.elementInfo));
            logProgress('LinkedIn', '\nSample links from first post:');
            posts.debugInfo.sampleLinks?.forEach((link, i) => {
                logProgress('LinkedIn', `  ${i + 1}. ${link?.substring(0, 80)}`);
            });
            logProgress('LinkedIn', '\nID extraction results: ' + JSON.stringify(posts.debugInfo.foundIds));
            logProgress('LinkedIn', '');
        }
        
        // Use the results array from the returned object
        const extractedPosts = posts.results || posts;
        
        // Add new posts with deduplication
        let newPostsCount = 0;
        extractedPosts.forEach(post => {
            // Check both ID and content hash to avoid duplicates
            const isDuplicateById = seenIds.has(post.id);
            const isDuplicateByContent = seenContentHashes.has(post.contentHash);
            
            // Only add if not duplicate and we haven't reached max
            if (!isDuplicateById && !isDuplicateByContent && allPosts.length < maxPosts) {
                seenIds.add(post.id);
                seenContentHashes.add(post.contentHash);
                
                // Remove contentHash before adding to final results
                const { contentHash, ...postWithoutHash } = post;
                allPosts.push(postWithoutHash);
                newPostsCount++;
            }
        });
        
        if (newPostsCount > 0) {
            logProgress('LinkedIn', `   ✓ Found ${newPostsCount} new posts (total: ${allPosts.length})`);
            // Log sample URLs from first post
            if (allPosts.length === newPostsCount) {
                const firstPost = allPosts[0];
                logProgress('LinkedIn', `   📎 Sample URLs:`);
                logProgress('LinkedIn', `      Author: ${firstPost.authorProfileUrl ? '✓' : '✗'} ${firstPost.authorProfileUrl || 'Not found'}`);
                logProgress('LinkedIn', `      Post: ${firstPost.postUrl ? '✓' : '✗'} ${firstPost.postUrl || 'Not found'}`);
            }
            noNewPostsCount = 0;
        } else {
            noNewPostsCount++;
            logProgress('LinkedIn', `   ⚠️  No new posts found (${noNewPostsCount} scrolls without new content)`);
        }

        // Stop if no new posts for 5 consecutive scrolls (was 15 — wasted
        // 30-45s scrolling when LinkedIn had genuinely run out of results
        // for the boolean query).
        if (noNewPostsCount >= 5) {
            logProgress('LinkedIn', '   ℹ️  No new posts for 5 scrolls, stopping...');
            break;
        }

        // Scroll to the BOTTOM of the document, not just down by 500px.
        // LinkedIn's infinite-scroll observer fires when the user reaches
        // the bottom of the rendered list. Incremental scrollBy() leaves a
        // gap below the loaded posts, so the observer never trips and no
        // new content loads — the symptom user sees is "scrolls forever
        // without extracting more". scrollHeight grows as new posts load,
        // so calling this each iteration keeps pushing past whatever's
        // already rendered.
        await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
        });

        await randomDelay(CONFIG.scrollDelay, CONFIG.scrollDelay + 1000);
    }

    if (allPosts.length === 0) {
        logProgress('LinkedIn', '\n⚠️  WARNING: No posts extracted!');
        logProgress('LinkedIn', '   This could mean:');
        logProgress('LinkedIn', '   1. Not on content search results page');
        logProgress('LinkedIn', '   2. LinkedIn changed their HTML structure');
        logProgress('LinkedIn', '   3. No results for this search query');
        logProgress('LinkedIn', '   4. Content is not loading (check browser window)');
        logProgress('LinkedIn', '   5. Session may have expired silently — re-run npm run chrome:login');
        // Save what the browser is actually showing so the operator can
        // see "blank window" vs "captcha challenge" vs "session expired".
        await dumpDebugSnapshot(page, 'no-posts');
    } else if (allPosts.length < 5) {
        // Suspiciously few results — also dump so we can diagnose whether
        // LinkedIn truly has only a handful matching the query, or whether
        // we're stuck on a partial render / soft block.
        logProgress('LinkedIn', `   (only ${allPosts.length} posts — saving debug snapshot for review)`);
        await dumpDebugSnapshot(page, 'few-posts');
    }

    return allPosts;
}

async function analyzePosts(posts) {
    logProgress('LinkedIn', '\n📊 Analyzing posts...');
    
    const jobPosts = posts.filter(post => {
        const content = post.content.toLowerCase();
        const isJobRelated = 
            content.includes('hiring') ||
            content.includes('job') ||
            content.includes('position') ||
            content.includes('looking for') ||
            content.includes('join our team') ||
            content.includes('apply') ||
            content.includes('engineer') ||
            content.includes('developer');
        
        return isJobRelated;
    });
    
    logProgress('LinkedIn', `✅ Total posts extracted: ${posts.length}`);
    logProgress('LinkedIn', `✅ Job-related posts: ${jobPosts.length}`);
    logProgress('LinkedIn', `✅ Other posts: ${posts.length - jobPosts.length}`);
    
    return {
        all: posts,
        jobRelated: jobPosts
    };
}



// Export function for UnifiedJobScraper
//
// `options.searchQueries` (optional) is an array of pre-built LinkedIn
// boolean search queries — typically 3 AI-generated variants supplied by
// the backend's AIRoleNormalizationService and shipped through the queue
// payload. When present, each query is run sequentially against the
// same Chrome session and results are deduplicated by post id, raising
// recall on niche roles (the legacy single-template was empirically
// returning zero on ~43% of niche queries). When absent, falls back
// to the legacy single-template `"<role>" AND (c2c OR W2 OR 1099)`.
export async function scrapeLinkedIn(jobTitle, location, sessionId = null, options = {}) {
    logProgress('LinkedIn', '🚀 LinkedIn Post Scraper (CDP Method)\n');
    logProgress('LinkedIn', '='.repeat(50));

    // Override CONFIG with parameters (location is ignored, search uses only jobTitle)
    CONFIG.jobTitle = jobTitle;

    // Build the query list. Prefer caller-supplied AI variants; fall
    // back to the legacy single boolean template.
    const aiQueries = Array.isArray(options.searchQueries) && options.searchQueries.length > 0
        ? options.searchQueries
        : null;
    const queriesToRun = aiQueries || [buildBooleanSearchQuery(jobTitle)];
    CONFIG.searchQuery = queriesToRun[0]; // for downstream compatibility (logs, dumpDebugSnapshot)

    logProgress('LinkedIn', `   Job Title: "${jobTitle}"`);
    if (aiQueries) {
        logProgress('LinkedIn', `   Using ${queriesToRun.length} AI-generated query variant(s):`);
        queriesToRun.forEach((q, i) => logProgress('LinkedIn', `      [${i + 1}] ${q}`));
    } else {
        logProgress('LinkedIn', `   Boolean Query (legacy template): ${CONFIG.searchQuery}\n`);
    }
    
    const apiClient = getCredentialsAPIClient();
    const maxAttempts = 3;
    let attemptCount = 0;
    let lastError = null;
    
    // Retry loop: Try up to maxAttempts credentials
    while (attemptCount < maxAttempts) {
        attemptCount++;
        
        // Fetch credentials from API with wait-and-retry logic
        logProgress('LinkedIn', `\n🔑 Attempting to fetch credential (attempt ${attemptCount}/${maxAttempts})...`);
        
        let credential = null;
        const maxCredentialRetries = 10; // Wait for credentials up to 10 times
        const credentialRetryDelay = 60000; // 60 seconds between retries
        
        for (let credRetry = 0; credRetry < maxCredentialRetries; credRetry++) {
            credential = await apiClient.getCredential('linkedin', sessionId);
            
            if (credential) {
                // Got a credential, break out of retry loop
                break;
            }
            
            if (credRetry < maxCredentialRetries - 1) {
                logProgress('LinkedIn', `⏳ No credentials available, waiting ${credentialRetryDelay/1000}s before retry ${credRetry + 1}/${maxCredentialRetries}...`);
                await new Promise(resolve => setTimeout(resolve, credentialRetryDelay));
            }
        }
        
        if (!credential) {
            logProgress('LinkedIn', `⚠️  No LinkedIn credentials available after ${maxCredentialRetries} retries`);
            if (lastError) {
                throw lastError;
            }
            throw new Error('No LinkedIn credentials available from API');
        }
        
        // Print credential info (mask password)
        logProgress('LinkedIn', `✅ Credential fetched:`);
        logProgress('LinkedIn', `   📧 Email: ${credential.email}`);
        logProgress('LinkedIn', `   🔒 Password: ${'*'.repeat(credential.password?.length || 8)}`);
        logProgress('LinkedIn', `   🆔 Credential ID: ${credential.id}`);
        
        CONFIG.email = credential.email;
        CONFIG.password = credential.password;
        CONFIG.credentialId = credential.id;
        
        let browser;
        let loginSuccess = false;
    
    try {
        // Connect to existing Chrome
        browser = await connectToChrome();
        
        // Get the default context (user's real browser context)
        const contexts = browser.contexts();
        if (contexts.length === 0) {
            throw new Error('No browser contexts found. Make sure Chrome is running with the debug flag.');
        }
        
        const context = contexts[0];
        const pages = context.pages();
        
        // Use existing page or create new one
        let page;
        if (pages.length > 0) {
            page = pages[0];
            logProgress('LinkedIn', '📄 Using existing tab');
        } else {
            page = await context.newPage();
            logProgress('LinkedIn', '📄 Created new tab');
        }
        
        // Run each query sequentially against the same Chrome session,
        // accumulating posts with cross-query dedup by post id (LinkedIn
        // activity URN — already unique). Inter-query delay so we don't
        // burn LinkedIn's rate limit when running 3 searches in a row.
        const seenIdsAcrossQueries = new Set();
        const posts = [];
        const perQueryYield = []; // [{ query, queryIndex, found, added }]

        for (let qi = 0; qi < queriesToRun.length; qi++) {
            if (posts.length >= CONFIG.maxPosts) {
                logProgress('LinkedIn',
                    `🛑 Reached maxPosts=${CONFIG.maxPosts}; skipping remaining ${queriesToRun.length - qi} query(ies).`);
                break;
            }

            const q = queriesToRun[qi];
            CONFIG.searchQuery = q;
            if (qi > 0) {
                // 8-12s buffer between queries — empirically enough to
                // avoid LinkedIn's "you're searching too fast" throttle
                // on the same logged-in session.
                logProgress('LinkedIn', `\n⏳ Inter-query delay before query [${qi + 1}/${queriesToRun.length}]...`);
                await randomDelay(8000, 12000);
            }
            logProgress('LinkedIn',
                `\n🔎 Query [${qi + 1}/${queriesToRun.length}]: ${q}`);

            await navigateToSearch(page, q);
            const remainingBudget = CONFIG.maxPosts - posts.length;
            const queryPosts = await extractPosts(page, remainingBudget);

            // Dedup by id — same post can match multiple queries.
            // Tag with the query that found it for downstream tracing.
            let added = 0;
            for (const p of queryPosts) {
                if (p.id && seenIdsAcrossQueries.has(p.id)) continue;
                if (p.id) seenIdsAcrossQueries.add(p.id);
                posts.push({ ...p, queryUsed: q, queryIndex: qi });
                added++;
                if (posts.length >= CONFIG.maxPosts) break;
            }
            perQueryYield.push({ query: q, queryIndex: qi, found: queryPosts.length, added });
            logProgress('LinkedIn',
                `   query [${qi + 1}] → found ${queryPosts.length}, ${added} new (running total: ${posts.length})`);
        }

        logProgress('LinkedIn', '\n📊 Per-query yield:');
        const metrics = getMetrics();
        perQueryYield.forEach(({ queryIndex, found, added }) => {
            logProgress('LinkedIn', `   [${queryIndex + 1}] found=${found}, added=${added}`);
            metrics.recordLinkedInQueryYield(queryIndex, added);
        });

        // Analyze posts
        const analyzed = await analyzePosts(posts);

        logProgress('LinkedIn', '\n✨ Scraping completed successfully!');
        logProgress('LinkedIn', `📊 Found ${analyzed.jobRelated.length} job-related posts`);
        
        // Helper: hash string for fallback jobId
        function hashString(str) {
            let hash = 5381;
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) + hash) + str.charCodeAt(i);
            }
            return 'h' + (hash >>> 0).toString(36);
        }

        // Helper: parse ISO date or return undefined
        function parseISODate(val) {
            if (!val) return undefined;
            // Accept ISO or YYYY-MM-DD
            if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val;
            // Try to parse relative dates (e.g., '2d ago') as today
            if (/ago$/.test(val)) return new Date().toISOString().slice(0, 10);
            return undefined;
        }

        // Helper: Clean text - remove extra whitespace, newlines, special characters
        function cleanText(text) {
            if (!text) return '';
            return text
                .replace(/\s+/g, ' ')  // Replace multiple whitespace with single space
                .replace(/[\r\n\t]/g, ' ')  // Replace newlines and tabs with space
                .replace(/[^\x20-\x7E]/g, '')  // Remove non-printable characters
                .trim();
        }

        const normalizedPosts = analyzed.all.map(post => {
            // Required fields: title, company, location, description, job_url, external_job_id
            
            // Extract clean company name from author (remove LinkedIn badges and extra text)
            let companyName = cleanText(post.author || '');
            
            // Remove LinkedIn badge indicators like "• 1st", "• 2nd", "• 3rd+", "Premium", "Follows"
            companyName = companyName
                .replace(/\s*•\s*(1st|2nd|3rd\+?|Premium|Follows?)\s*/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            
            // Handle duplicated names (sometimes LinkedIn duplicates the author name)
            // If the name appears twice with possible whitespace between, take only the first occurrence
            const nameParts = companyName.split(/\s+/);
            if (nameParts.length > 2) {
                // Check if first half equals second half (duplicated)
                const mid = Math.floor(nameParts.length / 2);
                const firstHalf = nameParts.slice(0, mid).join(' ');
                const secondHalf = nameParts.slice(mid).join(' ');
                if (firstHalf === secondHalf || secondHalf.startsWith(firstHalf)) {
                    companyName = firstHalf;
                }
            }
            
            // Final cleanup
            companyName = companyName.trim();
            if (!companyName) companyName = 'LinkedIn Post Author';
            
            // Clean title - use first 200 chars of content (not truncated)
            let title = cleanText(post.content || '').substring(0, 200);
            if (!title) title = 'LinkedIn Job Post';
            
            // Clean description
            const desc = cleanText(post.content || '') || 'N/A';
            
            // Job URL - use post URL or author profile as fallback
            const url = (post.postUrl || post.authorProfileUrl || '').trim() || '';
            
            // Generate unique job ID
            let jobId = post.id;
            if (!jobId || typeof jobId !== 'string' || jobId.length > 40) {
                jobId = url ? hashString(url) : hashString(title + companyName + location);
            }
            const postedDate = parseISODate(post.timestamp);

            const jobObj = {
                title,
                company: companyName,
                location: location || '',
                description: desc,
                url,
                jobId,
                postId: post.id,
                activityUrn: post.activityUrn,
                author: post.author,
                authorProfile: post.authorProfileUrl,
                timestamp: post.timestamp,
                engagement: post.engagement,
                isJobRelated: post.isJobRelated,
                // Pass through which AI search-query variant produced
                // this post — useful downstream for measuring per-query
                // yield and for tuning the prompt.
                queryUsed: post.queryUsed,
                queryIndex: post.queryIndex,
            };
            if (postedDate) jobObj.postedDate = postedDate;
            return normalizeJobData(jobObj, 'LinkedIn');
        });

        // Report success to API
        loginSuccess = true;
        await apiClient.reportSuccess('linkedin', `Scraped ${normalizedPosts.length} posts successfully`);

        return normalizedPosts;
        
    } catch (error) {
        logProgress('LinkedIn', '\n❌ Error: ' + error.message);
        logProgress('LinkedIn', 'Stack trace: ' + error.stack);
        
        lastError = error;
        
        // Report failure to API
        if (!loginSuccess) {
            // Login or authentication failure - try next credential
            if (error.message.includes('Login failed') || error.message.includes('credentials') || error.message.includes('waitForSelector')) {
                logProgress('LinkedIn', '🔄 Login/navigation failed - will try next credential...');
                logProgress('LinkedIn', '📤 Notifying system: WRONG CREDENTIALS (permanent failure)');
                await apiClient.reportFailure('linkedin', `Login failed: ${error.message}`, 0);
            } else if (error.message.includes('rate limit') || error.message.includes('challenge')) {
                logProgress('LinkedIn', '⏳ Rate limited - will try next credential...');
                logProgress('LinkedIn', '📤 Notifying system: RATE LIMIT (60 min cooldown)');
                await apiClient.reportFailure('linkedin', `Rate limited or challenge: ${error.message}`, 60);
            } else {
                // Any other error during login/setup phase - treat as credential failure
                logProgress('LinkedIn', '⚠️  Credential error - will try next credential...');
                logProgress('LinkedIn', `   Error details: ${error.message}`);
                logProgress('LinkedIn', '📤 Notifying system: CREDENTIAL ERROR (permanent failure)');
                await apiClient.reportFailure('linkedin', `Credential error: ${error.message}`, 0);
            }
            // Continue to next credential attempt - no throw, let loop continue
        } else {
            // If login was successful but scraping failed, still try next credential
            logProgress('LinkedIn', '⚠️  Scraping error after login - will try next credential...');
            logProgress('LinkedIn', '📤 Notifying system: SCRAPING ERROR (30 min cooldown)');
            await apiClient.reportFailure('linkedin', `Scraping error: ${error.message}`, 30);
        }
        
    } finally {
        if (browser) {
            logProgress('LinkedIn', '🔌 Closing Chrome browser...');
            try {
                // Get all contexts and close all pages before disconnecting
                const contexts = browser.contexts();
                for (const context of contexts) {
                    await context.close();
                }
                await browser.close();
            } catch (closeError) {
                logProgress('LinkedIn', `⚠️  Error closing browser: ${closeError.message}`);
            }
        }
    }
    } // End of while loop
    
    // If we exhausted all attempts, throw the last error
    logProgress('LinkedIn', `\n❌ All ${maxAttempts} credential attempts failed`);
    throw lastError || new Error('All LinkedIn credential attempts failed');
}


