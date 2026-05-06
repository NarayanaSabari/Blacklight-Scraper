// Cookie loading — previously duplicated in scrapers/glassdoor.js and scrapers/indeed.js.
// Accepts a credential object (from API or local credentials.json) in any of
// the historical shapes and returns a Playwright-compatible cookie array.

function mapSameSite(value) {
    switch (value) {
        case 'no_restriction': return 'None';
        case 'unspecified':
        case 'lax':
            return 'Lax';
        case 'strict': return 'Strict';
        default: return value || 'Lax';
    }
}

function mapApiCookies(cookieArray) {
    return cookieArray.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        httpOnly: cookie.httpOnly || false,
        secure: cookie.secure || false,
        sameSite: mapSameSite(cookie.sameSite),
        expires: cookie.expirationDate ? Math.floor(cookie.expirationDate) : undefined,
    }));
}

function mapCookieString(cookieString, defaultDomain) {
    return cookieString
        .split(';')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
            const idx = pair.indexOf('=');
            const name = idx >= 0 ? pair.slice(0, idx).trim() : pair;
            const value = idx >= 0 ? pair.slice(idx + 1).trim() : '';
            return {
                name,
                value,
                domain: defaultDomain,
                path: '/',
                httpOnly: false,
                secure: true,
                sameSite: 'Lax',
            };
        });
}

/**
 * Normalise a credential payload into Playwright cookies.
 * Supported shapes:
 *  1. { credentials: [ {name, value, domain, ...}, ... ] }            (API default)
 *  2. { credentials: { cookie: "a=b; c=d", csrf_token: "..." } }      (legacy)
 *  3. { cookies: [...] }                                              (alt)
 *
 * @param {object} credential
 * @param {string} [defaultDomain] - used only for legacy cookie-string form
 * @returns {Array<object>} Playwright cookies
 */
export function loadCookies(credential, defaultDomain = '') {
    if (!credential) return [];

    // Shape 1 + 2: credential.credentials
    if (credential.credentials) {
        if (Array.isArray(credential.credentials)) {
            return mapApiCookies(credential.credentials);
        }
        if (typeof credential.credentials === 'object' && credential.credentials.cookie) {
            return mapCookieString(credential.credentials.cookie, defaultDomain);
        }
    }

    // Shape 3: credential.cookies already in Playwright format
    if (Array.isArray(credential.cookies)) return credential.cookies;

    return [];
}
