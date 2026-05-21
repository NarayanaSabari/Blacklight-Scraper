#!/usr/bin/env node
// Test harness: run the REAL LinkedIn extraction for one role against the
// persistent profile, scrape up to N posts, and analyze what was extracted —
// especially the source-URL quality (permalink vs profile vs empty).
//
//   npm run linkedin:test-scrape -- "Scrum Master"        (role as arg)
//   LINKEDIN_TEST_MAX=25 npm run linkedin:test-scrape     (cap, default 25)
//
// Requires a logged-in persistent profile (run `npm run linkedin:login`
// first). Bypasses the credential-lease/orchestrator — it exercises only the
// browser session + navigateToSearch + extractPosts, then the URL helpers.
import {
    launchPersistentProfile, navigateToSearch, extractPosts,
    buildBooleanSearchQuery, postSourceUrl, activityPermalink, extractActivityId,
    resolvePostUrlViaMenu,
    CONFIG, linkedInProfileDir,
} from '../scrapers/linkedin.js';

const role = process.argv.slice(2).join(' ').trim() || 'Scrum Master';
const MAX = Number.parseInt(process.env.LINKEDIN_TEST_MAX || '25', 10) || 25;

// What the production map would compute as the job's source url.
function finalJobUrl(post) {
    return postSourceUrl(post.postUrl)
        || activityPermalink(extractActivityId(post.activityUrn || post.postUrl));
}
function urlType(url) {
    if (!url) return 'EMPTY';
    if (url.includes('/in/')) return 'PROFILE';            // must never happen
    if (url.includes('/feed/update/') || url.includes('/posts/')) return 'PERMALINK';
    return 'OTHER';
}

async function main() {
    const query = buildBooleanSearchQuery(role);
    CONFIG.jobTitle = role;
    CONFIG.searchQuery = query;

    console.log(`Role     : ${role}`);
    console.log(`Query    : ${query}`);
    console.log(`Profile  : ${linkedInProfileDir()}`);
    console.log(`Max posts: ${MAX}\n`);

    const context = await launchPersistentProfile();
    const page = await context.newPage();

    try {
        await navigateToSearch(page, query);
    } catch (e) {
        console.log(`\n❌ Could not reach the results page: ${e.name}: ${e.message}`);
        console.log('   → The profile is almost certainly not logged in.');
        console.log('   → Run `npm run linkedin:login`, log in, then re-run this.');
        await context.close();
        process.exit(2);
    }

    const onNewPost = async (post) => {
        if (post.postUrl) return;
        const act = await resolvePostUrlViaMenu(page, post.id);
        if (act) { post.activityUrn = `urn:li:activity:${act}`; post.postUrl = activityPermalink(act); }
    };
    const posts = await extractPosts(page, MAX, { onNewPost });
    console.log(`\n=== Scraped ${posts.length} post(s) (cap ${MAX}) ===\n`);

    const counts = { PERMALINK: 0, OTHER: 0, PROFILE: 0, EMPTY: 0 };
    posts.forEach((p, i) => {
        const url = finalJobUrl(p);
        const t = urlType(url);
        counts[t]++;
        console.log(`#${i + 1} [${t}]`);
        console.log(`   author     : ${p.author}`);
        console.log(`   activityUrn: ${p.activityUrn || '(none)'}`);
        console.log(`   raw postUrl: ${p.postUrl || '(none)'}`);
        console.log(`   → job url  : ${url || '(empty)'}`);
        console.log(`   content    : ${(p.content || '').slice(0, 80).replace(/\s+/g, ' ')}`);
        console.log('');
    });

    console.log('=== URL quality summary ===');
    console.log(`   PERMALINK (good): ${counts.PERMALINK}/${posts.length}`);
    console.log(`   OTHER           : ${counts.OTHER}/${posts.length}`);
    console.log(`   EMPTY           : ${counts.EMPTY}/${posts.length}`);
    console.log(`   PROFILE (/in/)  : ${counts.PROFILE}/${posts.length}  (must be 0)`);

    await context.close();
}

main().catch((e) => { console.error('test-scrape failed:', e); process.exit(1); });
