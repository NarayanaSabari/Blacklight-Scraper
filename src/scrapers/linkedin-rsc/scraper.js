// LinkedIn scraper, RSC transport.
//
// Same signature and return contract as the former LinkedIn scraper, so
// BaseScraper, the orchestrator and formatJobForBlacklight need no changes.
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

const log = createLogger('linkedin-rsc');

const MAX_TITLE_CHARS = 200;

// The post body has no separate title; LinkedIn posts do not have one. Take the
// first meaningful line, bounded to the column width the importer expects.
function titleFromText(text) {
    const firstLine = String(text ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? '';
    const candidate = firstLine || String(text ?? '').trim();
    return candidate.slice(0, MAX_TITLE_CHARS) || 'LinkedIn Job Post';
}

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
        title: titleFromText(text),
        company: companyFromHandle(post.author_handle),
        location: location || '',
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
    const contact = [...(post.contact_emails ?? []), ...(post.contact_phones ?? [])];
    if (contact.length) {
        job.recruiter = {
            name: companyFromHandle(post.author_handle),
            profileUrl: post.author_profile ?? null,
            contact,
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
        maxPosts = 100,
        count = countPerRequest(),
        datePosted = process.env.LINKEDIN_DATE_POSTED || 'past-24h',
        rng = Math.random,
    } = options;

    // One variant per session, chosen at random so repeated cycles cover them all.
    const variants = Array.isArray(searchQueries) && searchQueries.length > 0 ? searchQueries : null;
    const keywords = pickSessionQuery(variants, rng) ?? buildBooleanSearchQuery(jobTitle);

    log.info('Starting RSC scrape', { jobTitle, keywords, datePosted, count, maxPosts });

    return session.withCookies(sessionId, async (cookies, lease) => {
        const requestTemplate = template ?? await session.template();

        const { posts, emptyConfirmed, pages } = await paginateImpl({
            template: requestTemplate,
            cookies,
            keywords,
            datePosted,
            maxPosts,
            count,
        });

        const jobs = posts.map((post) => postToJob(post, location));

        log.info('RSC scrape complete', {
            posts: posts.length,
            withText: posts.filter((p) => (p.text_length ?? 0) > 80).length,
            withEmail: posts.filter((p) => (p.contact_emails ?? []).length > 0).length,
            requests: pages?.length ?? 0,
            emptyConfirmed,
        });

        // Per-role liveness against the held lease, as the DOM path does.
        await lease?.reportSuccess?.(`RSC scrape: ${posts.length} posts`);

        return { jobs, emptyConfirmed };
    });
}
