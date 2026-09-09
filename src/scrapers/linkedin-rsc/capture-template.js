// Capture the LinkedIn content-search pagination request template.
//
// Extracted from scripts/linkedin-rsc-template.js so the DAEMON can re-capture
// on its own when the template goes stale, rather than requiring an operator to
// notice and run a script. Both callers share this one implementation: a
// divergence between "what the script captures" and "what the daemon captures"
// would be invisible until the next outage.
//
// This is the only code path that drives a browser against LinkedIn for the RSC
// transport. Everything else is plain HTTP.

import fs from 'fs';
import path from 'path';
import { createLogger } from '../../logger/index.js';
import { launchPersistentProfile } from '../../core/linkedin-browser.js';
import { AuthError } from '../../core/errors.js';

const log = createLogger('linkedin-rsc:capture');

const PAGINATION_RE = /rsc-action\/actions\/pagination/;
const CONTENT_SEARCH_RE = /contentSearchResults/;

// Broad enough to reliably HAVE results: pagination only fires when there is a
// second page to ask for, so a niche query can fail to produce a template at
// all. Overridable for the rare case where even this returns nothing.
export const DEFAULT_PROBE_QUERY = process.env.RSC_TEMPLATE_QUERY || 'data engineer';

const SETTLE_MS = 6000;
const SCROLL_TRIES = 6;
const SCROLL_PAUSE_MS = 3000;

// Session state and hop-by-hop headers: never persisted. Cookies and the CSRF
// token are derived per-request from the live jar, so the file on disk holds no
// credentials and is safe to leave in place.
const STRIP_HEADER = /^(cookie|csrf-token|authorization|content-length|host|connection|accept-encoding)$/i;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sanitizeHeaders(headers) {
    const kept = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (STRIP_HEADER.test(name)) continue;
        kept[name] = value;
    }
    return kept;
}

/**
 * Drive a real browser session to capture a fresh pagination template.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.outPath]   where to write; omit to skip writing
 * @param {string}   [opts.query]     probe query
 * @param {Function} [opts.launch]    injected for tests
 * @returns {Promise<object|null>} the captured template, or null if none was seen
 * @throws {AuthError} when the profile is not logged in
 */
export async function captureTemplate({
    outPath = null,
    query = DEFAULT_PROBE_QUERY,
    launch = launchPersistentProfile,
    profileKey = null,
} = {}) {
    const context = await launch({ profileKey });
    let captured = null;

    // Listen on the CONTEXT, not the page: the pagination request can be issued
    // from a worker or a prefetch that a page-scoped listener would miss.
    context.on('request', (req) => {
        if (captured) return;
        const url = req.url();
        if (!PAGINATION_RE.test(url) || !CONTENT_SEARCH_RE.test(url)) return;
        captured = { url, headers: req.headers(), postData: req.postData() };
    });

    try {
        const jar = await context.cookies();
        if (!jar.some((c) => c.name === 'li_at')) {
            throw new AuthError(
                'Cannot capture an RSC template: this profile is not logged in (no li_at)',
                { platform: 'linkedin', code: 'NEEDS_RELOGIN' },
            );
        }

        const page = await context.newPage();
        const searchUrl = 'https://www.linkedin.com/search/results/content/'
            + `?datePosted=${encodeURIComponent('["past-24h"]')}`
            + `&keywords=${encodeURIComponent(query)}&origin=FACETED_SEARCH`;

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
            await wait(SCROLL_PAUSE_MS);
        }

        if (!captured?.postData) {
            log.warn('No pagination request observed — template not captured', { query });
            return null;
        }

        const template = {
            url: captured.url,
            headers: sanitizeHeaders(captured.headers),
            postData: captured.postData,
            capturedAt: new Date().toISOString(),
        };

        if (outPath) {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            // Write-then-rename: a crash mid-write must not leave a truncated
            // template on disk, which would fail to parse on the next boot and
            // take the platform down for a reason unrelated to LinkedIn.
            const tmp = `${outPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(template, null, 2));
            fs.renameSync(tmp, outPath);
        }

        return template;
    } finally {
        await context.close().catch(() => {});
    }
}
