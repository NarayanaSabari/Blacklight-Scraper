// Pure helpers for building and choosing LinkedIn content-search queries.
// Kept independent of the transport so pure query logic does not pull in
// browser packages.

// Anti-bot: choose exactly ONE query variant per browser session.
// Uniformly random so repeated orchestrator cycles cover all variants
// and the query pattern is less predictable. Pure (rng injectable).
export function pickSessionQuery(queries, rng = Math.random) {
    if (!Array.isArray(queries) || queries.length === 0) return null;
    const i = Math.min(queries.length - 1, Math.max(0, Math.floor(rng() * queries.length)));
    return queries[i];
}

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
export function buildBooleanSearchQuery(jobTitle) {
    const titlePart = `"${jobTitle}"`;

    // Pattern: "Job Title" AND (c2c OR W2 OR 1099)
    return `${titlePart} AND (c2c OR W2 OR 1099)`;
}
