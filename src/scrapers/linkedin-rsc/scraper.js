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
import { CanaryTracker, runCanary } from './canary.js';
import { getRequestPacer } from './pacer.js';
import { fetchForCredential } from './egress.js';

// One tracker per process: streaks are per-credential inside it, and the
// canary's whole job is to observe across consecutive scrapes.
const defaultCanaryTracker = new CanaryTracker();
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

// ⚠️ The pacer's wait is spent INSIDE the lease but OUTSIDE the time budget
// above (the budget clock starts when pagination does). So the real worst case
// against the backend's 600s orphan window is:
//
//     pacer wait (20s floor + up to 10s jitter)  +  420s budget  =  450s
//
// leaving 150s of margin rather than the 180s the comment above describes.
// That is still comfortable, but the coupling is now three-way and easy to
// break silently: raising LINKEDIN_MIN_REQUEST_SPACING_MS far enough would eat
// the margin and start handing live sessions to a second scraper, which
// double-scrapes and doubles the request load on an account this whole change
// exists to protect.
//
// Asserted in test/scrapers/linkedin-acceptance.test.js so the arithmetic
// fails loudly rather than in production.
export const ORPHAN_WINDOW_MS = 600_000;   // mirrors INFLIGHT_GRACE_SECONDS
export const CANDIDATE_BUDGET_MS = CANDIDATE_TIME_BUDGET_MS;

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
        canaryTracker = defaultCanaryTracker,
        runCanaryImpl = runCanary,
        // Null disables pacing. The default is the process-wide pacer; callers
        // that inject their own `paginateImpl` are not touching LinkedIn at all
        // (tests, replays), so they get a no-op rather than real wall-clock
        // sleeps — otherwise a suite that exercises the scrape path would sit
        // through a 20s floor per call.
        pacer = paginateImpl === defaultPaginate ? getRequestPacer() : null,
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

        // Space this scrape from the previous one on the SAME credential. The
        // backend's 15-minute floor (#493) is per queue row: it bounds how often
        // one search repeats and cannot see how close together DIFFERENT
        // searches land on one account. Prod 2026-08-18 fired 12 sessions in 27
        // seconds that way. Held inside the lease so the wait is attributed to
        // the credential it protects, and after template load so a cold start
        // does not pay twice.
        await pacer?.pace?.(lease);

        // Bind egress to the credential's own proxy. A LinkedIn cookie is
        // issued to the IP that logged in; the login path routes through
        // `credential.proxy` (linkedin-browser.js) while this transport used
        // plain global fetch, so an account with a proxy scraped from a
        // different IP than it authenticated from. Prod 2026-08-18: Link1 had a
        // proxy set and was the hardest-hit account; Link2 had none and its
        // login and scrape agreed. No proxy on the credential still means
        // direct egress, unchanged.
        const boundFetch = fetchForCredential(lease?.credential);

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
            fetchImpl: boundFetch,
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

        // Shadow-ban canary. Three things prove the account is being served
        // normally, and none of them may feed the ban counter:
        //
        //   • posts came back;
        //   • `upToDate` — LinkedIn positively served posts we already hold;
        //   • a CONFIRMED empty for a search that carries a high-water mark.
        //
        // That third one is the 2026-08-18 outage. #492 made every steady-state
        // sweep ask for "posts newer than <mark>", and LinkedIn answers a
        // repeated identical search with its positive "no results" flag and no
        // rows. No rows means paginate() cannot set `upToDate` (that needs to
        // have SEEN a known post), so a perfectly healthy up-to-date sweep wore
        // the exact shape of a shadow-banned account's polite empty. At ~154
        // marked queue rows this reached the streak threshold in seconds:
        // Link2 reported success at 06:29:29 and was banned 4.2s later, and
        // with both accounts cooled the pipeline went to a hard zero.
        //
        // A confirmed empty with NO mark is still counted — that is a genuine
        // "nothing in the last 24h at all", which is the signature the canary
        // exists to catch.
        const refusedRepeat = emptyConfirmed && sinceActivityId !== null;

        // A zero-yield scrape feeds the credential's streak; at the threshold,
        // one extra request on a query that always has results settles whether
        // the account is banned or the queries were thin.
        //
        // MUST run BEFORE reportSuccess: reportSuccess releases the lease, and
        // the canary's ban report needs the lease alive to land. Observed in
        // production 2026-08-17: the canary fired twice (11:20, 11:54), and
        // both ban reports were dropped with "No active credential to report
        // failure for" because the lease had already been released. The
        // credential stayed `available` and kept being leased for four more
        // hours of zero-yield sessions.
        let canaryVerdict = null;
        if (jobs.length > 0 || upToDate || refusedRepeat) {
            canaryTracker.recordHealthy(lease);
        } else if (canaryTracker.recordEmpty(lease)) {
            canaryVerdict = await runCanaryImpl({
                tracker: canaryTracker,
                lease,
                template: requestTemplate,
                cookies,
                paginateImpl,
                fetchImpl: boundFetch,
                // Before blaming the ACCOUNT, rule out our own request. A
                // template that has fallen behind LinkedIn's client version
                // makes every search answer "no results", which is exactly the
                // evidence the canary treats as proof of a ban (2026-08-18:
                // both credentials falsely cooled, five hours at zero).
                //
                // Checked lazily and only at the point of conviction, so the
                // ordinary healthy path never pays for it.
                //
                // Passed as undefined when the session cannot answer, rather
                // than as a function that throws. A session without this
                // capability means NO OPINION, and the canary must fall back to
                // its previous behaviour — treating "cannot ask" as "request is
                // broken" would silently disable ban detection everywhere the
                // capability is absent.
                verifyRequestHealth: typeof session.isRequestHealthy === 'function'
                    ? () => session.isRequestHealthy()
                    : undefined,
            });
        }

        // Per-role liveness against the held lease, as the DOM path does.
        // Skipped after a confirmed shadow-ban: the canary already reported
        // the credential failed with a cooldown, and that report released the
        // lease — a success ping here would land on the dead lease and, worse,
        // contradict the verdict.
        if (canaryVerdict !== 'shadow_banned') {
            // Best-effort. The jobs are ALREADY SCRAPED by this point, and the
            // caller submits them after we return, so letting a failed liveness
            // ping propagate would discard completed work over a bookkeeping
            // call. Verified: with reportSuccess throwing "backend down", a
            // scrape carrying a real post threw and the post never reached the
            // backend.
            //
            // The same reasoning the HTTP client already applies to submitJobs,
            // which is exempted from the circuit breaker precisely so an
            // unrelated outage cannot bin scraped jobs.
            try {
                await lease?.reportSuccess?.(`RSC scrape: ${posts.length} posts`);
            } catch (error) {
                log.warn('Liveness ping failed — scrape result kept', {
                    err: error?.message,
                    posts: posts.length,
                });
            }
        }

        return { jobs, emptyConfirmed, upToDate: Boolean(upToDate) };
    });
}
