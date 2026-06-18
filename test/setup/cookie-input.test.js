import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookieInput, validateLinkedinCookies } from '../../src/setup/cookie-input.js';

const LI = [{ name: 'li_at', value: 'x', domain: '.www.linkedin.com' },
             { name: 'bcookie', value: 'y', domain: '.linkedin.com' }];

test('parseCookieInput: a pasted JSON array', () => {
    assert.deepEqual(parseCookieInput(JSON.stringify(LI)), LI);
});
test('parseCookieInput: a {cookies:[...]} object blob', () => {
    assert.deepEqual(parseCookieInput(JSON.stringify({ cookies: LI })), LI);
});
test('parseCookieInput: a file path (injected readFile)', () => {
    const got = parseCookieInput('/tmp/cookies.json', { readFile: () => JSON.stringify(LI) });
    assert.deepEqual(got, LI);
});
test('parseCookieInput: throws a clear message on non-JSON / unreadable path', () => {
    assert.throws(() => parseCookieInput('not json, no [', { readFile: () => { throw new Error('ENOENT'); } }),
        /could not read|not valid json/i);
});
test('validateLinkedinCookies: rejects non-array / empty / missing li_at; accepts with li_at', () => {
    assert.equal(validateLinkedinCookies(null).ok, false);
    assert.equal(validateLinkedinCookies([]).ok, false);
    assert.equal(validateLinkedinCookies([{ name: 'bcookie', value: 'y' }]).ok, false);
    assert.match(validateLinkedinCookies([{ name: 'bcookie' }]).reason, /li_at/);
    assert.equal(validateLinkedinCookies(LI).ok, true);
});
test('parseCookieInput: empty / whitespace / null input gives a clear "no input" error', () => {
    assert.throws(() => parseCookieInput(''), /no cookie input/i);
    assert.throws(() => parseCookieInput('   '), /no cookie input/i);
    assert.throws(() => parseCookieInput(null), /no cookie input/i);
});
test('parseCookieInput: a JSON object without a cookies array throws "must be an array"', () => {
    assert.throws(() => parseCookieInput('{"a":1}'), /must be an array/i);
});
