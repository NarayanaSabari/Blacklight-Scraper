// LinkedIn scraper, RSC transport.
//
// Same signature and return contract as the former LinkedIn scraper, so
// BaseScraper and the orchestrator need no changes. The formatter carries the
// captured recruiter contacts through to the backend wire payload.
//
// What differs from the DOM path:
//   • no scrolling, no per-post "Copy link" clipboard interaction — permalinks
//     arrive in the payload, which removes the most brittle dependency
//   • recruiter emails/phones are captured (the DOM path discards them)
//   • exact posted_at, decoded from the activity id, not a relative "2d"
//
// What is unchanged: one query variant per session (LinkedIn invalidates an
// automated session after roughly one query), and the credential lease is still
// held for the orchestrator's availability gate.

import { createLogger } from '../../logger/index.js';
import { normalizeJobData } from '../../core/normalize.js';
import { pickSessionQuery, buildBooleanSearchQuery } from '../../core/linkedin-query.js';
import { paginate as defaultPaginate, countPerRequest } from './client.js';
import { getLinkedInRscSession } from './session.js';
import { getHighWaterStore } from './high-water.js';
import { titleFromPost, locationFromPost, companyFromPost } from './post-fields.js';

const log = createLogger('linkedin-rsc');

// A candidate query runs to EXHAUSTION — no post ceiling. A recruiter asked for
// this specific search, and stopping at 100 threw away most of it: measured on
// two live recruiter queries, exhaustion is ~250-350 posts, so the old cap was
// discarding roughly 3.4x the results. Pagination already terminates on its own
// when a page adds nothing new, so "no cap" is bounded by LinkedIn, not by us.
//
// Role sweeps deliberately KEEP the 100 cap. They run ~135 roles/hour and
// lifting it there multiplies steady-state load for a different purpose.
const CANDIDATE_MAX_POSTS = Number.MAX_SAFE_INTEGER;

// Page guard, not a result limit. At the modest page size this is ~20k posts —
// far beyond any observed query — and exists only so a pathological response
// loop cannot page forever.
const CANDIDATE_MAX_PAGES = 2000;

// ⚠️ COUPLED TO THE BACKEND. RolePlatformQueueService.INFLIGHT_GRACE_SECONDS is
// 600s: after that the backend treats this session as an orphaned claim and
// lets another scraper claim the same platform, which would double-scrape. A
// long scrape does not move the session's updated_at (nothing is submitted
// until the end), so the scrape MUST finish well inside that window.
//
// 420s leaves ~3 minutes of margin. Measured cost at the default page size is
// ~3 minutes for a ~340-post query, so this should never trip; if it does, the
// alert below fires and the result is knowingly incomplete. Raising the backend
// grace window without raising this is safe; the reverse is not.
const CANDIDATE_TIME_BUDGET_MS = 420_000;

// Author display names are not in this payload, only the profile handle. Present
// it readably rather than inventing a company. LinkedIn post "company" was
// always weak — the importer's LinkedIn dedup keys on title + body, not company.
function companyFromHandle(handle) {
    const cleaned = String(handle ?? '')
        .replace(/-[a-z0-9]{6,}$/i, '')   // trailing profile discriminator
        .replace(/-/g, ' ')
        .trim();
    if (!cleaned) return 'LinkedIn Post Author';
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Map an extracted post to the normalized job shape.
 *
 * @param {object} post record from extract.js
 * @param {string} location search location, for the job's location field
 */
export function postToJob(post, location) {
    const text = post.text ?? '';
    const job = {
        // A validated title or the neutral constant — never a slice of the body.
        // See post-fields.js: raw first lines reached GlobalRole.aliases and
        // mis-attributed roles in prod.
        title: titleFromPost(text),
        // Prefer a client the post actually names; otherwise the recruiter who
        // posted it is the only party we genuinely know.
        company: companyFromPost(text) ?? companyFromHandle(post.author_handle),
        // The post's own location when stated, so a "Delhi Hybrid" post found by
        // a "United States" search is not stored as United States.
        location: locationFromPost(text, location),
        description: text,
        url: post.post_url,
        jobId: post.activity_id || post.post_url,
        postId: post.activity_id,
        activityUrn: post.activity_id ? `urn:li:activity:${post.activity_id}` : null,
        authorProfile: post.author_profile ?? null,
        timestamp: post.posted_at,
        hashtags: post.hashtags,
    };
    if (post.posted_at) job.postedDate = post.posted_at;
    const emails = post.contact_emails ?? [];
    const phones = post.contact_phones ?? [];
    if (emails.length || phones.length) {
        job.recruiter = {
            name: companyFromHandle(post.author_handle),
            profileUrl: post.author_profile ?? null,
            emails,
            phones,
        };
    }
    return normalizeJobData(job, 'LinkedIn');
}

/**
 * Scrape LinkedIn content search over the RSC transport.
 *
 * @param {string} jobTitle
 * @param {string} location
 * @param {string|null} sessionId
 * @param {object} [options] seams: session, template, paginateImpl, searchQueries
 * @returns {Promise<{jobs: object[], emptyConfirmed: boolean}>}
 */
export async function scrapeLinkedInRsc(jobTitle, location, sessionId = null, options = {}) {
    const {
        session = getLinkedInRscSession(),
        template = null,
        paginateImpl = defaultPaginate,
        searchQueries = null,
        candidateQuery = null,
        maxPosts = 100,
        count = countPerRequest(),
        datePosted = process.env.LINKEDIN_DATE_POSTED || 'past-24h',
        rng = Math.random,
        highWater = getHighWaterStore(),
    } = options;

    // A recruiter-authored query is used EXACTLY as written — no random pick.
    // Randomising across variants is right for a role (it broadens recall and
    // varies the request pattern), but a human asked for this specific boolean
    // and would have no way to tell why it only ran some of the time.
    //
    // One variant per session, chosen at random so repeated cycles cover them all.
    const variants = Array.isArray(searchQueries) && searchQueries.length > 0 ? searchQueries : null;
    const keywords = candidateQuery
        || pickSessionQuery(variants, rng)
        || buildBooleanSearchQuery(jobTitle);

    // Candidate-scoped runs lift the post cap entirely and add a wall-clock
    // safety valve instead. `count` is deliberately NOT raised: DEFAULT_COUNT is
    // low because a large page size is the most obvious automation tell in this
    // approach, and the account is worth more than the saved requests.
    const scoped = Boolean(candidateQuery);
    const effectiveMaxPosts = scoped ? CANDIDATE_MAX_POSTS : maxPosts;
    const effectiveMaxPages = scoped ? CANDIDATE_MAX_PAGES : undefined;
    const timeBudgetMs = scoped ? CANDIDATE_TIME_BUDGET_MS : 0;

    // Role sweeps only. A candidate query is a recruiter asking for a specific
    // search and is contracted to run to exhaustion (see CANDIDATE_MAX_POSTS);
    // silently trimming it to "posts since last time" would make a re-run look
    // like it lost most of its results. Role sweeps have no such expectation —
    // they exist to notice new postings, which is exactly what the mark tracks.
    const sinceActivityId = scoped ? null : highWater?.get?.(keywords, datePosted) ?? null;

    log.info('Starting RSC scrape', {
        jobTitle, keywords, datePosted, count,
        maxPosts: scoped ? 'uncapped' : maxPosts,
        candidateScoped: scoped,
    });

    return session.withCookies(sessionId, async (cookies, lease) => {
        const requestTemplate = template ?? await session.template();

        const {
            posts, emptyConfirmed, upToDate, newestActivityId: newestSeen, pages, budgetExhausted,
        } = await paginateImpl({
            template: requestTemplate,
            cookies,
            keywords,
            datePosted,
            maxPosts: effectiveMaxPosts,
            count,
            ...(effectiveMaxPages ? { maxPages: effectiveMaxPages } : {}),
            timeBudgetMs,
            sinceActivityId,
        });

        if (budgetExhausted) {
            // Should never fire: measured exhaustion is ~3 minutes against a
            // 7-minute budget. If it does, the result is incomplete AND the
            // scrape is approaching the backend's 600s orphan window, which
            // would let a second scraper claim the same platform.
            log.error('Candidate query hit its time budget — result is incomplete', {
                keywords,
                posts: posts.length,
                requests: pages?.length ?? 0,
                budgetMs: CANDIDATE_TIME_BUDGET_MS,
                scraper_alert: 'candidate_query_time_budget',
            });
        }

        const jobs = posts.map((post) => postToJob(post, location));

        // Advance only after the walk succeeded — a throw skips this and the
        // next run re-covers the same ground, which is the safe direction.
        // The store itself refuses to move a mark backward.
        if (!scoped && newestSeen) highWater?.advance?.(keywords, datePosted, newestSeen);

        log.info('RSC scrape complete', {
            posts: posts.length,
            withText: posts.filter((p) => (p.text_length ?? 0) > 80).length,
            withEmail: posts.filter((p) => (p.contact_emails ?? []).length > 0).length,
            requests: pages?.length ?? 0,
            emptyConfirmed,
            upToDate: Boolean(upToDate),
            sinceActivityId,
            candidateScoped: scoped,
            budgetExhausted,
        });

        // Per-role liveness against the held lease, as the DOM path does.
        await lease?.reportSuccess?.(`RSC scrape: ${posts.length} posts`);

        return { jobs, emptyConfirmed, upToDate: Boolean(upToDate) };
    });
}
