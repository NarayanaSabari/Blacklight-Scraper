#!/usr/bin/env node
// Dump one raw RSC response so a human can see what LinkedIn actually sent.
//
// The diagnosis script classifies; this one shows. Use it when the classifier
// says INCONCLUSIVE, which means the body was neither a result set nor a
// recognisable no-results page — i.e. the response shape itself is the story.
//
// Read-only. Prints the head of the body plus any recognisable markers.
//
//     node scripts/linkedin-dump-response.js ["keywords"]

import { readProfileCookies, loadTemplate } from '../src/scrapers/linkedin-rsc/session.js';
import { fetchPage } from '../src/scrapers/linkedin-rsc/client.js';
import { profileDirFor, linkedInProfileDir } from '../src/core/linkedin-profile.js';

const keywords = process.argv[2] || 'hiring';

// Markers worth calling out by name. Each one turns "an unexplained 5KB body"
// into a specific, actionable diagnosis.
const MARKERS = [
    ['HasNoresultsBindingKey', 'LinkedIn no-results flag (a genuine empty result)'],
    ['challenge', 'challenge/interstitial (bot check)'],
    ['captcha', 'CAPTCHA'],
    ['authwall', 'auth wall (logged out)'],
    ['CSRF', 'CSRF rejection'],
    ['rate', 'possible rate-limit language'],
    ['restricted', 'account restriction language'],
    ['unavailable', 'content unavailable language'],
    ['redirect', 'redirect directive'],
    ['ERROR', 'server-side error marker'],
    ['sdui', 'SDUI envelope (expected for a real search payload)'],
    ['contentSearch', 'content-search component (expected)'],
    ['feedComponent', 'feed component rows (posts present)'],
];

async function main() {
    const profileKey = process.env.LINKEDIN_PROFILE_KEY || null;
    console.log('profile dir:', profileKey ? profileDirFor(profileKey) : linkedInProfileDir());
    console.log('keywords   :', JSON.stringify(keywords));

    const template = loadTemplate();
    const cookies = await readProfileCookies({ profileKey });
    const body = await fetchPage({
        template,
        cookies,
        params: { keywords, datePosted: 'past-24h', startIndex: 0, count: 10 },
    });

    console.log('bytes      :', body.length);
    console.log('\n--- markers ---');
    for (const [needle, meaning] of MARKERS) {
        const re = new RegExp(needle, 'i');
        if (re.test(body)) console.log(`  FOUND ${needle.padEnd(24)} ${meaning}`);
    }

    console.log('\n--- first 3000 chars ---');
    console.log(body.slice(0, 3000));
    console.log('\n--- last 1200 chars ---');
    console.log(body.slice(-1200));
}

main().catch((err) => {
    console.error('dump failed:', err?.message ?? err);
    process.exit(1);
});
