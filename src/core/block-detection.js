// Centralized block / challenge / interstitial detection.
//
// Spec F3 + F11: detection uses STRUCTURAL signals — HTTP status, final
// URL path, page <title>, and specific stable vendor markers — never
// fuzzy substring matching of arbitrary visible body text (the old
// probe's first-600-chars `.includes()` produced false pos/neg).
//
// Pure and side-effect free: callers collect page facts and pass them
// in, so this is trivially unit-testable and has no I/O.

import { BlockedError } from './errors.js';

// Vendor-specific tokens that only appear on challenge documents.
const CLOUDFLARE_MARKERS = [
    'cf-chl-', 'challenge-platform', 'cdn-cgi/challenge-platform',
    '__cf_chl', 'cf-browser-verification',
];
const DATADOME_MARKERS = [
    'captcha-delivery.com', 'geo.captcha-delivery', 'js.datadome.co', 'dd-captcha',
];

// URL path fragments meaning "not on a content page".
const BLOCK_URL_FRAGMENTS = [
    '/checkpoint/', '/authwall', '/uas/login', '/account/login',
    '/captcha/', '/challenge/',
];

// <title> phrases used by Cloudflare / DataDome / Indeed / generic WAFs.
const BLOCK_TITLE_RES = [
    /just a moment/i,
    /attention required/i,
    /access denied/i,
    /additional verification required/i,
    /verify you are (?:a )?human/i,
    /security check/i,
    /are you a robot/i,
];

function lowerHay(...parts) {
    return parts.filter(Boolean).join('  ').toLowerCase();
}

/**
 * @param {object} input
 * @param {number|null} [input.status]   main navigation HTTP status
 * @param {string|null} [input.finalUrl] URL after redirects
 * @param {string|null} [input.title]    document.title
 * @param {string|null} [input.bodyText] visible text (optional)
 * @param {string|null} [input.html]     raw HTML (optional)
 * @param {string|null} [input.platform] platform name (for thrown error)
 * @returns {{blocked: boolean, kind: string|null, signal: string|null}}
 */
export function detectBlock(input = {}) {
    const status = input.status ?? null;
    const finalUrl = input.finalUrl ?? '';
    const title = input.title ?? '';
    const markerHay = lowerHay(finalUrl, input.html, input.bodyText);

    if (status === 429) {
        return { blocked: true, kind: 'rate_limited', signal: `HTTP ${status}` };
    }
    if (status === 401 || status === 403) {
        return { blocked: true, kind: 'http_forbidden', signal: `HTTP ${status}` };
    }

    for (const m of DATADOME_MARKERS) {
        if (markerHay.includes(m)) {
            return { blocked: true, kind: 'datadome', signal: `datadome:${m}` };
        }
    }
    for (const m of CLOUDFLARE_MARKERS) {
        if (markerHay.includes(m)) {
            return { blocked: true, kind: 'cloudflare', signal: `cloudflare:${m}` };
        }
    }

    const urlLower = finalUrl.toLowerCase();
    for (const frag of BLOCK_URL_FRAGMENTS) {
        if (urlLower.includes(frag)) {
            return { blocked: true, kind: 'auth_wall', signal: `url:${frag}` };
        }
    }

    for (const re of BLOCK_TITLE_RES) {
        if (re.test(title)) {
            return {
                blocked: true,
                kind: 'challenge_page',
                signal: `title:${title.slice(0, 80)}`,
            };
        }
    }

    return { blocked: false, kind: null, signal: null };
}

/**
 * Throws BlockedError when detectBlock() reports a block; no-op otherwise.
 * @param {object} input same shape as detectBlock(input)
 */
export function assertNotBlocked(input = {}) {
    const r = detectBlock(input);
    if (r.blocked) {
        throw new BlockedError(
            `Blocked on ${input.platform ?? 'unknown'}: ${r.signal}`,
            { kind: r.kind, platform: input.platform ?? null },
        );
    }
}
