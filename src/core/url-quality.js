// Classifies an outbound job URL at the BaseScraper output seam, and flags a
// platform-level degradation when too many of one scrape's URLs come back
// empty at once. Mirrors LinkedIn's "/in/ is never a job URL" rule, with a
// generic permalink pattern that also matches Indeed/Dice job pages.
//
// 2026-08-20: scraper_url_quality_total{platform="linkedin",quality="empty"}
// read 6148/6148 for every LinkedIn job ever emitted. The permalinks were
// fine - a spooled prod payload showed a correct one on a job that had
// already reached the backend - but the classifier was reading `job.url`,
// while normalizeJobData() (src/core/normalize.js) nests every wire field
// under `job.job`. classifyUrl(undefined) is always 'empty', on EVERY
// platform this runs on, not just LinkedIn, because every scraper funnels
// through normalizeJobData(). That made the metric a permanent false
// positive, which is exactly why nobody trusted or alerted on it - and a
// REAL extractor break (a genuine 100% empty scrape) would have looked
// byte-for-byte identical on the dashboard. See evaluateUrlQuality below for
// the guard that now exists because of that.

const PERMALINK_RE = /\/feed\/update\/|\/posts\/|\/jobs\/view\/|\/job-openings\/|\/jobs?\/[a-z0-9-]+\/?$/i;

// coreJob() (normalize.js) defaults a missing url to the literal string
// 'N/A' rather than leaving it null/empty, so 'N/A' has to count as "no url"
// here too - otherwise every normalized job with no source url silently
// misreads as 'other' (a real-but-uninteresting URL) instead of 'empty'.
const MISSING_VALUES = new Set([null, undefined, '', 'N/A']);

export function classifyUrl(url) {
    if (MISSING_VALUES.has(url)) return 'empty';
    const s = String(url);
    if (!s) return 'empty';
    if (s.includes('/in/')) return 'profile_in';
    if (PERMALINK_RE.test(s)) return 'permalink';
    return 'other';
}

// Below this many jobs in one scrape, an empty-URL ratio isn't meaningful -
// a narrow role-sweep query genuinely nets single-digit results, and one
// missing URL out of three jobs is routine, not a broken extractor.
export const URL_QUALITY_MIN_SAMPLE = 5;

// At/above this fraction of a scrape's jobs carrying no URL, treat it as a
// broken extractor rather than routine thin data. The 2026-08-20 incident was
// 100% (6148/6148) on every single session; this sits well below that so a
// real break is caught on the first degraded scrape rather than requiring
// total, sustained failure to notice.
export const URL_QUALITY_EMPTY_RATIO_ALERT = 0.5;

/**
 * Evaluate one scrape's classified URLs for a silent extraction break.
 *
 * Deliberately scoped to a single scrape's own batch, not a rolling counter
 * across sessions - the ratio has to describe "this extractor run", not blend
 * a broken run in with healthy ones on either side of it.
 *
 * @param {string[]} qualities classifyUrl() results for one scrape's jobs
 * @returns {{jobCount: number, emptyCount: number, emptyRatio: number, degraded: boolean}}
 */
export function evaluateUrlQuality(qualities) {
    const jobCount = qualities.length;
    const emptyCount = qualities.filter((q) => q === 'empty').length;
    const emptyRatio = jobCount === 0 ? 0 : emptyCount / jobCount;
    const degraded = jobCount >= URL_QUALITY_MIN_SAMPLE && emptyRatio >= URL_QUALITY_EMPTY_RATIO_ALERT;
    return { jobCount, emptyCount, emptyRatio, degraded };
}
