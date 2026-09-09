#!/usr/bin/env node
// Capture the LinkedIn content-search pagination request template.
//
//   npm run linkedin:rsc-template
//
// The RSC scraper sends plain HTTP requests modelled on a request the real
// flagship web app makes. That request carries client-version headers and a body
// shape we cannot invent, so it is captured once per host from a live navigation
// and cached at config/linkedin-rsc-template.json.
//
// The DAEMON now re-captures this on its own when it detects the template has
// fallen behind LinkedIn's client version (see
// src/scrapers/linkedin-rsc/template-health.js), so this script is for the
// first capture on a new host and for forcing a refresh by hand. Both paths run
// the same capture code.
//
// Session state is deliberately stripped before writing: cookies and csrf-token
// are derived per-request from the account's live jar, so the template on disk
// holds no credentials.

import { linkedInProfileDir } from '../src/core/linkedin-profile.js';
import { templatePath } from '../src/scrapers/linkedin-rsc/session.js';
import { captureTemplate, DEFAULT_PROBE_QUERY } from '../src/scrapers/linkedin-rsc/capture-template.js';

async function main() {
    const out = templatePath();
    console.log('LinkedIn RSC template capture');
    console.log(`  profile: ${linkedInProfileDir()}`);
    console.log(`  writing: ${out}`);
    console.log(`\n  navigating (query "${DEFAULT_PROBE_QUERY}")...`);

    const template = await captureTemplate({ outPath: out, query: DEFAULT_PROBE_QUERY });

    if (!template) {
        console.error('\n✗ No pagination request observed.');
        console.error('  Either the query returned no results (try RSC_TEMPLATE_QUERY="java developer"),');
        console.error('  or LinkedIn changed the search page.');
        process.exitCode = 3;
        return;
    }

    console.log('\n✓ Template captured');
    console.log(`  url:      ${template.url.slice(0, 96)}`);
    console.log(`  version:  ${template.headers['x-li-application-version'] ?? '(none)'}`);
    console.log(`  headers:  ${Object.keys(template.headers).length} kept`);
    console.log(`  body:     ${template.postData.length} bytes`);
    console.log(`  written:  ${out}`);
    console.log('\n  The scraper derives cookies and csrf-token per request, so this file holds no credentials.');
}

main().catch((err) => {
    console.error(`\n✗ Template capture failed: ${err?.message ?? err}`);
    process.exitCode = 1;
});
