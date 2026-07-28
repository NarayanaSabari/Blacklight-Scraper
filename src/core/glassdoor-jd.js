// Glassdoor job-description-page parsing, shared by the browser scraper
// (scrapers/glassdoor.js) and the API scraper's description enrichment
// (scrapers/glassdoor-api.js). Kept dependency-free of both of those modules
// so neither creates a circular import.
import * as cheerio from 'cheerio';

// Extract job details from a Glassdoor job detail page's HTML. Returns null
// on a Cloudflare interstitial (title says "Security" / "Just a moment"),
// otherwise an object with `fullDescription` set when one was found.
// Glassdoor rate-limits job-page fetches per IP and answers with a Cloudflare
// "Access denied" interstitial (HTTP 429/403) once an IP has made too many in
// quick succession. Verified 2026-07-28: fresh IP → 200 + a ~500KB page with
// real JSON-LD; burned IP → 429 + a ~7.5KB denial page with none. Detecting it
// is what lets the caller cool that IP instead of spending the rest of the
// batch on an address Glassdoor has already shut out.
export function isBlockedPage(status, html) {
    if (status === 429 || status === 403) return true;
    const head = String(html ?? '').slice(0, 2000);
    return /Access denied|Just a moment|Attention Required/i.test(head);
}

export function extractJobDetailsFromHTML(html) {
    const $ = cheerio.load(html);
    const title = $('title').text().trim();

    if (title.includes('Security') || title.includes('Just a moment')) {
        return null;
    }

    const jobDescription = {};
    const jsonLd = $('script[type="application/ld+json"]').html();

    if (jsonLd) {
        try {
            const structuredData = JSON.parse(jsonLd);
            if (structuredData.description) {
                const descHtml = structuredData.description;
                const $desc = cheerio.load(descHtml);
                const fullDescription = $desc.text().trim();
                if (fullDescription) {
                    jobDescription.fullDescription = fullDescription;
                }
            }
        } catch (e) {
            // Ignore
        }
    }

    if (!jobDescription.fullDescription) {
        const descSelectors = [
            '[data-test="job-description"]',
            '.jobDescription',
            '[class*="jobDescription"]'
        ];

        for (const selector of descSelectors) {
            const descElement = $(selector);
            if (descElement.length > 0) {
                const description = descElement.text().trim();
                if (description && description.length > 50) {
                    jobDescription.fullDescription = description;
                    break;
                }
            }
        }
    }

    return jobDescription;
}
