#!/usr/bin/env node
// One-shot diagnostic for "LinkedIn returns nothing for every query".
//
// WHY THIS EXISTS
// The RSC transport has exactly one ambiguous failure: zero posts with
// LinkedIn's positive "no results" flag. Three very different causes wear that
// same shape, and the daemon cannot tell them apart from inside a scrape:
//
//   1. The account is genuinely restricted (a real shadow-ban).
//   2. The captured request template has gone stale, so LinkedIn is answering
//      a malformed/mis-versioned request with a polite empty rather than an error.
//   3. The query itself is over-narrow, or the account is being asked the same
//      search so often that LinkedIn refuses the repeat.
//
// Guessing wrong is expensive in both directions: re-logging in does not clear
// a real ban, and cooling a healthy account for 4h costs a day of throughput.
// This script runs the SAME transport the daemon uses against a spread of
// query breadths and reports which cause fits.
//
// It is read-only: no credential state is touched, no queue rows are claimed,
// nothing is submitted. Safe to run against production while the daemon runs,
// though it does spend a handful of requests on the account's budget.
//
//     node scripts/linkedin-diagnose.js

import { readProfileCookies, loadTemplate } from '../src/scrapers/linkedin-rsc/session.js';
import { fetchPage } from '../src/scrapers/linkedin-rsc/client.js';
import { extractPosts, isConfirmedEmpty } from '../src/scrapers/linkedin-rsc/extract.js';
import { linkedInProfileDir, profileDirFor, hasLiAt } from '../src/core/linkedin-profile.js';

// Ordered widest-first. A healthy account MUST return posts for the top of this
// list; "no results in the last 24h for `hiring`" is not a believable answer on
// a site with a billion members. If even the widest probe is empty, breadth is
// not the problem and the account (or the template) is.
const PROBES = [
    { label: 'ultra-broad  ', keywords: 'hiring', datePosted: 'past-24h' },
    { label: 'broad        ', keywords: 'developer', datePosted: 'past-24h' },
    { label: 'broad-week   ', keywords: 'hiring', datePosted: 'past-week' },
    { label: 'common-role  ', keywords: 'java developer', datePosted: 'past-24h' },
    { label: 'typical-query', keywords: '"java developer" AND (c2c OR corp-to-corp)', datePosted: 'past-24h' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarise(body) {
    const posts = [...extractPosts(body)];
    return {
        bytes: body.length,
        posts: posts.length,
        confirmedEmpty: isConfirmedEmpty(body),
        // A body that is tiny AND carries no no-results flag is a different
        // animal from a well-formed empty: it usually means the response was
        // not the search payload at all (auth wall, challenge, shape change).
        looksLikePayload: body.length > 2000,
    };
}

async function main() {
    const profileKey = process.env.LINKEDIN_PROFILE_KEY || null;
    const dir = profileKey ? profileDirFor(profileKey) : linkedInProfileDir();
    console.log('=== LinkedIn RSC diagnosis ===');
    console.log('profile dir :', dir);
    console.log('profile key :', profileKey ?? '(base)');

    const template = loadTemplate();
    console.log('template url:', template.url);
    console.log('app version :', template.headers?.['x-li-application-version'] ?? '(none)');

    const cookies = await readProfileCookies({ profileKey });
    const li = cookies.find((c) => c.name === 'li_at');
    const js = cookies.find((c) => c.name === 'JSESSIONID');
    console.log('cookies     :', cookies.length, '| li_at:', Boolean(li), '| JSESSIONID:', Boolean(js));
    if (!hasLiAt(cookies)) {
        console.log('\nVERDICT: no li_at in the profile — the account is logged out, not banned.');
        console.log('         Run `npm run linkedin:login` on this host.');
        process.exit(2);
    }

    const results = [];
    for (const probe of PROBES) {
        let out;
        try {
            const body = await fetchPage({
                template,
                cookies,
                params: {
                    keywords: probe.keywords,
                    datePosted: probe.datePosted,
                    startIndex: 0,
                    count: 10,
                },
            });
            out = summarise(body);
        } catch (err) {
            out = { error: err?.code || err?.name || 'error', message: err?.message };
        }
        results.push({ probe, out });
        const detail = out.error
            ? `ERROR ${out.error}: ${out.message}`
            : `posts=${String(out.posts).padStart(3)} confirmedEmpty=${out.confirmedEmpty} bytes=${out.bytes}`;
        console.log(`  ${probe.label} [${probe.datePosted}] ${JSON.stringify(probe.keywords)} -> ${detail}`);
        // Space the probes out. This script exists to diagnose over-frequent
        // querying; hammering five requests back to back would be the very
        // behaviour under investigation.
        await sleep(8000);
    }

    const ok = results.filter((r) => !r.out.error);
    const anyPosts = ok.some((r) => r.out.posts > 0);
    const broad = results.find((r) => r.probe.label.startsWith('ultra-broad'));
    const authErrors = results.filter((r) => r.out.error === 'AuthError');
    const badPayloads = ok.filter((r) => !r.out.looksLikePayload);

    console.log('\n=== VERDICT ===');
    if (authErrors.length) {
        console.log('SESSION DEAD — LinkedIn rejected the request (403).');
        console.log('  The cookie jar is no longer valid. Re-login on the host.');
    } else if (anyPosts) {
        console.log('ACCOUNT IS HEALTHY — LinkedIn served posts for at least one probe.');
        console.log('  Zero-yield production sweeps are therefore a QUERY/CADENCE problem,');
        console.log('  not a ban: the queries are too narrow, or the same search is being');
        console.log('  repeated so often that LinkedIn refuses the repeat.');
    } else if (badPayloads.length === ok.length && ok.length > 0) {
        console.log('RESPONSES ARE NOT SEARCH PAYLOADS — every body was suspiciously small.');
        console.log('  This points at a stale template or a challenge/auth wall, NOT a ban.');
        console.log('  Re-capture with `npm run linkedin:rsc-template`.');
    } else if (broad && broad.out.confirmedEmpty) {
        console.log('ACCOUNT IS RESTRICTED — even "hiring" over 24h returned a positive');
        console.log('  no-results. That answer is not credible for a healthy account.');
        console.log('  Either the account is shadow-banned, or the template is stale enough');
        console.log('  that LinkedIn is politely refusing. Re-capture the template FIRST');
        console.log('  (cheap, reversible) before concluding the account is burnt.');
    } else {
        console.log('INCONCLUSIVE — see the per-probe lines above.');
    }
}

main().catch((err) => {
    console.error('diagnosis failed:', err);
    process.exit(1);
});
