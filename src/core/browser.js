// Playwright launch helpers with guaranteed cleanup.
//
// Every scraper that uses Playwright should go through withBrowser() so that
// a thrown exception anywhere in the callback still closes the browser.
// Previously, several scrapers leaked browser processes on error paths.

import { chromium as chromiumCore } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { DEFAULT_USER_AGENT, DEFAULT_VIEWPORT } from './fingerprints.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('browser');

let stealthApplied = false;
function getStealthChromium() {
    if (!stealthApplied) {
        chromiumExtra.use(StealthPlugin());
        stealthApplied = true;
    }
    return chromiumExtra;
}

const DEFAULT_LAUNCH_ARGS = Object.freeze([
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
]);

export async function launchBrowser({ stealth = false, headless = true, args = [] } = {}) {
    const driver = stealth ? getStealthChromium() : chromiumCore;
    return driver.launch({
        headless,
        args: [...DEFAULT_LAUNCH_ARGS, ...args],
    });
}

export async function newDefaultContext(browser, overrides = {}) {
    return browser.newContext({
        userAgent: DEFAULT_USER_AGENT,
        viewport: DEFAULT_VIEWPORT,
        ...overrides,
    });
}

/**
 * Run a callback with a Playwright browser, closing it no matter what.
 * Also closes any contexts the caller pushes into the `contexts` array.
 *
 * @template T
 * @param {(ctx: {browser: import('playwright').Browser, contexts: Array<import('playwright').BrowserContext>}) => Promise<T>} callback
 * @param {{stealth?: boolean, headless?: boolean, launchArgs?: Array<string>}} [opts]
 * @returns {Promise<T>}
 */
export async function withBrowser(callback, opts = {}) {
    const browser = await launchBrowser({
        stealth: opts.stealth ?? false,
        headless: opts.headless ?? true,
        args: opts.launchArgs ?? [],
    });
    const contexts = [];
    try {
        return await callback({ browser, contexts });
    } finally {
        for (const ctx of contexts) {
            try { await ctx.close(); } catch (err) {
                log.warn('Failed to close context during cleanup', { err: err.message });
            }
        }
        try { await browser.close(); } catch (err) {
            log.warn('Failed to close browser during cleanup', { err: err.message });
        }
    }
}
