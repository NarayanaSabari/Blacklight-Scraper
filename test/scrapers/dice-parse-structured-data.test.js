import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStructuredData } from '../../scrapers/dice.js';

const FIXTURE = fs.readFileSync(new URL('../fixtures/dice-structured-data.json', import.meta.url), 'utf-8');

test('parseStructuredData: real fixture parses to a JobPosting object', () => {
    const { data, error } = parseStructuredData(FIXTURE);
    assert.equal(error, null);
    assert.equal(data['@type'], 'JobPosting');
    assert.ok(data.title.length > 0);
});

test('parseStructuredData: empty string → error', () => {
    const { data, error } = parseStructuredData('');
    assert.equal(data, null);
    assert.match(error, /empty/i);
});

test('parseStructuredData: null/undefined → error', () => {
    assert.equal(parseStructuredData(null).data, null);
    assert.match(parseStructuredData(null).error, /empty/i);
    assert.equal(parseStructuredData(undefined).data, null);
});

test('parseStructuredData: malformed JSON → error', () => {
    const { data, error } = parseStructuredData('{"unterminated":');
    assert.equal(data, null);
    assert.match(error, /JSON|parse/i);
});

test('parseStructuredData: non-object JSON → error', () => {
    const { data, error } = parseStructuredData('"a string"');
    assert.equal(data, null);
    assert.match(error, /object/i);
});
