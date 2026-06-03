// Classifies an outbound job URL at the BaseScraper output seam. Mirrors
// scrapers/linkedin.js::postSourceUrl's "/in/ is never a job URL" rule, with
// a generic permalink pattern that also matches Indeed/Dice job pages.

const PERMALINK_RE = /\/feed\/update\/|\/posts\/|\/jobs\/view\/|\/jobs?\/[a-z0-9-]+\/?$/i;

export function classifyUrl(url) {
    if (url === null || url === undefined || url === '') return 'empty';
    const s = String(url);
    if (!s) return 'empty';
    if (s.includes('/in/')) return 'profile_in';
    if (PERMALINK_RE.test(s)) return 'permalink';
    return 'other';
}
