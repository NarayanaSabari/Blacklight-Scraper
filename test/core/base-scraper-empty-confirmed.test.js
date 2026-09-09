// SCR-20 (#403): executeWithMeta surfaces the confirmed-empty signal.
//
// `emptyConfirmed` was computed in execute() and then discarded, so a zero-job
// scrape reached the backend looking identical to a silent block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';

const noopMetrics = {
    recordSession() {}, recordJobsScraped() {}, recordFailure() {},
    recordUrlQuality() {}, noteZeroJobs() {},
};

function scraper(fn, opts = {}) {
    return new BaseScraper('indeed', fn, { metrics: noopMetrics, ...opts });
}

test('executeWithMeta: a confirmed-empty result reports emptyConfirmed true', async () => {
    const s = scraper(async () => ({ jobs: [], emptyConfirmed: true }));
    const out = await s.executeWithMeta('node', 'remote', 'sess');
    assert.deepEqual(out.jobs, []);
    assert.equal(out.emptyConfirmed, true, 'the backend needs to know this was verified');
});

test('executeWithMeta: an unconfirmed empty reports false when strictEmpty is off', async () => {
    // strictEmpty:false is the only way an unconfirmed empty reaches the wire at
    // all — with it on, BaseScraper throws BlockedError instead.
    const s = scraper(async () => ({ jobs: [], emptyConfirmed: false }), { strictEmpty: false });
    const out = await s.executeWithMeta('node', 'remote', 'sess');
    assert.equal(out.emptyConfirmed, false, 'must NOT be reported as a genuine empty');
});

test('executeWithMeta: a legacy bare-array return is treated as unconfirmed', async () => {
    // Returning a bare array says nothing about whether empty was verified, so
    // it must never be optimistically reported as confirmed.
    const s = scraper(async () => [], { strictEmpty: false });
    const out = await s.executeWithMeta('node', 'remote', 'sess');
    assert.equal(out.emptyConfirmed, false);
});

test('executeWithMeta: a non-empty result reports emptyConfirmed false', async () => {
    // Guards against the backend ever seeing "confirmed empty" alongside jobs.
    const s = scraper(async () => ({ jobs: [{ id: 1 }], emptyConfirmed: true }));
    const out = await s.executeWithMeta('node', 'remote', 'sess');
    assert.equal(out.jobs.length, 1);
    assert.equal(out.emptyConfirmed, false, 'meaningless unless the result is empty');
});

test('execute: still returns a bare array, so existing callers are unaffected', async () => {
    const s = scraper(async () => ({ jobs: [{ id: 1 }], emptyConfirmed: false }));
    const out = await s.execute('node', 'remote', 'sess');
    assert.ok(Array.isArray(out), 'the /scrape route and older tests depend on this');
    assert.equal(out.length, 1);
});

test('strictEmpty still throws on an unconfirmed empty, before any wire report', async () => {
    const s = scraper(async () => ({ jobs: [], emptyConfirmed: false }), { strictEmpty: true });
    await assert.rejects(() => s.executeWithMeta('node', 'remote', 'sess'));
});

test('strictEmpty does NOT throw on a CONFIRMED empty', async () => {
    // SCR-23 (#406): a genuine no-results query must not be recorded as a
    // platform failure just because the result set is empty.
    //
    // `upToDate` joined this shape in #492 (known-ground early stop) and is
    // false here: a confirmed empty from a scraper that reported no
    // high-water mark is an ordinary empty result, not known ground.
    const s = scraper(async () => ({ jobs: [], emptyConfirmed: true }), { strictEmpty: true });
    const out = await s.executeWithMeta('node', 'remote', 'sess');
    assert.deepEqual(out, { jobs: [], emptyConfirmed: true, upToDate: false });
});
