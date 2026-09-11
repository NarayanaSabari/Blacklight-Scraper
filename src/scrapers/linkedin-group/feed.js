// Pure helpers for the observed LinkedIn group feed.
//
// The group transport is deliberately kept separate from this module.  The
// authenticated feed has changed transport shapes before, and the transport
// must be selected from a sanitized capture rather than guessed from the
// content-search endpoint used by ordinary role sweeps.

import { load } from 'cheerio';
import {
    AuthError,
    BlockedError,
    DomChangedError,
    ValidationError,
} from '../../core/errors.js';
import {
    isNewerThan,
} from '../linkedin-rsc/high-water.js';
import { postedAtFromActivityId } from '../linkedin-rsc/extract.js';

export const GROUP_ID = 10472901;
export const GROUP_URL = `https://www.linkedin.com/groups/${GROUP_ID}/`;
export const GROUP_CHECKPOINT_VERSION = 1;
export const GROUP_MAX_CURSOR_LENGTH = 512;

const BLOCKED_MARKERS = [
    /join this group/i,
    /request to join/i,
    /you.re not authorized/i,
    /you don.t have access/i,
    /page not found/i,
    /sign in to linkedin/i,
    /log in to linkedin/i,
];

function textFromNode(node) {
    if (!node) return '';
    if (node.type === 'text') return node.data ?? '';
    if (node.name === 'br') return '\n';
    const childText = (node.children ?? []).map(textFromNode).join('');
    return /^(?:p|div|li|section|article|h[1-6])$/i.test(node.name ?? '')
        ? `${childText}\n`
        : childText;
}

function elementText(element) {
    const node = element?.get?.(0);
    return textFromNode(node)
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function activityIdFromUrn(value) {
    const urn = String(value ?? '');
    const activity = urn.match(/^urn:li:activity:(\d+)$/);
    if (activity) return activity[1];
    const groupPost = urn.match(/^urn:li:groupPost:(\d+)-(\d+)$/);
    return groupPost?.[2] ?? null;
}

function groupIdFromUrn(value) {
    const match = String(value ?? '').match(/^urn:li:groupPost:(\d+)-\d+$/);
    return match?.[1] ?? null;
}

function canonicalPostUrl(activityId) {
    return activityId
        ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}`
        : null;
}

function recordFromCapture(capture, { groupId = GROUP_ID } = {}) {
    const activityId = String(capture?.activityId ?? activityIdFromUrn(capture?.activityUrn) ?? '');
    if (!/^\d+$/.test(activityId) || activityId === String(groupId)) return null;
    const text = String(capture?.bodyText ?? '').trim();
    if (!text) return null;
    const { emails, phones } = contactsFrom(text);
    const url = canonicalPostUrl(activityId);
    return {
        activity_id: activityId,
        activityId,
        post_url: url,
        url,
        posted_at: capture?.postedAt ?? postedAtFromActivityId(activityId),
        author_handle: capture?.authorHandle ?? '',
        author_profile: capture?.authorProfile ?? null,
        group_id: String(capture?.groupId ?? groupId),
        group_post_urn: capture?.groupPostUrn ?? null,
        hashtags: hashtagsFrom(text),
        text,
        text_length: text.length,
        contact_emails: emails,
        contact_phones: phones,
    };
}

function textValue(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
    return '';
}

function activityIdFromAnyUrn(value) {
    const text = String(value ?? '');
    const direct = text.match(/urn:li:activity:(\d+)/);
    if (direct) return direct[1];
    return activityIdFromUrn(text);
}

function groupIdFromAnyUrn(value) {
    const text = String(value ?? '');
    const group = text.match(/urn:li:(?:fsd_)?group:(\d+)/);
    if (group) return group[1];
    return groupIdFromUrn(text);
}

function profileUrnFromActor(actor) {
    const attributes = [
        ...(actor?.name?.attributesV2 ?? []),
        ...(actor?.name?.accessibilityTextAttributesV2 ?? []),
    ];
    for (const attribute of attributes) {
        const profileUrn = attribute?.detailData?.['*profileFullName'];
        if (profileUrn) return profileUrn;
    }
    for (const attribute of actor?.image?.attributes ?? []) {
        const profileUrn = attribute?.detailData?.nonEntityProfilePicture?.['*profile'];
        if (profileUrn) return profileUrn;
    }
    return null;
}

function profileCaptureFromActor(actor, includedByUrn) {
    const profileUrn = profileUrnFromActor(actor);
    const profile = profileUrn ? includedByUrn.get(profileUrn) : null;
    const handle = profile?.publicIdentifier ?? '';
    return {
        authorHandle: handle,
        authorProfile: handle ? `https://www.linkedin.com/in/${handle}` : null,
    };
}

function updateCaptureFromGraphql(update, includedByUrn, { groupId = GROUP_ID } = {}) {
    const metadata = update?.metadata ?? {};
    const activityId = [
        // The update entity is the canonical search/dedup identity. A
        // groupPost share URN can carry a different numeric suffix for the
        // same rendered update and must remain provenance only.
        update?.entityUrn,
        update?.preDashEntityUrn,
        metadata.backendUrn,
        metadata.shareUrn,
    ].map(activityIdFromAnyUrn).find(Boolean);
    const embeddedGroupId = [
        metadata['*group'],
        metadata.shareUrn,
        update?.entityUrn,
    ].map(groupIdFromAnyUrn).find(Boolean);
    if (embeddedGroupId && String(embeddedGroupId) !== String(groupId)) return null;

    const text = textValue(update?.commentary?.text).trim();
    if (!activityId || !text) return null;
    return recordFromCapture({
        activityId,
        bodyText: text,
        groupId: embeddedGroupId ?? groupId,
        groupPostUrn: typeof metadata.shareUrn === 'string'
            && metadata.shareUrn.startsWith('urn:li:groupPost:')
            ? metadata.shareUrn
            : null,
        ...profileCaptureFromActor(update?.actor, includedByUrn),
    }, { groupId });
}

function graphqlFeedObject(page) {
    const root = page?.data?.data ?? page?.data ?? page;
    return root?.feedDashGroupsUpdatesByGroupsFeed ?? null;
}

function hasExplicitGraphqlEnd(feed) {
    return feed?.exhausted === true
        || feed?.endOfFeed === true
        || feed?.metadata?.exhausted === true
        || feed?.metadata?.endOfFeed === true
        || feed?.metadata?.hasMore === false
        || feed?.paging?.hasMore === false
        || feed?.paging?.isLastPage === true
        || feed?.paging?.endOfFeed === true;
}

/**
 * Parse the observed `voyagerFeedDashGroupsUpdates` response envelope.
 *
 * The live capture has a normalized `data.feedDashGroupsUpdatesByGroupsFeed`
 * object.  Playwright's raw response additionally stores update elements as
 * URN references under `*elements` and resolves them in `included`; both
 * forms are accepted because they are the two observed representations of
 * the same response.  A missing pagination token is not treated as the end
 * of history unless the response carries an explicit end marker.
 */
export function parseGroupGraphqlResponse(page, { groupId = GROUP_ID } = {}) {
    if (page?.errors) {
        throw new DomChangedError('LinkedIn group GraphQL response contained errors', { platform: 'linkedin' });
    }
    const feed = graphqlFeedObject(page);
    if (!feed || typeof feed !== 'object') {
        throw new DomChangedError('LinkedIn group GraphQL feed response was not recognized', { platform: 'linkedin' });
    }
    const includedByUrn = new Map(
        (Array.isArray(page?.included) ? page.included : [])
            .filter((entry) => entry && typeof entry === 'object' && entry.entityUrn)
            .map((entry) => [entry.entityUrn, entry]),
    );
    const references = Array.isArray(feed.elements)
        ? feed.elements
        : Array.isArray(feed['*elements'])
            ? feed['*elements']
            : null;
    if (!references) {
        throw new DomChangedError('LinkedIn group GraphQL elements were not recognized', { platform: 'linkedin' });
    }
    const posts = references
        .map((entry) => {
            const update = typeof entry === 'string' ? includedByUrn.get(entry) : entry;
            return updateCaptureFromGraphql(update, includedByUrn, { groupId });
        })
        .filter(Boolean);
    const nextCursor = feed.metadata?.paginationToken
        ?? feed.pagination?.paginationToken
        ?? feed.nextCursor
        ?? null;
    const start = Number(feed.paging?.start);
    const count = Number(feed.paging?.count);
    return {
        posts: dedupeGroupPosts(posts),
        nextCursor: normalizeCursor(nextCursor),
        nextStart: nextCursor !== null && Number.isFinite(start) && Number.isFinite(count)
            ? start + count
            : null,
        nextCursorExpiresAt: feed.metadata?.paginationTokenExpiryTime
            ?? feed.pagination?.paginationTokenExpiryTime
            ?? null,
        exhausted: hasExplicitGraphqlEnd(feed),
        emptyConfirmed: feed.emptyConfirmed === true || feed.metadata?.emptyConfirmed === true,
    };
}

function profileFromElement($, element) {
    const href = $(element).find('a[href*="/in/"]').first().attr('href') ?? null;
    if (!href) return { authorProfile: null, authorHandle: '' };
    let url;
    try { url = new URL(href, 'https://www.linkedin.com'); }
    catch { return { authorProfile: null, authorHandle: '' }; }
    if (url.hostname !== 'www.linkedin.com' && url.hostname !== 'linkedin.com') {
        return { authorProfile: null, authorHandle: '' };
    }
    const match = url.pathname.match(/^\/in\/([^/?#]+)/i);
    return {
        authorProfile: match ? `https://www.linkedin.com/in/${match[1]}` : null,
        authorHandle: match?.[1] ?? '',
    };
}

function contactsFrom(text) {
    return {
        emails: [...new Set(
            [...String(text).matchAll(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g)].map((m) => m[0]),
        )],
        phones: [...new Set(
            [...String(text).matchAll(/(?:\+?\d{1,2}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g)]
                .map((m) => m[0].trim())
                .filter((p) => p.replace(/\D/g, '').length >= 10),
        )],
    };
}

function hashtagsFrom(text) {
    return [...new Set([...String(text).matchAll(/#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]))];
}

function blockedMarkup(html) {
    const text = String(html ?? '').replace(/<[^>]+>/g, ' ');
    return BLOCKED_MARKERS.some((marker) => marker.test(text));
}

/**
 * Extract post records from the authenticated group DOM.
 *
 * The live group uses one `.occludable-update` per card, with the canonical
 * activity URN on `[data-view-name="feed-full-update"]` and commentary in
 * `.update-components-update-v2__commentary`.  See-more controls must be
 * expanded by the browser transport before this function is called.
 */
export function extractGroupPosts(markup, { groupId = GROUP_ID } = {}) {
    // The tester's sanitized first-card capture intentionally replaces the
    // middle of its HTML with an omission marker.  Its body/activity fields are
    // still real observations, so consume that explicit adapter shape without
    // claiming the truncated markup proves selector coverage.
    if (markup && typeof markup === 'object') {
        const fromCapture = recordFromCapture(markup, { groupId });
        if (fromCapture) return [fromCapture];
        if (markup.html !== undefined) return extractGroupPosts(markup.html, { groupId });
        return [];
    }
    const html = String(markup ?? '');
    const $ = load(html, { decodeEntities: true });
    const views = $('.occludable-update [data-view-name="feed-full-update"]');
    const roots = views.length > 0
        ? views
        : $('[data-view-name="feed-full-update"]');
    if (roots.length === 0 && blockedMarkup(html)) return [];
    const posts = [];
    const seen = new Set();

    roots.each((_index, update) => {
        const urn = $(update).attr('data-urn')
            ?? $(update).find('[data-urn]').first().attr('data-urn');
        const activityId = activityIdFromUrn(urn);
        if (!activityId || seen.has(activityId)) return;
        const embeddedGroupId = groupIdFromUrn(urn);
        if (embeddedGroupId && String(embeddedGroupId) !== String(groupId)) return;

        const root = $(update).closest('.occludable-update');
        const commentary = root.find('.update-components-update-v2__commentary').first();
        const body = commentary.length > 0
            ? elementText(commentary)
            : elementText(root.find('[data-view-name="commentary"]').first());
        // A card without its commentary is not a usable job payload. It may be
        // a collapsed shell, so leave it for the browser expansion path rather
        // than forwarding an incomplete title/body.
        if (!body) return;

        const time = root.find('time[datetime]').first().attr('datetime') ?? null;
        const { authorProfile, authorHandle } = profileFromElement($, root);
        const { emails, phones } = contactsFrom(body);
        const url = canonicalPostUrl(activityId);
        seen.add(activityId);
        posts.push({
            activity_id: String(activityId),
            activityId: String(activityId),
            post_url: url,
            url,
            posted_at: time || postedAtFromActivityId(activityId),
            author_handle: authorHandle,
            author_profile: authorProfile,
            group_id: embeddedGroupId ?? String(groupId),
            hashtags: hashtagsFrom(body),
            text: body,
            text_length: body.length,
            contact_emails: emails,
            contact_phones: phones,
        });
    });
    return posts;
}

function compareActivityIds(a, b) {
    if (a === b) return 0;
    if (isNewerThan(a, b)) return 1;
    if (isNewerThan(b, a)) return -1;
    return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Deduplicate repeated/pinned cards while retaining the most complete body. */
export function dedupeGroupPosts(posts) {
    const byId = new Map();
    for (const post of posts ?? []) {
        const key = String(post?.activity_id ?? post?.activityId ?? post?.post_url ?? post?.url ?? '');
        if (!key) continue;
        const existing = byId.get(key);
        if (!existing || String(post.text ?? '').length > String(existing.text ?? '').length) {
            byId.set(key, post);
        }
    }
    return [...byId.values()];
}

function normalizeCursor(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || value.length > GROUP_MAX_CURSOR_LENGTH) {
        throw new ValidationError('LinkedIn group checkpoint cursor is invalid', { platform: 'linkedin' });
    }
    return value;
}

export function normalizeGroupCheckpoint(value = null) {
    const checkpoint = value && typeof value === 'object' ? value : {};
    if (checkpoint.version !== undefined && checkpoint.version !== GROUP_CHECKPOINT_VERSION) {
        throw new ValidationError('Unsupported LinkedIn group checkpoint version', { platform: 'linkedin' });
    }
    for (const field of ['oldest_activity_id', 'watermark_posted_at']) {
        if (checkpoint[field] !== undefined && checkpoint[field] !== null
            && typeof checkpoint[field] !== 'string') {
            throw new ValidationError(`LinkedIn group checkpoint ${field} is invalid`, { platform: 'linkedin' });
        }
    }
    if (checkpoint.oldest_activity_id && checkpoint.oldest_activity_id.length > 255) {
        throw new ValidationError('LinkedIn group activity checkpoint is too long', { platform: 'linkedin' });
    }
    if (checkpoint.watermark_posted_at && checkpoint.watermark_posted_at.length > 40) {
        throw new ValidationError('LinkedIn group watermark checkpoint is too long', { platform: 'linkedin' });
    }
    return {
        version: GROUP_CHECKPOINT_VERSION,
        cursor: normalizeCursor(checkpoint.cursor),
        oldest_activity_id: checkpoint.oldest_activity_id ?? null,
        watermark_posted_at: checkpoint.watermark_posted_at ?? null,
        history_complete: checkpoint.history_complete === true,
    };
}

function newerPostedAt(a, b) {
    if (!a) return b ?? null;
    if (!b) return a;
    return Date.parse(b) > Date.parse(a) ? b : a;
}

function olderActivityId(a, b) {
    if (!a) return b ?? null;
    if (!b) return a;
    return compareActivityIds(a, b) <= 0 ? a : b;
}

/**
 * Parse one already-captured page.  A transport-specific JSON parser can be
 * supplied by the browser collector once the observed GraphQL fixture is
 * known; this default intentionally only accepts the explicit DOM/adapter
 * shape and never guesses at LinkedIn's private response schema.
 */
export function parseGroupPage(page, options = {}) {
    if (typeof page === 'string') {
        const posts = extractGroupPosts(page, options);
        const hasFeed = /data-view-name=["']feed-full-update/i.test(page)
            || /occludable-update/i.test(page);
        if (!hasFeed) throw new DomChangedError('LinkedIn group feed markup was not recognized', { platform: 'linkedin' });
        return {
            posts,
            nextCursor: null,
            exhausted: false,
            emptyConfirmed: false,
        };
    }
    if (!page || typeof page !== 'object') {
        throw new DomChangedError('LinkedIn group page response was not recognized', { platform: 'linkedin' });
    }
    if (page.response && typeof page.response === 'object') {
        return parseGroupPage(page.response, options);
    }
    if (page.authRequired) {
        throw new AuthError('LinkedIn group feed requires authentication', {
            platform: 'linkedin', code: 'NEEDS_RELOGIN',
        });
    }
    if (page.accessDenied) {
        throw new BlockedError('LinkedIn group feed access was denied', {
            platform: 'linkedin', kind: 'access_denied',
        });
    }
    if (page.html !== undefined) {
        const parsed = parseGroupPage(page.html, options);
        return {
            ...parsed,
            nextCursor: normalizeCursor(page.nextCursor ?? page.next_cursor ?? null),
            exhausted: page.exhausted === true,
        };
    }
    if (graphqlFeedObject(page)) return parseGroupGraphqlResponse(page, options);
    if (Array.isArray(page.posts)) {
        return {
            posts: dedupeGroupPosts(page.posts),
            nextCursor: normalizeCursor(page.nextCursor ?? page.next_cursor ?? null),
            emptyConfirmed: page.emptyConfirmed === true,
            exhausted: page.exhausted === true,
        };
    }
    throw new DomChangedError('LinkedIn group page response shape was not recognized', { platform: 'linkedin' });
}

function checkpointAfter(posts, checkpoint, cursor, historyComplete) {
    const ids = posts
        .map((post) => String(post.activity_id ?? post.activityId ?? ''))
        .filter(Boolean);
    const oldest = ids.reduce((current, id) => olderActivityId(current, id), null);
    const newestPosted = posts.reduce(
        (current, post) => newerPostedAt(current, post.posted_at),
        null,
    );
    return normalizeGroupCheckpoint({
        ...checkpoint,
        cursor,
        oldest_activity_id: olderActivityId(checkpoint.oldest_activity_id, oldest),
        watermark_posted_at: newerPostedAt(checkpoint.watermark_posted_at, newestPosted),
        // Once a complete history traversal has been acknowledged, later
        // incremental or budgeted traversals must retain that fact.  The
        // server uses this bit to distinguish an initial partial scan from a
        // source whose history was already exhausted at least once.
        history_complete: checkpoint.history_complete === true || historyComplete === true,
    });
}

function unchangedGroupProgress({ checkpoint, traversal = 'incomplete', stopReason, postsSeen = 0 } = {}) {
    const normalized = normalizeGroupCheckpoint(checkpoint);
    return {
        checkpoint: normalized,
        traversal: traversal === 'complete' ? 'complete' : 'incomplete',
        stop_reason: stopReason,
        posts_seen: Number.isFinite(postsSeen) ? Math.max(0, Math.trunc(postsSeen)) : 0,
    };
}

export function buildGroupProgress({
    posts = [],
    checkpoint = null,
    cursor = null,
    traversal = 'incomplete',
    stopReason = 'page_budget',
    postsSeen = posts.length,
    advanceCheckpoint = true,
} = {}) {
    const complete = traversal === 'complete';
    return {
        checkpoint: advanceCheckpoint
            ? checkpointAfter(
                dedupeGroupPosts(posts),
                normalizeGroupCheckpoint(checkpoint),
                complete ? null : normalizeCursor(cursor),
                complete,
            )
            : normalizeGroupCheckpoint(checkpoint),
        traversal: complete ? 'complete' : 'incomplete',
        stop_reason: stopReason,
        posts_seen: Number.isFinite(postsSeen) ? Math.max(0, Math.trunc(postsSeen)) : 0,
    };
}

/**
 * Walk pages and return jobs plus a proposed checkpoint.
 *
 * The caller submits this proposal with the one accepted batch.  This function
 * never persists local high-water state, so a failed delivery cannot advance
 * the source past undelivered posts.
 */
export async function paginateGroupFeed({
    fetchPage,
    parsePage = parseGroupPage,
    checkpoint: rawCheckpoint = null,
    groupId = GROUP_ID,
    maxPages = 200,
    maxPosts = 5000,
    timeBudgetMs = 420_000,
    now = () => Date.now(),
} = {}) {
    if (typeof fetchPage !== 'function') throw new ValidationError('Group feed fetchPage is required');
    const checkpoint = normalizeGroupCheckpoint(rawCheckpoint);
    const startedAt = now();
    const seen = new Set();
    const posts = [];
    const pages = [];
    let cursor = checkpoint.cursor;
    let emptyConfirmed = false;
    let stopReason = 'page_budget';
    let repeatedPage = false;

    for (let pageNumber = 0; pageNumber < maxPages && posts.length < maxPosts; pageNumber += 1) {
        if (timeBudgetMs > 0 && now() - startedAt >= timeBudgetMs) {
            stopReason = 'time_budget';
            break;
        }
        let parsed;
        try {
            const response = await fetchPage({ cursor, checkpoint, page: pageNumber });
            parsed = parsePage(response, { groupId });
        } catch (error) {
            const errorStopReason = error instanceof AuthError
                ? 'auth_required'
                : error instanceof BlockedError && error.kind === 'access_denied'
                    ? 'access_denied'
                    : error instanceof DomChangedError
                        ? 'markup_unrecognized'
                        : 'failed';
            const progress = unchangedGroupProgress({
                checkpoint,
                stopReason: errorStopReason,
                postsSeen: pages.reduce((sum, page) => sum + page.posts_seen, 0),
            });
            if (error && typeof error === 'object') error.groupProgress ??= progress;
            throw error;
        }
        const pagePosts = dedupeGroupPosts(parsed.posts);
        let added = 0;
        let reachedPostBudget = false;
        for (const post of pagePosts) {
            // Keep the current cursor when the batch cap is reached in the
            // middle of a page. The unvisited remainder will be fetched again
            // on the next session instead of being skipped forever.
            if (posts.length >= maxPosts) {
                reachedPostBudget = true;
                break;
            }
            const key = String(post.activity_id ?? post.activityId ?? post.post_url ?? post.url ?? '');
            if (!key || seen.has(key)) continue;
            seen.add(key);
            posts.push(post);
            added += 1;
        }
        emptyConfirmed ||= parsed.emptyConfirmed === true;
        pages.push({ page: pageNumber + 1, posts_seen: pagePosts.length, posts_added: added });

        if (reachedPostBudget || posts.length >= maxPosts) {
            stopReason = 'page_budget';
            // `cursor` still identifies the page being consumed. If this was
            // the first page it remains null, so the next run safely resamples
            // the head and relies on backend activity-id deduplication.
            break;
        }

        const nextCursor = normalizeCursor(parsed.nextCursor ?? null);
        if (!nextCursor) {
            if (parsed.exhausted === true) {
                cursor = null;
                stopReason = 'exhausted';
            } else {
                // A response without a token is not proof that the feed ended.
                // The live probe exposed no positive end marker, so preserve a
                // resumable incomplete state until the transport supplies one.
                stopReason = 'page_budget';
            }
            break;
        }
        if (nextCursor === cursor || pages.some((entry) => entry.cursor === nextCursor)) {
            repeatedPage = true;
            cursor = nextCursor;
            stopReason = 'page_budget';
            break;
        }
        pages[pages.length - 1].cursor = nextCursor;
        cursor = nextCursor;
    }

    if (pages.length >= maxPages && cursor) stopReason = 'page_budget';
    if (timeBudgetMs > 0 && now() - startedAt >= timeBudgetMs && cursor) stopReason = 'time_budget';
    const complete = stopReason === 'exhausted' && !cursor;
    const proposedCheckpoint = checkpointAfter(posts, checkpoint, complete ? null : cursor, complete);
    return {
        posts: dedupeGroupPosts(posts),
        pages,
        emptyConfirmed: posts.length === 0 && emptyConfirmed,
        repeatedPage,
        groupProgress: {
            checkpoint: proposedCheckpoint,
            traversal: complete ? 'complete' : 'incomplete',
            stop_reason: stopReason,
            posts_seen: pages.reduce((sum, page) => sum + page.posts_seen, 0),
        },
    };
}
