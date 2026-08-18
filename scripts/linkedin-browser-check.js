#!/usr/bin/env node
// THE decisive test: does a real browser, on the same profile, see results that
// the browserless RSC transport cannot?
//
// WHY THIS IS THE ONE THAT MATTERS
// Everything else we can observe is ambiguous. LinkedIn answers a restricted
// account and a rejected request the same way — HTTP 200, well-formed page,
// "No results found". The fix for those two causes is opposite:
//
//   browser SEES results, HTTP does not  -> the ACCOUNT is fine. Our replayed
//       request is being singled out (stale template, missing/!=fresh headers,
//       transport fingerprint). Fix the request. Do NOT cool the credential,
//       do NOT re-login, do NOT wait out a ban that does not exist.
//
//   browser ALSO sees nothing            -> the account is genuinely restricted.
//       No amount of request tuning helps; it needs quiet time, and the real
//       fix is cadence/rotation so we stop earning restrictions.
//
// Getting this backwards is exactly how a healthy account ends up cooled for
// hours while the actual bug (the request) stays unfixed, and vice versa.
//
// Read-only: navigates to a search page and counts results. Submits nothing.
//
//     node scripts/linkedin-browser-check.js ["keywords"]

import { launchPersistentContext } from '../src/core/browser-pool.js';
import { linkedInProfileDir, profileDirFor } from '../src/core/linkedin-profile.js';

const keywords = process.argv[2] || 'hiring';

async function main() {
    const profileKey = process.env.LINKEDIN_PROFILE_KEY || null;
    const userDataDir = profileKey ? profileDirFor(profileKey) : linkedInProfileDir();
    const url = 'https://www.linkedin.com/search/results/content/'
        + `?datePosted=${encodeURIComponent('["past-24h"]')}`
        + `&keywords=${encodeURIComponent(keywords)}&origin=FACETED_SEARCH`;

    console.log('profile :', userDataDir);
    console.log('keywords:', JSON.stringify(keywords));
    console.log('url     :', url);

    // Headed. A headless launch is itself a detection surface, and this test's
    // whole purpose is to represent what a normal human session sees.
    const context = await launchPersistentContext({
        userDataDir,
        headless: false,
        humanize: true,
    });

    try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // Content search hydrates client-side; a fixed wait is cruder than a
        // selector but survives the DOM changing, which it does often.
        await page.waitForTimeout(9000);

        const html = await page.content();
        const text = await page.evaluate(() => document.body.innerText).catch(() => '');

        const signals = {
            'No results found': /No results found/i.test(text),
            'authwall / sign in': /sign in|join now|authwall/i.test(text) && !/feed/i.test(text),
            'restricted language': /restricted|temporarily|unusual activity|try again later/i.test(text),
            'captcha / challenge': /captcha|verify you|security check|challenge/i.test(text),
        };

        // Post permalinks are the least DOM-dependent proxy for "there are
        // results here" — they survive class-name churn.
        const permalinks = new Set(
            [...html.matchAll(/urn:li:activity:(\d+)/g)].map((m) => m[1]),
        );

        console.log('\n--- what the browser sees ---');
        console.log('final url     :', page.url());
        console.log('page chars    :', text.length);
        console.log('activity ids  :', permalinks.size);
        for (const [name, hit] of Object.entries(signals)) {
            if (hit) console.log('signal        :', name);
        }
        console.log('\n--- first 600 chars of visible text ---');
        console.log(text.slice(0, 600));

        console.log('\n=== VERDICT ===');
        if (/sign in|join now|authwall/i.test(text) && permalinks.size === 0) {
            console.log('LOGGED OUT in the browser — the profile session is dead.');
            console.log('  Re-login on this host; this is not a ban.');
        } else if (permalinks.size > 0) {
            console.log(`BROWSER SEES ${permalinks.size} POSTS — the ACCOUNT IS HEALTHY.`);
            console.log('  The browserless RSC request is being refused on its own merits.');
            console.log('  Fix the REQUEST (re-capture template / headers), not the account.');
            console.log('  Any credential currently cooled for "shadow-ban" is a false positive.');
        } else if (signals['No results found']) {
            console.log('BROWSER ALSO SEES NOTHING — the account is genuinely restricted.');
            console.log('  Request tuning will not help. This needs quiet time, and a');
            console.log('  cadence/rotation change so we stop earning restrictions.');
        } else {
            console.log('INCONCLUSIVE — read the visible text above.');
        }
    } finally {
        await context.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('browser check failed:', err?.message ?? err);
    process.exit(1);
});
