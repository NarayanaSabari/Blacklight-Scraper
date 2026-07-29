// React-Server-Components "flight" payload parsing.
//
// LinkedIn's content-search data endpoint returns newline-delimited rows:
//
//     1:I["030d6035…",[],"default"]
//     2:["$","div",null,{"className":"…","children":[…]}]
//
// Each row is `<rowId>:<json>`. The rendered element tree is split across rows
// and joined by `$L<id>` / `$<id>` references. Element tuples are
// `["$", type, key, props]`.
//
// A post's commentary is either wrapped in an element keyed `text-attr-<n>`
// whose children are per-line elements keyed "0","1","2"…, or (a second render
// path) emitted as those keyed siblings directly with no wrapper. Both forms
// separate lines with `<br>` elements.

// An element tuple: ["$", type, key, props, …].
const isElement = (n) => Array.isArray(n) && n.length >= 4 && n[0] === '$';

const TEXT_ATTR_KEY = /^text-attr-\d+$/;

// Flight sentinels are strings beginning with a single "$": "$L2be" (component
// reference), "$2bb" (row reference), "$undefined", "$Sreact.fragment",
// "$D<iso>". A literal "$" in content is escaped as "$$".
function isSentinel(s) {
    return typeof s === 'string' && s.startsWith('$') && !s.startsWith('$$');
}
const unescapeDollar = (s) => (s.startsWith('$$') ? s.slice(1) : s);

/**
 * Split a flight body into its JSON-parseable rows.
 *
 * Rows whose payload is not JSON (`HL[...]` preload hints, partial stream rows)
 * are skipped rather than throwing. Byte offsets are retained because one post's
 * commentary row is linked to its card only by emission proximity.
 *
 * @param {string} body
 * @returns {Array<{id: string, value: unknown, offset: number}>}
 */
export function parseFlightRows(body) {
    const rows = [];
    let offset = 0;
    for (const line of String(body ?? '').split('\n')) {
        const start = offset;
        offset += line.length + 1;
        const sep = line.indexOf(':');
        if (sep <= 0) continue;
        const payload = line.slice(sep + 1);
        if (!/^[[{"]/.test(payload)) continue;
        let value;
        try { value = JSON.parse(payload); } catch { continue; }
        rows.push({ id: line.slice(0, sep), value, offset: start });
    }
    return rows;
}

/**
 * The raw (unparsed) payload of every row, keyed by row id.
 *
 * Callers need this alongside the parsed values for reference-following and
 * permalink lookup; producing it here keeps the payload to a single walk.
 *
 * @param {string} body
 * @returns {Map<string, string>}
 */
export function rawRowText(body) {
    const rows = new Map();
    for (const line of String(body ?? '').split('\n')) {
        const sep = line.indexOf(':');
        if (sep > 0) rows.set(line.slice(0, sep), line.slice(sep + 1));
    }
    return rows;
}

// A run of >=2 sibling elements keyed "0","1","2"… with no gaps. This is the
// wrapper-less body form; requiring two children keeps ordinary single-keyed
// markup from matching.
function isNumericKeyedGroup(node) {
    if (!Array.isArray(node)) return false;
    const keyed = node.filter((c) => isElement(c) && /^\d+$/.test(String(c[2])));
    if (keyed.length < 2) return false;
    const nums = keyed.map((c) => Number(c[2])).sort((a, b) => a - b);
    return nums[0] === 0 && nums[nums.length - 1] === nums.length - 1;
}

/**
 * Locate the text groups in a parsed row: elements keyed `text-attr-<n>` and
 * wrapper-less numeric-keyed sibling runs. Does not descend into a group it has
 * already matched.
 *
 * @param {unknown} node
 * @returns {unknown[]} group nodes, in traversal order
 */
export function findTextGroups(node, out = [], depth = 0) {
    if (depth > 24) return out;
    if (isNumericKeyedGroup(node)) { out.push(node); return out; }
    if (isElement(node)) {
        if (TEXT_ATTR_KEY.test(String(node[2]))) { out.push(node); return out; }
        for (let i = 3; i < node.length; i++) findTextGroups(node[i], out, depth + 1);
        return out;
    }
    if (Array.isArray(node)) {
        for (const child of node) findTextGroups(child, out, depth + 1);
        return out;
    }
    if (node && typeof node === 'object') {
        for (const value of Object.values(node)) findTextGroups(value, out, depth + 1);
    }
    return out;
}

// Ordered text leaves. Reads ONLY `children`: sibling props carry binding ids,
// state keys and i18n patterns, and sweeping them corrupts the body.
function textLeaves(node, out = [], depth = 0) {
    if (depth > 24) return out;
    if (typeof node === 'string') {
        if (!isSentinel(node)) out.push(unescapeDollar(node));
        return out;
    }
    if (isElement(node)) {
        // <br> carries the post's line structure. Skipping it as markup glues
        // paragraphs together.
        if (node[1] === 'br') { out.push('\n'); return out; }
        for (let i = 3; i < node.length; i++) textLeaves(node[i], out, depth + 1);
        return out;
    }
    if (Array.isArray(node)) {
        for (const child of node) textLeaves(child, out, depth + 1);
        return out;
    }
    if (node && typeof node === 'object' && 'children' in node) {
        textLeaves(node.children, out, depth + 1);
    }
    return out;
}

/**
 * Concatenate a text group into its rendered string.
 *
 * Fragments join with no separator: LinkedIn splits text mid-line, so inserting
 * spaces would corrupt words. Line structure comes from `<br>` alone.
 *
 * @param {unknown} group
 * @returns {string}
 */
export function groupText(group) {
    return textLeaves(group)
        .join('')
        .replace(/ /g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
