// Browserless client for LinkedIn's content-search pagination endpoint.
//
//   POST /flagship-web/rsc-action/actions/pagination
//        ?sduiid=com.linkedin.sdui.search.contentSearchResults
//
// A captured request template supplies the body shape and client-version
// headers; we swap in the search parameters. Auth is the account's cookie jar:
// `li_at` plus `JSESSIONID` echoed as the `csrf-token` header. Missing either
// yields 403 "CSRF validation failed." — verified against live LinkedIn.
//
// The browser is only needed to mint the template and read cookies; every
// request here is plain HTTP.

import { AuthError, BlockedError, NetworkError } from '../../core/errors.js';
import { extractPosts, isConfirmedEmpty } from './extract.js';
import { isNewerThan, newestActivityId } from './high-water.js';

// LinkedIn silently refuses to serve more than 50 results in one request: it
// answers 200 with its no-results flag and zero posts.
export const MAX_COUNT_PER_REQUEST = 50;

// The live UI requests 3 at a time. Asking for 50 is the single most obvious
// automation tell in this approach, so the default stays modest and is tunable
// per host. Efficiency costs a few extra requests; the account is worth more.
export const DEFAULT_COUNT = 10;

/**
 * Requests-per-page count from env, clamped to the server limit.
 * @param {Record<string,string|undefined>} env
 */
export function countPerRequest(env = process.env) {
    const raw = env?.LINKEDIN_RSC_COUNT;
    const n = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COUNT;
    return Math.min(n, MAX_COUNT_PER_REQUEST);
}

/**
 * Build the request body: the captured template with search parameters applied.
 *
 * Both payload sites must be updated. The endpoint reads
 * `clientArguments.payload`, but `paginationRequest.requestedArguments` carries
 * its own copy and a mismatch silently serves the template's original query.
 *
 * @param {{postData: string}} template
 * @param {{keywords: string, datePosted?: string, startIndex?: number, count?: number}} params
 * @returns {string} JSON body
 */
export function buildPaginationBody(template, params) {
    const base = JSON.parse(template.postData);
    const seed = base.clientArguments?.payload ?? {};
    const payload = {
        ...seed,
        keywords: params.keywords,
        datePosted: [params.datePosted ?? 'past-24h'],
        startIndex: params.startIndex ?? 0,
        count: Math.min(params.count ?? DEFAULT_COUNT, MAX_COUNT_PER_REQUEST),
    };
    return JSON.stringify({
        ...base,
        clientArguments: { ...base.clientArguments, payload },
        paginationRequest: base.paginationRequest
            ? {
                ...base.paginationRequest,
                requestedArguments: {
                    ...base.paginationRequest.requestedArguments,
                    payload,
                },
            }
            : base.paginationRequest,
    });
}

/**
 * Build request headers from the template and the account's cookie jar.
 *
 * @param {{headers: Record<string,string>}} template
 * @param {Array<{name: string, value: string, domain?: string}>} cookies
 * @param {{keywords: string, datePosted?: string}} params
 * @throws {AuthError} when the jar carries no usable session
 */
export function buildHeaders(template, cookies, params) {
    const jar = Array.isArray(cookies) ? cookies : [];
    const liAt = jar.find((c) => c.name === 'li_at');
    const session = jar.find((c) => c.name === 'JSESSIONID');
    if (!liAt || !session) {
        throw new AuthError(
            'LinkedIn session cookies missing (need li_at + JSESSIONID) — account needs re-login',
            { platform: 'linkedin', code: 'NEEDS_RELOGIN' },
        );
    }
    const cookieHeader = jar
        .filter((c) => !c.domain || /linkedin/.test(c.domain))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    const referer = 'https://www.linkedin.com/search/results/content/'
        + `?datePosted=${encodeURIComponent(`["${params.datePosted ?? 'past-24h'}"]`)}`
        + `&keywords=${encodeURIComponent(params.keywords)}&origin=FACETED_SEARCH`;

    return {
        accept: '*/*',
        // Payloads are ~750KB per post uncompressed and compress ~68x, so always
        // advertise encodings; without this a scrape moves tens of MB per request.
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'csrf-token': String(session.value).replace(/"/g, ''),
        cookie: cookieHeader,
        'user-agent': template.headers['user-agent'],
        'x-li-rsc-stream': 'true',
        'x-li-application-version': template.headers['x-li-application-version'],
        'x-li-track': template.headers['x-li-track'],
        'x-li-anchor-page-key': 'd_flagship3_search_srp_content',
        'x-li-page-instance': template.headers['x-li-page-instance'],
        referer,
        origin: 'https://www.linkedin.com',
    };
}

/**
 * Fetch one page of results, returning the raw flight body.
 *
 * Status mapping is deliberate: a 403 means THIS account's session is dead, so
 * it surfaces as AuthError (cool the credential, rotate). A 429 is the platform
 * pushing back, so it surfaces as BlockedError.
 */
export async function fetchPage({ template, cookies, params, fetchImpl = fetch }) {
    const headers = buildHeaders(template, cookies, params);
    const body = buildPaginationBody(template, params);

    let response;
    try {
        response = await fetchImpl(template.url, { method: 'POST', headers, body });
    } catch (cause) {
        throw new NetworkError(`LinkedIn RSC request failed: ${cause?.message ?? cause}`, {
            platform: 'linkedin', cause,
        });
    }

    if (response.status === 403) {
        throw new AuthError(
            'LinkedIn rejected the RSC request (403) — session cookies dead, needs re-login',
            { platform: 'linkedin', code: 'NEEDS_RELOGIN' },
        );
    }
    if (response.status === 429) {
        throw new BlockedError('LinkedIn rate-limited the RSC endpoint (429)', {
            platform: 'linkedin', kind: 'rate_limit',
        });
    }
    if (response.status < 200 || response.status >= 300) {
        throw new NetworkError(`LinkedIn RSC request returned ${response.status}`, {
            platform: 'linkedin', statusCode: response.status,
        });
    }
    return response.text();
}

// Jittered pause between requests. Uniform back-to-back requests are a
// behavioural signal, and this endpoint is cheap enough that waiting costs little.
function defaultDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function nextPause(rng = Math.random) {
    return Math.round(2500 + rng() * 3500); // 2.5–6s
}

/**
 * Walk pages until the budget is met, nothing new arrives, or the page cap hits.
 *
 * @returns {Promise<{posts: object[], emptyConfirmed: boolean, pages: object[]}>}
 */
export async function paginate({
    template,
    cookies,
    keywords,
    datePosted = 'past-24h',
    maxPosts = 100,
    count = DEFAULT_COUNT,
    maxPages = 10,
    // Wall-clock ceiling in ms; 0 disables it. This is a SAFETY VALVE, not a
    // result limit — see the note on CANDIDATE_TIME_BUDGET_MS in scraper.js.
    timeBudgetMs = 0,
    // Newest activity id already forwarded for this exact search. Posts at or
    // below it are known ground: they are dropped, and a page that contains
    // nothing above it ends the walk. Null disables the behaviour entirely,
    // which is the first-run and candidate-query case.
    sinceActivityId = null,
    fetchImpl = fetch,
    delay = defaultDelay,
    rng = Math.random,
    now = () => Date.now(),
}) {
    const posts = [];
    const seen = new Set();
    const pages = [];
    let sawNoResultsSignal = false;
    let budgetExhausted = false;
    // Distinguishes "LinkedIn had results, we already had all of them" from
    // "LinkedIn had nothing". Both yield zero posts; only the latter is an
    // empty result set, and neither is a block.
    let sawKnownPost = false;
    let reachedKnownGround = false;
    let newestSeen = null;
    // NOT `startedAt` — the loop body declares its own `startedAt` for per-page
    // latency, and shadowing it puts this reference in the temporal dead zone.
    const runStartedAt = now();

    for (let page = 0; page < maxPages && posts.length < maxPosts; page++) {
        // Checked BEFORE the request, not after: tripping the budget must stop
        // us issuing more work, and a partial result is still worth returning.
        if (timeBudgetMs > 0 && now() - runStartedAt >= timeBudgetMs) {
            budgetExhausted = true;
            break;
        }
        if (page > 0) await delay(nextPause(rng));

        const startedAt = Date.now();
        const body = await fetchPage({
            template,
            cookies,
            params: { keywords, datePosted, startIndex: page * count, count },
            fetchImpl,
        });

        if (isConfirmedEmpty(body)) sawNoResultsSignal = true;

        let added = 0;
        // Counts posts this page returned at all, new or not. A page that
        // returned rows but added nothing NEW is the stop condition; a page
        // that returned no rows at all is ordinary exhaustion.
        let pageRows = 0;
        for (const post of extractPosts(body)) {
            pageRows++;
            const key = post.activity_id || post.post_url;
            if (seen.has(key)) continue;
            seen.add(key);
            if (post.activity_id) newestSeen = newestActivityId([newestSeen, post.activity_id]);
            // Known ground. Skip rather than break: LinkedIn orders content
            // search by relevance as well as recency, so a single old post can
            // sit above newer ones. The page-level check below is what stops
            // the walk, which tolerates that interleaving.
            if (sinceActivityId && !isNewerThan(post.activity_id, sinceActivityId)) {
                sawKnownPost = true;
                continue;
            }
            posts.push(post);
            added++;
            if (posts.length >= maxPosts) break;
        }

        pages.push({
            page: page + 1,
            start_index: page * count,
            bytes: body.length,
            latency_ms: Date.now() - startedAt,
            posts_added: added,
        });

        // LinkedIn re-serves overlapping windows; a page adding nothing means the
        // result set is exhausted. With a mark set, a page that returned rows
        // but nothing above the mark means we have reached known ground — the
        // whole point of the mark, and where the request saving comes from.
        if (added === 0) {
            if (sinceActivityId && pageRows > 0) reachedKnownGround = true;
            break;
        }
    }

    return {
        posts,
        // Only a positive LinkedIn signal counts as confirmed-empty. An empty
        // result with no signal is the silent-block signature and must stay
        // unconfirmed so it surfaces as a failure rather than a clean zero.
        emptyConfirmed: posts.length === 0 && sawNoResultsSignal,
        // Zero NEW posts, but LinkedIn positively served posts we already hold.
        // A third outcome alongside "empty" and "blocked": callers must not
        // read it as a block, and must not read it as an empty result set.
        upToDate: posts.length === 0 && (reachedKnownGround || sawKnownPost),
        // Newest id observed this run, mark-eligible or not. The caller stores
        // it so the next run starts from here.
        newestActivityId: newestSeen,
        pages,
        // True when we stopped on the clock rather than because LinkedIn ran
        // out. The caller alerts on this: it should never happen in practice,
        // and if it does the result is silently incomplete.
        budgetExhausted,
    };
}
