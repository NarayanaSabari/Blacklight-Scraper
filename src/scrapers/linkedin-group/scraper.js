// LinkedIn group-feed collector.
//
// Group collection has no role or query.  It accepts the explicit source
// assignment from the backend, reuses the normal LinkedIn credential lease,
// and sends the resulting posts through the existing LinkedIn post mapper.

import {
    AuthError,
    BlockedError,
    DomChangedError,
    NetworkError,
    ValidationError,
} from '../../core/errors.js';
import { launchPersistentProfile } from '../../core/linkedin-browser.js';
import { getLinkedInRscSession } from '../linkedin-rsc/session.js';
import { postToJob } from '../linkedin-rsc/scraper.js';
import {
    GROUP_ID,
    GROUP_URL,
    buildGroupProgress,
    extractGroupPosts,
    normalizeGroupCheckpoint,
    parseGroupGraphqlResponse,
    paginateGroupFeed,
} from './feed.js';

export const GROUP_QUERY_ID = 'voyagerFeedDashGroupsUpdates.42b722995f2477fa5a9e6797dbd28281';
const DEFAULT_SCROLL_WAIT_MS = 750;
// CloakBrowser seats are reclaimed after five minutes. Keep a live group walk
// below that lease boundary even if the feed keeps producing continuation
// pages. The group checkpoint makes the next pass safe to continue.
const DEFAULT_GROUP_TIME_BUDGET_MS = 240_000;
const GROUP_PAGE_COUNT = 10;
const MAX_EXPAND_BUTTONS = 50;

function groupRequest(url) {
    let parsed;
    try { parsed = new URL(url, GROUP_URL); }
    catch { return null; }
    if (parsed.origin !== 'https://www.linkedin.com'
        || parsed.pathname !== '/voyager/api/graphql') return null;
    if (parsed.searchParams.get('queryId') !== GROUP_QUERY_ID) return null;
    const variables = parsed.searchParams.get('variables') ?? '';
    if (!/(?:^|[(,])groupId:(?:["'])?10472901(?:["'])?(?:[,)]|$)/.test(variables)) return null;
    return parsed;
}

function requestCursor(url) {
    const parsed = groupRequest(url);
    if (!parsed) return null;
    const variables = parsed.searchParams.get('variables') ?? '';
    const match = variables.match(/(?:^|[(,])paginationToken:([^,)]*)/);
    return match?.[1] || null;
}

function requestStart(url) {
    const parsed = groupRequest(url);
    if (!parsed) return null;
    const variables = parsed.searchParams.get('variables') ?? '';
    const match = variables.match(/(?:^|[(,])start:(\d+)/);
    return match ? Number(match[1]) : null;
}

function decodeGroupCursor(value) {
    if (typeof value !== 'string' || value.length === 0) return { token: null, start: null };
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') {
            return {
                token: parsed.token,
                start: Number.isInteger(parsed.start) && parsed.start >= 0 ? parsed.start : null,
                skip: Number.isSafeInteger(parsed.skip) && parsed.skip > 0 ? parsed.skip : 0,
                expiresAt: parsed.expiresAt !== null && parsed.expiresAt !== undefined
                    && Number.isFinite(Number(parsed.expiresAt))
                    ? Number(parsed.expiresAt)
                    : null,
            };
        }
    } catch { /* legacy raw token */ }
    return { token: value, start: null };
}

function encodeGroupCursor(token, start = null, expiresAt = null, skip = 0) {
    if (!token) return null;
    if (!Number.isInteger(start) || start < 0) return token;
    const cursor = { token, start };
    if (Number.isSafeInteger(skip) && skip > 0) cursor.skip = skip;
    if (expiresAt !== null && expiresAt !== undefined
        && Number.isFinite(Number(expiresAt))) cursor.expiresAt = Number(expiresAt);
    return JSON.stringify(cursor);
}

function buildGroupPaginationUrl(cursor, start = null) {
    const details = decodeGroupCursor(cursor);
    const effectiveStart = Number.isInteger(start) && start >= 0 ? start : details.start;
    if (!details.token || !Number.isInteger(effectiveStart)) return null;
    const variables = `(start:${effectiveStart},count:${GROUP_PAGE_COUNT},groupId:${GROUP_ID},paginationToken:${details.token})`;
    return `https://www.linkedin.com/voyager/api/graphql?variables=${encodeURIComponent(variables)}&queryId=${GROUP_QUERY_ID}`;
}

function responseStatus(response) {
    const status = typeof response?.status === 'function' ? response.status() : response?.status;
    return Number.isFinite(Number(status)) ? Number(status) : null;
}

function errorForGroupResponse(status) {
    if (status === 401) {
        return new AuthError('LinkedIn group feed requires authentication', {
            platform: 'linkedin', code: 'NEEDS_RELOGIN',
        });
    }
    if (status === 403) {
        return new BlockedError('LinkedIn group feed access was denied', {
            platform: 'linkedin', kind: 'access_denied',
        });
    }
    return new NetworkError(
        `LinkedIn group GraphQL response returned ${status ?? 'an unknown status'}`,
        { platform: 'linkedin', statusCode: status },
    );
}

function explicitlyExpiredCursor(body) {
    const text = JSON.stringify(body ?? '').toLowerCase();
    return /(?:pagination|page|feed)\s*(?:token|cursor)[^\n]{0,80}(?:expired|invalid|stale)/.test(text)
        || /(?:expired|invalid|stale)[^\n]{0,80}(?:pagination|page|feed)\s*(?:token|cursor)/.test(text);
}

async function replayGroupCursor(page, cursor, cookies, { start = null } = {}) {
    if (!cursor || typeof page?.evaluate !== 'function') return null;
    const url = buildGroupPaginationUrl(cursor, start);
    if (!url) return null;
    const csrf = cookies?.find?.((cookie) => cookie.name === 'JSESSIONID')?.value ?? null;
    const result = await page.evaluate(async ({ requestUrl, csrfToken }) => {
        const response = await fetch(requestUrl, {
            credentials: 'include',
            headers: csrfToken ? { 'csrf-token': String(csrfToken).replace(/"/g, '') } : {},
        });
        let body = null;
        try { body = await response.json(); }
        catch { /* the caller reports an unrecognized response */ }
        return { status: response.status, body };
    }, { requestUrl: url, csrfToken: csrf });
    if (!result || typeof result !== 'object' || !Number.isFinite(Number(result.status))) return null;
    const status = Number(result.status);
    // LinkedIn's opaque pagination token is short-lived. A stale token is a
    // known, recoverable condition: restart from the current head and let the
    // backend activity-id deduplication bridge the overlap.
    if ((status === 400 || status === 404) && explicitlyExpiredCursor(result.body)) {
        return { url, expired: true, status };
    }
    if (status < 200 || status >= 300) throw errorForGroupResponse(status);
    return {
        url,
        status,
        parsed: parseGroupGraphqlResponse(result.body, { groupId: GROUP_ID }),
    };
}

export function groupPaginationCursor(url) {
    return requestCursor(url);
}

function hasRecognizedFeed(markup) {
    return /data-view-name=["']feed-full-update/i.test(markup)
        || /occludable-update/i.test(markup);
}

function hasAuthWall(markup, pageUrl = '') {
    if (/\/login|\/checkpoint/i.test(pageUrl)) return true;
    if (hasRecognizedFeed(markup)) return false;
    return /sign in to linkedin|log in to linkedin|session expired/i.test(markup);
}

function hasAccessDenied(markup) {
    if (hasRecognizedFeed(markup)) return false;
    return /join this group|request to join|you(?:'|’)re not authorized|you do not have access|page not found/i.test(markup);
}

function decorateTraversalError(error, checkpoint, posts, stopReason, postsSeen) {
    error.groupProgress = buildGroupProgress({
        posts,
        checkpoint,
        cursor: checkpoint.cursor,
        traversal: 'incomplete',
        stopReason,
        postsSeen,
        advanceCheckpoint: false,
    });
    return error;
}

async function expandSeeMore(page) {
    const buttons = page.locator('button[aria-label^="see more"]');
    const count = Math.min(await buttons.count(), MAX_EXPAND_BUTTONS);
    for (let index = 0; index < count; index += 1) {
        await buttons.nth(index).click({ timeout: 2_000 }).catch(() => {});
    }
}

function mergePosts(target, additions, maxPosts = Number.POSITIVE_INFINITY) {
    const byId = new Map(target.map((post) => [post.activity_id ?? post.activityId, post]));
    let truncated = false;
    let consumed = 0;
    for (const post of additions) {
        const key = post.activity_id ?? post.activityId;
        if (!key) { consumed += 1; continue; }
        const existing = byId.get(key);
        if (!existing || String(post.text ?? '').length > String(existing.text ?? '').length) {
            if (!existing && byId.size >= maxPosts) {
                truncated = true;
                break;
            }
            byId.set(key, post);
        }
        consumed += 1;
    }
    const before = target.length;
    target.splice(0, target.length, ...byId.values());
    return { added: target.length - before, truncated, consumed };
}

/**
 * Read the currently loaded DOM while scrolling the observed group feed.
 *
 * LinkedIn exposes the observed `voyagerFeedDashGroupsUpdates` response while
 * this page scrolls.  The collector parses that response when available and
 * keeps DOM extraction as the card-level fallback.  The capture has no
 * positive end marker, so a scroll stall remains `incomplete/page_budget`.
 * A durable cursor is replayed through the same observed GraphQL URL before a
 * fresh head walk; an expired token falls back to that head walk.
 */
export async function collectObservedGroupDom({
    group,
    checkpoint: rawCheckpoint = null,
    sessionId,
    session = getLinkedInRscSession(),
    browserLauncher = launchPersistentProfile,
    maxPosts = 5000,
    maxScrolls = 200,
    timeBudgetMs = DEFAULT_GROUP_TIME_BUDGET_MS,
    scrollWaitMs = DEFAULT_SCROLL_WAIT_MS,
    now = () => Date.now(),
} = {}) {
    if (!group || String(group.id) !== String(GROUP_ID) || group.url !== GROUP_URL) {
        throw new ValidationError('Unsupported LinkedIn group source', { platform: 'linkedin' });
    }
    const checkpoint = normalizeGroupCheckpoint(rawCheckpoint);

    return session.withCookies(sessionId, async (cookies, lease) => {
        const context = await browserLauncher({
            profileKey: lease?.credential?.profile_key ?? null,
            proxy: lease?.credential?.proxy ?? null,
        });
        let page;
        const requests = [];
        const responsePages = [];
        const responseErrors = [];
        const pendingResponses = new Set();
        const capturedResponseUrls = new Set();
        const requestOrder = [];
        const requestStarts = new Map();
        const responseOnlyRequests = new Set();
        const requestSequenceByUrl = new Map();
        const responseSlotsByUrl = new Map();
        const replayUrls = new Set();
        let consumedResponses = 0;

        const refreshRequestSequences = () => {
            requestSequenceByUrl.clear();
            requestOrder.forEach((url, index) => requestSequenceByUrl.set(url, index));
        };
        const captureRequest = (request, { responseOnly = false } = {}) => {
            const url = request?.url?.();
            if (!url || !groupRequest(url)) return null;
            if (requestSequenceByUrl.has(url)) {
                if (!responseOnly) responseOnlyRequests.delete(url);
                return requestSequenceByUrl.get(url);
            }
            const start = requestStart(url);
            requestStarts.set(url, start);
            let insertAt = requestOrder.length;
            if (responseOnly && Number.isInteger(start)) {
                const unconsumedStart = consumedResponses;
                for (let index = unconsumedStart; index < requestOrder.length; index += 1) {
                    const candidate = requestOrder[index];
                    if (!responseOnlyRequests.has(candidate)) continue;
                    const candidateStart = requestStarts.get(candidate);
                    if (Number.isInteger(candidateStart) && start < candidateStart) {
                        insertAt = index;
                        break;
                    }
                }
            }
            requestOrder.splice(insertAt, 0, url);
            requests.splice(insertAt, 0, url);
            if (responseOnly) responseOnlyRequests.add(url);
            refreshRequestSequences();
            return requestSequenceByUrl.get(url);
        };
        const captureResponse = (response) => {
            const url = response?.url?.();
            if (!url || !groupRequest(url)) return;
            if (capturedResponseUrls.has(url)) return;
            capturedResponseUrls.add(url);
            captureRequest(response, { responseOnly: true });
            const responsePage = {
                url,
                status: null,
                source: null,
                parsed: null,
                ready: false,
            };
            responseSlotsByUrl.set(url, responsePage);
            // Reserve the page slot before awaiting response.json(). A later
            // response may resolve first, but it must remain behind this
            // request in the contiguous request sequence.
            responsePages.push(responsePage);
            const task = Promise.resolve().then(async () => {
                const status = responseStatus(response);
                if (status !== null && (status < 200 || status >= 300)) {
                    throw errorForGroupResponse(status);
                }
                const body = await response.json();
                responsePage.status = status;
                responsePage.source = replayUrls.has(url) ? 'replay' : 'head';
                responsePage.parsed = parseGroupGraphqlResponse(body, { groupId: group.id });
                responsePage.ready = true;
            }).catch((error) => {
                responsePage.status = responseStatus(response);
                responsePage.ready = true;
                responseErrors.push({ url, error, status: responseStatus(response) });
            });
            pendingResponses.add(task);
            task.then(
                () => pendingResponses.delete(task),
                () => pendingResponses.delete(task),
            );
        };
        const settleResponses = async () => {
            while (pendingResponses.size > 0) {
                await Promise.allSettled([...pendingResponses]);
            }
        };
        try {
            page = await context.newPage();
            // Context listeners also see requests issued by workers or a
            // prefetch. Page listeners remain for the small test/browser
            // contexts that expose only the page event surface.
            context.on?.('request', captureRequest);
            context.on?.('response', captureResponse);
            page.on?.('request', captureRequest);
            page.on?.('response', captureResponse);
            await page.goto(group.url, { waitUntil: 'domcontentloaded' });

            const posts = [];
            let postsSeen = 0;
            let stableScrolls = 0;
            let stopReason = 'page_budget';
            const startedAt = now();
            const resumeCursor = checkpoint.cursor;
            const resumeToken = decodeGroupCursor(resumeCursor).token;
            let resumeCursorExpired = false;
            let resumedPastCursor = !resumeCursor;
            let durableCursor = resumeCursor;
            let durableCursorExpiresAt = null;
            let durableExhausted = false;
            let headCursor = null;
            let headCursorExpiresAt = null;
            let headCursorStart = null;
            let headInputCursor = null;
            let postBudgetReached = false;
            const expiredResponseUrls = new Set();
            const consumedDirectReplayUrls = new Set();

            const responseError = () => responseErrors.find(
                (entry) => !expiredResponseUrls.has(entry.url),
            ) ?? null;

            const throwResponseError = () => {
                const entry = responseError();
                if (!entry) return;
                const error = entry.error;
                const stop = error instanceof AuthError
                    ? 'auth_required'
                    : error instanceof BlockedError && error.kind === 'access_denied'
                        ? 'access_denied'
                        : error instanceof DomChangedError
                            ? 'markup_unrecognized'
                            : 'failed';
                throw decorateTraversalError(error, checkpoint, posts, stop, postsSeen);
            };

            const consumeParsed = (parsed, {
                source = 'head',
                inputCursor = null,
            } = {}) => {
                const pagePosts = Array.isArray(parsed?.posts) ? parsed.posts : [];
                postsSeen += pagePosts.length;
                const inputDetails = decodeGroupCursor(inputCursor);
                const skip = source === 'replay' ? (inputDetails.skip ?? 0) : 0;
                const merged = mergePosts(posts, pagePosts.slice(skip), maxPosts);
                const remainderCursor = encodeGroupCursor(
                    inputDetails.token, inputDetails.start, inputDetails.expiresAt,
                    skip + merged.consumed,
                );
                const nextCursor = parsed?.nextCursor
                    ? encodeGroupCursor(parsed.nextCursor, parsed.nextStart, parsed.nextCursorExpiresAt)
                    : null;
                const cursorExpiredAt = parsed?.nextCursorExpiresAt
                    && Number.isFinite(Number(parsed.nextCursorExpiresAt))
                    ? Number(parsed.nextCursorExpiresAt)
                    : null;

                if (source === 'replay') {
                    if (merged.truncated) {
                        durableCursor = remainderCursor;
                        postBudgetReached = true;
                    } else if (parsed?.exhausted && !parsed.nextCursor) {
                        durableCursor = null;
                        durableCursorExpiresAt = null;
                        durableExhausted = true;
                    } else if (nextCursor) {
                        durableCursor = nextCursor;
                        durableCursorExpiresAt = cursorExpiredAt;
                    } else {
                        // No token without a positive end marker is an
                        // unknown continuation state. Replay the same page on
                        // the next pass rather than skipping its tail.
                        durableCursor = inputCursor;
                        durableCursorExpiresAt = null;
                    }
                } else {
                    headInputCursor = inputCursor;
                    headCursor = nextCursor;
                    headCursorExpiresAt = cursorExpiredAt;
                    headCursorStart = parsed?.nextStart ?? null;
                    const headExhausted = parsed?.exhausted === true && !parsed.nextCursor;
                    // A head walk is the durable traversal only for a fresh
                    // session, or after an explicit expired-cursor fallback.
                    if (!resumeCursor || resumeCursorExpired) {
                        if (merged.truncated) {
                            durableCursor = remainderCursor;
                            durableCursorExpiresAt = null;
                            postBudgetReached = true;
                        } else if (headExhausted) {
                            durableCursor = null;
                            durableCursorExpiresAt = null;
                            durableExhausted = true;
                        } else if (nextCursor) {
                            durableCursor = nextCursor;
                            durableCursorExpiresAt = cursorExpiredAt;
                        } else {
                            durableCursor = inputCursor;
                            durableCursorExpiresAt = null;
                        }
                    }
                }
                return merged;
            };

            const consumeResponses = () => {
                let added = 0;
                let truncated = false;
                while (!postBudgetReached && consumedResponses < requestOrder.length) {
                    const responseUrl = requestOrder[consumedResponses];
                    const responsePage = responseSlotsByUrl.get(responseUrl);
                    // Do not advance over a request whose response body is
                    // still pending. This keeps pages contiguous even when a
                    // later response resolves first.
                    if (!responsePage?.ready) break;
                    consumedResponses += 1;
                    if (consumedDirectReplayUrls.has(responsePage.url)) continue;
                    const inputToken = requestCursor(responsePage.url);
                    const inputCursor = encodeGroupCursor(inputToken, requestStart(responsePage.url));
                    const merged = consumeParsed(responsePage.parsed, {
                        source: responsePage.source ?? 'head',
                        inputCursor,
                    });
                    added += merged.added;
                    truncated ||= merged.truncated;
                    if (resumeToken && inputToken === resumeToken) {
                        resumedPastCursor = true;
                    }
                }
                return { added, truncated };
            };

            await settleResponses();
            if (!resumeCursor) consumeResponses();
            throwResponseError();

            // Consume the durable cursor explicitly through the exact observed
            // same-origin GraphQL request. The browser supplies the cookie
            // jar; JSESSIONID is echoed as csrf-token just as the existing
            // LinkedIn client does. A stale token falls back to a fresh head
            // walk rather than making an expired opaque value permanent.
            if (resumeCursor) {
                let replayCursor = resumeCursor;
                let replayPages = 0;
                while (replayCursor && replayPages < maxScrolls && posts.length < maxPosts) {
                    if (timeBudgetMs > 0 && now() - startedAt >= timeBudgetMs) break;
                    const replayDetails = decodeGroupCursor(replayCursor);
                    if (replayDetails.expiresAt && replayDetails.expiresAt <= now()) {
                        resumeCursorExpired = true;
                        resumedPastCursor = true;
                        durableCursor = headCursor;
                        durableCursorExpiresAt = headCursorExpiresAt;
                        break;
                    }
                    const replayStart = replayDetails.start ?? headCursorStart;
                    const replayUrl = buildGroupPaginationUrl(replayCursor, replayStart);
                    if (!replayUrl) break;
                    replayUrls.add(replayUrl);
                    try {
                        const replay = await replayGroupCursor(page, replayCursor, cookies, {
                            start: replayStart,
                        });
                        if (replay?.expired) {
                            expiredResponseUrls.add(replay.url);
                            resumeCursorExpired = true;
                            resumedPastCursor = true;
                            durableCursor = null;
                            durableCursorExpiresAt = null;
                            break;
                        }
                        if (!replay?.parsed) break;
                        replayPages += 1;
                        consumedDirectReplayUrls.add(replay.url);
                        consumeParsed(replay.parsed, {
                            source: 'replay',
                            inputCursor: replayCursor,
                        });
                        resumedPastCursor = true;
                        await settleResponses();
                        throwResponseError();
                        if (postBudgetReached || durableExhausted) break;
                        const nextReplay = replay.parsed.nextCursor
                            ? encodeGroupCursor(
                                replay.parsed.nextCursor,
                                replay.parsed.nextStart,
                                replay.parsed.nextCursorExpiresAt,
                            )
                            : replayCursor;
                        if (nextReplay === replayCursor) break;
                        replayCursor = nextReplay;
                    } catch (error) {
                        responseErrors.push({ url: replayUrl, error });
                        throwResponseError();
                        break;
                    }
                }
            }

            consumeResponses();
            throwResponseError();

            for (let scroll = 0; scroll < maxScrolls; scroll += 1) {
                if (timeBudgetMs > 0 && now() - startedAt >= timeBudgetMs) {
                    stopReason = 'time_budget';
                    break;
                }
                if (postBudgetReached || posts.length >= maxPosts) {
                    stopReason = 'page_budget';
                    break;
                }
                await expandSeeMore(page);
                const markup = await page.content();
                if (hasAuthWall(markup, page.url?.() ?? '')) {
                    throw decorateTraversalError(
                        new AuthError('LinkedIn group feed requires authentication', {
                            platform: 'linkedin', code: 'NEEDS_RELOGIN',
                        }), checkpoint, posts, 'auth_required', postsSeen,
                    );
                }
                if (hasAccessDenied(markup)) {
                    throw decorateTraversalError(
                        new BlockedError('LinkedIn group feed access was denied', {
                            platform: 'linkedin', kind: 'access_denied',
                        }), checkpoint, posts, 'access_denied', postsSeen,
                    );
                }
                if (!hasRecognizedFeed(markup)) {
                    throw decorateTraversalError(
                        new DomChangedError('LinkedIn group feed markup was not recognized', {
                            platform: 'linkedin',
                        }), checkpoint, posts, 'markup_unrecognized', postsSeen,
                    );
                }

                const before = posts.length;
                const pagePosts = extractGroupPosts(markup, { groupId: group.id });
                postsSeen += pagePosts.length;
                const merged = mergePosts(posts, pagePosts, maxPosts);
                const added = merged.added;
                if (merged.truncated || posts.length >= maxPosts) {
                    postBudgetReached = true;
                    stopReason = 'page_budget';
                    break;
                }

                const requestCount = requests.length;
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout?.(scrollWaitMs);
                await settleResponses();
                const responseResult = consumeResponses();
                throwResponseError();
                if (postBudgetReached || posts.length >= maxPosts) {
                    stopReason = 'page_budget';
                    break;
                }
                const afterMarkup = await page.content();
                const afterPosts = extractGroupPosts(afterMarkup, { groupId: group.id });
                postsSeen += afterPosts.length;
                const afterMerged = mergePosts(posts, afterPosts, maxPosts);
                const afterAdded = posts.length - before;
                const requestAdded = requests.length - requestCount;
                if (resumeCursor && requests
                    .slice(requestCount)
                    .some((url) => requestCursor(url) === resumeToken)) {
                    resumedPastCursor = true;
                }
                if (afterMerged.truncated) {
                    postBudgetReached = true;
                    if (!resumeCursor || resumeCursorExpired) durableCursor = headInputCursor;
                    stopReason = 'page_budget';
                    break;
                }
                if (afterAdded === 0 && responseResult.added === 0 && requestAdded === 0 && added === 0) stableScrolls += 1;
                else stableScrolls = 0;
                if (stableScrolls >= 2) {
                    // No positive exhausted-feed signal was observed. Keep the
                    // source resumable even when the viewport stopped moving.
                    stopReason = 'page_budget';
                    break;
                }
                if (durableExhausted && !durableCursor) {
                    stopReason = 'exhausted';
                    break;
                }
            }

            await settleResponses();
            consumeResponses();
            throwResponseError();
            // A request alone proves no posts were received. Only consumed
            // response pages may advance the durable continuation.
            const cursorUsable = !durableCursorExpiresAt
                || Number(durableCursorExpiresAt) > now();
            const cursor = cursorUsable ? durableCursor : null;
            if (!cursor && !cursorUsable) durableCursor = null;
            const complete = durableExhausted && !cursor;
            const progressCheckpoint = checkpoint.history_complete || durableExhausted
                ? { ...checkpoint, history_complete: true }
                : checkpoint;
            const progress = buildGroupProgress({
                posts,
                checkpoint: progressCheckpoint,
                cursor,
                traversal: complete ? 'complete' : 'incomplete',
                stopReason: complete ? 'exhausted' : stopReason,
                postsSeen,
            });
            return {
                posts,
                pages: Math.max(requests.length, responsePages.length),
                emptyConfirmed: false,
                groupProgress: progress,
            };
        } finally {
            await context.close().catch(() => {});
        }
    });
}

/**
 * Collect a group feed through an injected observed-feed transport.
 *
 * The transport is intentionally a dependency rather than an invented
 * endpoint. It receives the leased session context and must return one page in
 * the shape consumed by `paginateGroupFeed` (`posts`, `nextCursor`, and an
 * optional positive `emptyConfirmed` flag). The production default is the
 * observed browser DOM collector below; this adapter remains useful for
 * sanitized fixture/replay tests and for a future reviewed response envelope.
 */
export async function collectGroupFeed({
    group,
    checkpoint,
    sessionId,
    session = getLinkedInRscSession(),
    fetchPage,
    parsePage,
    maxPages = 200,
    maxPosts = 5000,
    timeBudgetMs = 420_000,
    now,
} = {}) {
    if (!group || String(group.id) !== String(GROUP_ID)) {
        throw new ValidationError(`Unsupported LinkedIn group source: ${group?.id ?? 'missing'}`, {
            platform: 'linkedin',
        });
    }
    if (group.url !== GROUP_URL) {
        throw new ValidationError('LinkedIn group URL does not match the canonical source', {
            platform: 'linkedin',
        });
    }
    if (typeof fetchPage !== 'function') {
        // Do not silently treat a page obtained through an unverified path as a
        // complete history scan.  The transport is supplied by the live-feed
        // adapter after its sanitized capture is reviewed.
        throw new DomChangedError(
            'LinkedIn group feed transport is not configured from an observed capture',
            { platform: 'linkedin' },
        );
    }
    return paginateGroupFeed({
        fetchPage,
        parsePage,
        checkpoint,
        groupId: group.id,
        maxPages,
        maxPosts,
        timeBudgetMs,
        now,
    });
}

/**
 * Build the orchestrator-facing group scraper.
 *
 * `collector` is injectable for fixture tests and replay tooling. The default
 * collector uses `session.withCookies(sessionId, ...)` and
 * `launchPersistentProfile` inside that lease; this factory does not create a
 * second credential path or a fake role search.
 */
export function createLinkedInGroupScraper({
    collector = collectObservedGroupDom,
    session = null,
    collectorOptions = {},
} = {}) {
    if (typeof collector !== 'function') throw new ValidationError('LinkedIn group collector must be a function');
    return {
        async executeWithMeta(_role, location, sessionId, options = {}) {
            const group = options.group;
            const result = await collector({
                ...collectorOptions,
                ...(session ? { session } : {}),
                group,
                checkpoint: group?.checkpoint ?? null,
                sessionId,
            });
            const posts = Array.isArray(result?.posts) ? result.posts : [];
            return {
                jobs: posts.map((post) => postToJob(post, location)),
                emptyConfirmed: result?.emptyConfirmed === true,
                groupProgress: result?.groupProgress ?? result?.group_progress ?? null,
            };
        },
    };
}
