#!/usr/bin/env node
// Report the freshness of this host's captured RSC template.
//
// Prints the captured client version, LinkedIn's current one, the lag between
// them, and the resulting verdict. Read-only and cheap: one ordinary page fetch,
// no search requests, no credential state touched.
//
//     node scripts/linkedin-template-status.js

import { loadTemplate } from '../src/scrapers/linkedin-rsc/session.js';
import {
    assessTemplate,
    fetchLiveClientVersion,
    templateClientVersion,
    maxVersionLag,
    maxTemplateAgeMs,
} from '../src/scrapers/linkedin-rsc/template-health.js';

function hours(ms) {
    return ms === null ? 'unknown' : `${(ms / 3600000).toFixed(1)}h`;
}

async function main() {
    const template = loadTemplate();
    const captured = templateClientVersion(template);
    const live = await fetchLiveClientVersion({
        userAgent: template?.headers?.['user-agent'],
    });

    const verdict = assessTemplate({ template, liveVersion: live });

    console.log('=== LinkedIn RSC template status ===');
    console.log('captured version :', captured ?? '(none)');
    console.log('live version     :', live ?? '(could not read)');
    console.log('version lag      :', verdict.lag ?? '(not comparable)');
    console.log('captured at      :', template?.capturedAt ?? '(unrecorded)');
    console.log('age              :', hours(verdict.ageMs));
    console.log('thresholds       :', `lag>${maxVersionLag()} or age>${hours(maxTemplateAgeMs())} (age only when lag is unknown)`);
    console.log('');
    if (verdict.stale) {
        console.log(`STALE (${verdict.reason}) — re-capture with \`npm run linkedin:rsc-template\`.`);
        console.log('  A stale template makes LinkedIn answer every search with a');
        console.log('  well-formed "No results found", which reads as a shadow-ban.');
        process.exitCode = 1;
    } else {
        console.log('FRESH — no re-capture needed.');
    }
}

main().catch((err) => {
    console.error('template status failed:', err?.message ?? err);
    process.exit(1);
});
