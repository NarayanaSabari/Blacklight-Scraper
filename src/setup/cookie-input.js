// Pure cookie-input parsing/validation for the setup wizard.
// No I/O of its own: file reads go through an injected `readFile`.
import fs from 'node:fs';

const looksLikeJson = (s) => {
    const t = s.trimStart();
    return t.startsWith('[') || t.startsWith('{');
};

/**
 * @param {string} input  a pasted JSON blob OR a filesystem path
 * @param {{readFile?: (p:string)=>string}} [deps]
 * @returns {Array<object>} normalized cookie array
 * @throws {Error} with a user-facing message on failure
 */
export function parseCookieInput(input, { readFile = (p) => fs.readFileSync(p, 'utf-8') } = {}) {
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('No cookie input provided — paste the Chrome cookie-export array, or give a path to it.');
    let text;
    if (looksLikeJson(raw)) {
        text = raw;
    } else {
        try {
            text = readFile(raw);
        } catch (e) {
            throw new Error(`Could not read cookie file "${raw}": ${e.message}`);
        }
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Input is not valid JSON (paste the Chrome cookie-export array, or give a path to it).');
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.cookies)) return parsed.cookies;
    throw new Error('Cookie JSON must be an array, or an object with a "cookies" array.');
}

/** @returns {{ok: boolean, reason?: string}} */
export function validateLinkedinCookies(arr) {
    if (!Array.isArray(arr) || arr.length === 0) {
        return { ok: false, reason: 'Expected a non-empty JSON array of cookies.' };
    }
    if (!arr.some((c) => c && c.name === 'li_at')) {
        return { ok: false, reason: 'Missing the LinkedIn "li_at" auth cookie — export cookies while logged in to LinkedIn.' };
    }
    return { ok: true };
}
