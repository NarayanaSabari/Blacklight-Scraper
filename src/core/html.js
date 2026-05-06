// HTML utilities. Single-pass entity decoding via one combined regex
// (previous implementation ran one regex per entity in a loop).

const NAMED_ENTITIES = Object.freeze({
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    mdash: '-',
    ndash: '-',
    bull: '*',
    hellip: '...',
    lsquo: "'",
    rsquo: "'",
    ldquo: '"',
    rdquo: '"',
});

const NAMED_ALTS = Object.keys(NAMED_ENTITIES).concat(['#39']);
const NAMED_REGEX = new RegExp(`&(${NAMED_ALTS.join('|')});`, 'g');
const NUMERIC_DEC = /&#(\d+);/g;
const NUMERIC_HEX = /&#x([0-9a-f]+);/gi;
const TAG_REGEX = /<[^>]*>/g;
const WHITESPACE_REGEX = /\s+/g;

export function decodeEntities(input) {
    if (!input || typeof input !== 'string') return input;
    return input
        .replace(NAMED_REGEX, (_, name) => {
            if (name === '#39') return "'";
            return NAMED_ENTITIES[name] ?? `&${name};`;
        })
        .replace(NUMERIC_DEC, (_, dec) => String.fromCharCode(Number(dec)))
        .replace(NUMERIC_HEX, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function stripHtmlTags(input) {
    if (!input || typeof input !== 'string') return input;
    return decodeEntities(input.replace(TAG_REGEX, ''))
        .replace(WHITESPACE_REGEX, ' ')
        .trim();
}

export function sanitizeFilename(text) {
    return String(text).replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

export function generateTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

// djb2 hash — used to derive a stable platform_job_id when a URL has no
// structured identifier. Small and deterministic.
export function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return `h${(hash >>> 0).toString(36)}`;
}
