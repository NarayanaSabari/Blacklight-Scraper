import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseScraper } from '../../src/core/base-scraper.js';
import { BlockedError } from '../../src/core/errors.js';

function fakeMetrics() {
    const calls = { session: [], jobs: [], failure: [], zero: [] };
    return {
        calls,
        recordSession: (p, r, d) => calls.session.push([p, r, d]),
        recordJobsScraped: (p, n) => calls.jobs.push([p, n]),
        recordFailure: (p, reason) => calls.failure.push([p, reason]),
        noteZeroJobs: (p) => calls.zero.push([p]),
    };
}

test('non-empty array → success, returns the array', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('indeed', async () => [{ id: 1 }], { metrics: m });
    const out = await s.execute('node', 'remote', 'sess1');
    assert.deepEqual(out, [{ id: 1 }]);
    assert.equal(m.calls.session[0][1], 'success');
    assert.deepEqual(m.calls.jobs[0], ['indeed', 1]);
});

test('confirmed-empty object → success with 0, no zero-jobs alert', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('dice', async () => ({ jobs: [], emptyConfirmed: true }), { metrics: m });
    const out = await s.execute('node', 'remote', 'sess2');
    assert.deepEqual(out, []);
    assert.equal(m.calls.session[0][1], 'success');
    assert.equal(m.calls.zero.length, 0);
});

test('unconfirmed empty, non-strict → success preserved + zero-jobs noted', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('glassdoor', async () => [], { metrics: m, strictEmpty: false });
    const out = await s.execute('node', 'remote', 'sess3');
    assert.deepEqual(out, []);
    assert.equal(m.calls.session[0][1], 'success'); // production behavior unchanged
    assert.deepEqual(m.calls.zero[0], ['glassdoor']); // new observable seam
});

test('unconfirmed empty, strict → throws BlockedError, recorded failed/blocked', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('indeed', async () => [], { metrics: m, strictEmpty: true });
    await assert.rejects(() => s.execute('node', 'remote', 'sess4'), (err) => {
        assert.ok(err instanceof BlockedError);
        return true;
    });
    assert.equal(m.calls.session[0][1], 'failed');
    assert.deepEqual(m.calls.failure[0], ['indeed', 'blocked']);
    assert.deepEqual(m.calls.zero[0], ['indeed']); // noteZeroJobs fires before the strict throw
});

test('thrown ScraperError still propagates and is recorded failed', async () => {
    const m = fakeMetrics();
    const s = new BaseScraper('techfetch', async () => { throw new BlockedError('cf', { kind: 'cloudflare' }); }, { metrics: m });
    await assert.rejects(() => s.execute('node', 'remote', 'sess5'), (err) => err instanceof BlockedError);
    assert.equal(m.calls.session[0][1], 'failed');
    assert.deepEqual(m.calls.failure[0], ['techfetch', 'blocked']);
});

test('legacy two-arg constructor still works (backward compat)', () => {
    const s = new BaseScraper('monster', async () => []);
    assert.equal(s.platform, 'monster');
});

test('up-to-date empty → success, no zero-jobs alert, even under strictEmpty', async () => {
    // A LinkedIn sweep that reached posts it already forwarded returns zero
    // jobs. Without the upToDate signal that is indistinguishable from the
    // silent-block signature, and strictEmpty would throw on every healthy
    // incremental sweep — which would make higher cadence unusable.
    const m = fakeMetrics();
    const s = new BaseScraper('linkedin', async () => ({ jobs: [], upToDate: true }), {
        metrics: m, strictEmpty: true,
    });
    const out = await s.execute('node', 'remote', 'sess-utd');
    assert.deepEqual(out, []);
    assert.equal(m.calls.session[0][1], 'success');
    assert.equal(m.calls.zero.length, 0, 'up-to-date must not raise the zero-jobs alert');
});

test('up-to-date reports confirmed-empty on the wire so the backend trusts the zero', async () => {
    const s = new BaseScraper('linkedin', async () => ({ jobs: [], upToDate: true }), {
        metrics: fakeMetrics(),
    });
    const meta = await s.executeWithMeta('node', 'remote', 'sess-utd2');
    assert.equal(meta.emptyConfirmed, true);
    assert.equal(meta.upToDate, true);
});

test('upToDate is ignored when jobs came back', async () => {
    const s = new BaseScraper('linkedin', async () => ({ jobs: [{ id: 1 }], upToDate: true }), {
        metrics: fakeMetrics(),
    });
    const meta = await s.executeWithMeta('node', 'remote', 'sess-utd3');
    assert.equal(meta.emptyConfirmed, false);
    assert.equal(meta.upToDate, false);
});
