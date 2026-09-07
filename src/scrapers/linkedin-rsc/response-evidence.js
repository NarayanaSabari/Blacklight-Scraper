// Response metadata is an allowlist, never a dump of remote headers or content.
const CONTENT_TYPES = new Set(['text/x-component', 'application/json', 'text/html',
    'text/plain', 'application/octet-stream']);
const DESTINATIONS = new Set(['login', 'checkpoint', 'search', 'other']);

function destination(url) {
    try {
        const pathname = new URL(url).pathname;
        if (/^\/(?:login|uas\/login|authwall)(?:\/|$)/i.test(pathname)) return 'login';
        if (/^\/checkpoint(?:\/|$)/i.test(pathname)) return 'checkpoint';
        if (/^\/search(?:\/|$)/i.test(pathname)
            || pathname === '/flagship-web/rsc-action/actions/pagination') return 'search';
    } catch { /* Missing or invalid response URL carries no classification. */ }
    return 'other';
}

export function responseEvidence(response) {
    const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const redirectStatus = response.status >= 300 && response.status < 400;
    let target = response.url;
    if (redirectStatus) {
        try { target = new URL(response.headers?.get?.('location'), response.url).href; }
        catch { target = null; }
    }
    return { status: response.status,
        contentType: contentType ? (CONTENT_TYPES.has(contentType) ? contentType : 'other') : null,
        redirected: response.redirected === true || redirectStatus,
        destination: destination(target), bodyBytes: null, bodySha256: null };
}

function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

// Re-select at the diagnostic boundary as errors may originate in other callers.
// Ten pages cover the normal walk and bound retained evidence even for bad input.
export function diagnosticPages(pages) {
    if (!Array.isArray(pages)) return [];
    return pages.slice(-10).map((page) => {
        const result = {};
        for (const key of ['page', 'start_index', 'bytes', 'latency_ms', 'posts_added']) {
            if (nonnegative(page?.[key]) !== null) result[key] = page[key];
        }
        const response = page?.response;
        if (response && typeof response === 'object') {
            result.response = {
                status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
                contentType: CONTENT_TYPES.has(response.contentType) ? response.contentType : response.contentType === null ? null : 'other',
                redirected: response.redirected === true,
                destination: DESTINATIONS.has(response.destination) ? response.destination : 'other',
                bodyBytes: nonnegative(response.bodyBytes),
                bodySha256: typeof response.bodySha256 === 'string' && /^[a-f0-9]{64}$/.test(response.bodySha256) ? response.bodySha256 : null,
            };
            if (typeof response.noResultsSignal === 'boolean') result.response.noResultsSignal = response.noResultsSignal;
        }
        return result;
    });
}
