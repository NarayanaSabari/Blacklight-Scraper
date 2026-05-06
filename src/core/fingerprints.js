// Shared browser fingerprints — previously duplicated across
// scrapers/glassdoor.js and scrapers/indeed.js.

export const FINGERPRINTS = Object.freeze([
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: Object.freeze({ width: 1366, height: 768 }),
        locale: 'en-US',
        timezone: 'America/New_York',
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        viewport: Object.freeze({ width: 1920, height: 1080 }),
        locale: 'en-GB',
        timezone: 'Europe/London',
    }),
]);

export const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const DEFAULT_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });

export function randomFingerprint() {
    return FINGERPRINTS[Math.floor(Math.random() * FINGERPRINTS.length)];
}
