import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectAppsapiBody } from '../../scrapers/monster.js';

const HAS_JOBS = fs.readFileSync(new URL('../fixtures/monster-appsapi-has-jobs.json', import.meta.url), 'utf-8');
const EMPTY    = fs.readFileSync(new URL('../fixtures/monster-appsapi-empty.json', import.meta.url), 'utf-8');

test('inspectAppsapiBody: real has-jobs fixture → "has-jobs"', () => {
    assert.equal(inspectAppsapiBody(HAS_JOBS), 'has-jobs');
});

test('inspectAppsapiBody: real empty fixture → "empty-payload"', () => {
    assert.equal(inspectAppsapiBody(EMPTY), 'empty-payload');
});

test('inspectAppsapiBody: empty string → "empty-payload"', () => {
    assert.equal(inspectAppsapiBody(''), 'empty-payload');
});

test('inspectAppsapiBody: null / undefined → "empty-payload"', () => {
    assert.equal(inspectAppsapiBody(null), 'empty-payload');
    assert.equal(inspectAppsapiBody(undefined), 'empty-payload');
});

test('inspectAppsapiBody: malformed JSON → "unparseable"', () => {
    assert.equal(inspectAppsapiBody('{"unterminated":'), 'unparseable');
});

test('inspectAppsapiBody: object with no known keys → "unknown-shape"', () => {
    assert.equal(inspectAppsapiBody('{"surprising":true,"totallyUnrelated":42}'), 'unknown-shape');
});

test('inspectAppsapiBody: synthetic jobResults shape → "has-jobs"', () => {
    assert.equal(inspectAppsapiBody('{"jobResults":[{"title":"X"}]}'), 'has-jobs');
});

test('inspectAppsapiBody: synthetic jobs shape → "has-jobs"', () => {
    assert.equal(inspectAppsapiBody('{"jobs":[{"title":"X"}]}'), 'has-jobs');
});

test('inspectAppsapiBody: synthetic searchResults.jobs shape → "has-jobs"', () => {
    assert.equal(inspectAppsapiBody('{"searchResults":{"jobs":[{"title":"X"}]}}'), 'has-jobs');
});

test('inspectAppsapiBody: synthetic results shape → "has-jobs"', () => {
    assert.equal(inspectAppsapiBody('{"results":[{"title":"X"}]}'), 'has-jobs');
});

// Empty array with NO totalSize (or totalSize 0) = a GENUINE 0-results page.
test('inspectAppsapiBody: jobResults empty, no totalSize → "empty-results"', () => {
    assert.equal(inspectAppsapiBody('{"jobResults":[]}'), 'empty-results');
});

test('inspectAppsapiBody: jobs empty, no totalSize → "empty-results"', () => {
    assert.equal(inspectAppsapiBody('{"jobs":[]}'), 'empty-results');
});

test('inspectAppsapiBody: searchResults.jobs empty, no totalSize → "empty-results"', () => {
    assert.equal(inspectAppsapiBody('{"searchResults":{"jobs":[]}}'), 'empty-results');
});

test('inspectAppsapiBody: results empty, no totalSize → "empty-results"', () => {
    assert.equal(inspectAppsapiBody('{"results":[]}'), 'empty-results');
});

test('inspectAppsapiBody: empty array + totalSize 0 → "empty-results" (genuine)', () => {
    assert.equal(inspectAppsapiBody('{"jobResults":[],"totalSize":0}'), 'empty-results');
});

// totalSize>0 with an empty array = DataDome SUPPRESS (jobs exist but withheld).
test('inspectAppsapiBody: empty array but totalSize>0 → "empty-payload" (suppress)', () => {
    assert.equal(inspectAppsapiBody('{"jobResults":[],"totalSize":18}'), 'empty-payload');
});
