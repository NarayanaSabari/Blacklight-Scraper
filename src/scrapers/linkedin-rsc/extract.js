// Turn a content-search flight payload into post records.
//
// Structure (verified against live payloads, Jul 2026):
//
//   • Each post is ONE row (~190KB) carrying
//       componentkey":"expanded<hash>FeedType_FLAGSHIP_SEARCH
//     That row holds the post's permalink, so the permalink is the post identity.
//   • Cards are emitted TWICE — the virtual-scroll buffer renders each post in
//     duplicate. Dedupe on the permalink.
//   • The commentary is NOT in the card row. It sits either in a row the card
//     references via `$L<id>`, or in a row that merely FOLLOWS one it references
//     (no reference, no shared identifier — emission proximity only).
//
// Why not simpler approaches: permalinks occupy bytes 4-24MB of the payload
// while bodies sit at 35-37MB, so positional pairing misaligns; and bodies
// outnumber posts (reshared quotes, comments), so index-zipping misaligns too.

import { parseFlightRows, findTextGroups, groupText, rawRowText } from './flight.js';

const CARD_RE = /componentkey":"expanded[^"]*FeedType_FLAGSHIP_SEARCH/;
// A post is identified by its permalink, and there are TWO shapes:
//   personal feed: /posts/<handle>_<hashtags>-<share|activity|ugcPost>-<id>-<sfx>
//   inside a group: /feed/update/urn:li:groupPost:<groupId>-<activityId>
// Much bench-sales content is posted in groups, so recognising only the first
// shape both lost that data and made non-empty searches look empty.
const FEED_PERMALINK_RE = /https?:\/\/(?:www\.)?linkedin\.com\/posts\/[A-Za-z0-9_%-]+/;
const GROUP_PERMALINK_RE = /https?:\/\/(?:www\.)?linkedin\.com\/feed\/update\/urn:li:groupPost:\d+-\d+/;
const PERMALINK_RE = new RegExp(`${GROUP_PERMALINK_RE.source}|${FEED_PERMALINK_RE.source}`);
const REF_G = /"\$L?([0-9a-f]+)"/g;
// The flag arrives as a model state, with braces between the key and its value:
//   {"key":{...,"id":"SearchResultsSearchHasNoresultsBindingKey"}}},
//    "value":{"$case":"booleanValue","booleanValue":true}}
// so the gap must tolerate `}` rather than stopping at the first one.
const NO_RESULTS_RE = /HasNoresultsBindingKey"[\s\S]{0,240}?booleanValue":\s*true/;

// How far past a referenced row to look for a commentary row that is linked
// only by emission order.
const PROXIMITY_ROWS = 48;

// LinkedIn's own interface copy. It renders through the same text groups as post
// bodies, so it has to be excluded by content.
const UI_COPY = [
    /^Failed to post comment/i,
    /^Try again$/i,
    /^Unable to refresh/i,
    /^Something went wrong/i,
    /^Please try again/i,
    /^Are these results helpful/i,
    /^Yes, these search results are helpful/i,
    /^Thank you for your feedback/i,
    /^We.re unable to respond directly to your feedback/i,
    /^Your feedback/i,
    /^Tell us more/i,
    /^Tell them (what|why)/i,
    /^Report this post/i,
    /^What do you think/i,
    /^Add a comment/i,
    /^Load more comments/i,
    /^See more results/i,
    /^About this profile/i,
    /^Try searching for/i,
    /^People also viewed/i,
    /^Reaction button/i,
    /^Text editor for creating/i,
    /^Activate to view larger image/i,
    /^No alternative text/i,
    /^characters out of \d+/i,
    /customer support inquiry/i,
];
const isUiCopy = (text) => UI_COPY.some((re) => re.test(text.trim()));

/**
 * Decode a LinkedIn activity id into its creation timestamp.
 * The top bits of the id are epoch milliseconds (id >> 22).
 *
 * @param {string} activityId
 * @returns {string|null} ISO 8601, or null when the id is not plausible
 */
export function postedAtFromActivityId(activityId) {
    try {
        if (!/^\d{15,}$/.test(String(activityId))) return null;
        const ms = Number(BigInt(activityId) >> 22n);
        // Sanity-bound to LinkedIn's lifetime so a bogus id yields null, not 1970.
        if (ms < 1262304000000 || ms > Date.now() + 86400000) return null;
        return new Date(ms).toISOString();
    } catch {
        return null;
    }
}

/**
 * True when LinkedIn positively reported "no results" for the query, as opposed
 * to returning nothing for an unknown reason. Callers use this to tell a genuine
 * empty result from a silent block.
 *
 * @param {string} body raw flight payload
 */
export function isConfirmedEmpty(body) {
    return NO_RESULTS_RE.test(String(body ?? ''));
}

function contactsFrom(text) {
    const emails = [...new Set(
        [...text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g)].map((m) => m[0]),
    )];
    const phones = [...new Set(
        [...text.matchAll(/(?:\+?\d{1,2}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g)]
            .map((m) => m[0].trim())
            .filter((p) => p.replace(/\D/g, '').length >= 10),
    )];
    return { emails, phones };
}

function metaFromPermalink(url) {
    // Group post: urn:li:groupPost:<groupId>-<activityId>. The activity id is the
    // SECOND number; taking the first would yield the group id and break both
    // dedup and the posted-at decode.
    const group = url.match(/urn:li:groupPost:(\d+)-(\d+)/);
    if (group) {
        return {
            activityId: group[2],
            groupId: group[1],
            handle: '',        // group permalinks carry no author handle
            hashtags: [],
            source: 'group',
        };
    }
    const activityId = (url.match(/-(\d{15,})-/) || url.match(/(\d{15,})/) || [])[1] || '';
    const handle = (url.match(/\/posts\/([^_]+)_/) || [])[1] || '';
    const tagSlug = (url.match(/\/posts\/[^_]+_([a-z0-9-]+?)-(?:share|activity|ugcPost)-/) || [])[1] || '';
    return {
        activityId,
        groupId: null,
        handle,
        hashtags: tagSlug ? tagSlug.split('-').filter(Boolean) : [],
        source: 'feed',
    };
}

/**
 * Extract one record per post from a flight payload.
 *
 * @param {string} body raw flight payload
 * @returns {Array<object>} post records in document order
 */
export function extractPosts(body) {
    const raw = String(body ?? '');
    const rows = parseFlightRows(raw);

    // Text groups, indexed by the row that produced them.
    const textsByRow = new Map();
    for (const row of rows) {
        for (const group of findTextGroups(row.value)) {
            const text = groupText(group);
            if (text.length < 25 || isUiCopy(text)) continue;
            if (!textsByRow.has(row.id)) textsByRow.set(row.id, []);
            textsByRow.get(row.id).push({ text, offset: row.offset, rowId: row.id });
        }
    }

    // Raw row text, for reference-following and permalink lookup. Produced by the
    // same single pass as parseFlightRows: re-splitting a 37MB payload here cost a
    // second walk and a second copy of every row string.
    const rowText = rawRowText(raw);

    const refsOf = (id) => [...new Set(
        [...(rowText.get(id) ?? '').matchAll(REF_G)].map((m) => m[1]),
    )];

    // One card per permalink: the duplicate render is dropped BEFORE reference
    // counting, otherwise every commentary row looks like a shared component
    // (both copies reference it) and gets skipped.
    //
    // The permalink is NOT always inside the card row. LinkedIn renders the same
    // search in two shapes, and both occur in captured fixtures:
    //
    //   inline — the card row carries the permalink itself
    //   shell  — the card row is a ~3KB skeleton that REFERENCES a large content
    //            row holding the permalink
    //
    // Measured on the Windows host 2026-07-31: all 10 cards in a live payload were
    // the shell shape (card row 3017 bytes -> referenced row ~381KB with the
    // permalink), so an inline-only lookup found 0 permalinks, built an empty
    // cardByUrl and returned 0 posts from a payload that plainly contained 12 of
    // them. Look inline first, then one level into the card's own references.
    const cardByUrl = new Map();
    for (const [id, text] of rowText) {
        if (!CARD_RE.test(text)) continue;
        let url = (text.match(PERMALINK_RE) || [])[0];
        if (!url) {
            for (const ref of refsOf(id)) {
                const found = (rowText.get(ref) ?? '').match(PERMALINK_RE);
                if (found) { url = found[0]; break; }
            }
        }
        if (url && !cardByUrl.has(url)) cardByUrl.set(url, id);
    }

    // Rows referenced by more than one card are shared layout components; taking
    // their text would leak one post's content into another.
    const refCount = new Map();
    for (const id of cardByUrl.values()) {
        for (const ref of refsOf(id)) refCount.set(ref, (refCount.get(ref) ?? 0) + 1);
    }

    const claimed = new Set();
    const posts = [];

    for (const [url, cardId] of cardByUrl) {
        const collected = [];
        const seenRows = new Set();
        const walk = (id, depth) => {
            if (depth > 3 || seenRows.has(id)) return;
            seenRows.add(id);
            for (const block of textsByRow.get(id) ?? []) collected.push(block);
            for (const ref of refsOf(id)) {
                if ((refCount.get(ref) ?? 0) > 1) continue;
                if (rowText.has(ref)) walk(ref, depth + 1);
            }
        };
        walk(cardId, 0);

        // Proximity fallback: one card's commentary row is linked by neither a
        // reference nor an identifier, only by sitting a few rows after a row the
        // card does reference. Scoped to cards that found nothing so it cannot
        // disturb correctly-linked posts.
        if (collected.length === 0) {
            const anchors = refsOf(cardId)
                .map((r) => Number.parseInt(r, 16))
                .filter(Number.isFinite);
            let best = null;
            for (const [rowId, blocks] of textsByRow) {
                if (claimed.has(rowId)) continue;
                const n = Number.parseInt(rowId, 16);
                if (!Number.isFinite(n)) continue;
                const distance = Math.min(...anchors.map((a) => Math.abs(n - a)));
                if (!Number.isFinite(distance) || distance > PROXIMITY_ROWS) continue;
                if (!best || distance < best.distance) best = { distance, rowId, blocks };
            }
            if (best) collected.push(...best.blocks);
        }
        // Mark every row this post consumed, so a later card's proximity fallback
        // cannot reach back and take it. Blocks must carry rowId for this to work;
        // without it the set filled with `undefined` and the guard was inert.
        for (const block of collected) claimed.add(block.rowId);

        // A body is split across several groups (e.g. two listings plus a footer);
        // keeping only the longest truncates the post.
        collected.sort((a, b) => a.offset - b.offset);
        const seenText = new Set();
        const parts = [];
        for (const block of collected) {
            const norm = block.text.replace(/\s+/g, ' ').trim();
            if (seenText.has(norm)) continue;
            seenText.add(norm);
            parts.push(block.text);
        }
        const text = parts.join('\n\n').trim();

        const { activityId, groupId, handle, hashtags, source } = metaFromPermalink(url);
        const { emails, phones } = contactsFrom(text);

        posts.push({
            activity_id: activityId,
            post_url: url,
            posted_at: postedAtFromActivityId(activityId),
            source,
            group_id: groupId,
            author_handle: handle,
            hashtags,
            text,
            text_length: text.length,
            contact_emails: emails,
            contact_phones: phones,
        });
    }

    return posts;
}
