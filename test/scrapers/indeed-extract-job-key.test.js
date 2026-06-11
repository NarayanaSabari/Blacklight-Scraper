import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractJobKey } from '../../scrapers/indeed.js';

test('extractJobKey: card has data-jk on itself', () => {
    const $ = cheerio.load('<div class="job_seen_beacon" data-jk="abc123"></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'abc123');
});

test('extractJobKey: closest ancestor has data-jk', () => {
    const $ = cheerio.load('<div data-jk="anc456"><div class="job_seen_beacon"></div></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'anc456');
});

test('extractJobKey: child a[data-jk] (current Indeed pattern — 2026)', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><a data-jk="child789">Title</a></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'child789');
});

test('extractJobKey: prefers own attribute over child', () => {
    const $ = cheerio.load('<div class="job_seen_beacon" data-jk="own"><a data-jk="child">X</a></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'own');
});

test('extractJobKey: prefers own attribute over ancestor', () => {
    const $ = cheerio.load('<div data-jk="anc"><div class="job_seen_beacon" data-jk="own"></div></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), 'own');
});

test('extractJobKey: no data-jk anywhere → null', () => {
    const $ = cheerio.load('<div class="job_seen_beacon"><span>nothing</span></div>');
    const card = $('.job_seen_beacon');
    assert.equal(extractJobKey($, card), null);
});

test('extractJobKey: empty card → null', () => {
    const $ = cheerio.load('<div></div>');
    const card = $('div');
    assert.equal(extractJobKey($, card), null);
});
