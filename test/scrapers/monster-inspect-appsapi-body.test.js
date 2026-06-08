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

test('inspectAppsapiBody: jobResults present but empty → "empty-payload"', () => {
    assert.equal(inspectAppsapiBody('{"jobResults":[]}'), 'empty-payload');
});

test('inspectAppsapiBody: jobs present but empty → "empty-payload"', () => {
    assert.equal(inspectAppsapiBody('{"jobs":[]}'), 'empty-payload');
});

test('inspectAppsapiBody: searchResults.jobs present but empty → "empty-payload"', () => {
    assert.equal(inspectAppsapiBody('{"searchResults":{"jobs":[]}}'), 'empty-payload');
});

test('inspectAppsapiBody: results present but empty → "empty-payload"', () => {
    assert.equal(inspectAppsapiBody('{"results":[]}'), 'empty-payload');
});
