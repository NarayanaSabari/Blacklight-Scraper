// Covers the concurrency/timeout/dedup primitives that replaced
// CheerioCrawler in Dice's detail stage. The point of the swap was that
// crawlee fetched every detail page over HTTP and the handler then re-fetched
// the same URL through Playwright, so each page was pulled twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dedupeUrls, mapWithConcurrency, withDeadline } from '../../scrapers/dice.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('dedupeUrls: removes repeats and preserves first-seen order', () => {
    assert.deepEqual(dedupeUrls(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

test('dedupeUrls: an empty list stays empty', () => {
    assert.deepEqual(dedupeUrls([]), []);
});

test('mapWithConcurrency: visits every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen = [];
    await mapWithConcurrency(items, 4, async (item) => {
        await tick(1);
        seen.push(item);
    });
    assert.equal(seen.length, 25);
    assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test('mapWithConcurrency: never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 30 }, (_, i) => i), 5, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(5);
        inFlight--;
    });
    assert.equal(peak, 5);
    assert.equal(inFlight, 0);
});

test('mapWithConcurrency: actually runs in parallel, not serially', async () => {
    // 10 items x 20ms at concurrency 5 is ~40ms serialised into 2 waves.
    // Serial execution would be ~200ms. The bound is loose enough not to be
    // flaky on a loaded CI box but tight enough to fail if the pool degenerates.
    const started = Date.now();
    await mapWithConcurrency(Array.from({ length: 10 }), 5, async () => { await tick(20); });
    assert.ok(Date.now() - started < 150, 'pool serialised its work');
});

test('mapWithConcurrency: one rejecting item does not abort the rest', async () => {
    const done = [];
    await assert.rejects(
        mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
            if (n === 2) throw new Error('boom');
            await tick(5);
            done.push(n);
        }),
        /boom/,
    );
    // The siblings still ran to completion; Promise.all rejects but does not
    // cancel. This is why the Dice worker does its own error accounting rather
    // than letting throws escape.
    await tick(20);
    assert.deepEqual(done.sort(), [1, 3, 4]);
});

test('mapWithConcurrency: a limit larger than the list is harmless', async () => {
    const seen = [];
    await mapWithConcurrency([1, 2], 50, async (n) => { seen.push(n); });
    assert.deepEqual(seen.sort(), [1, 2]);
});

test('mapWithConcurrency: an empty list resolves without invoking the worker', async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => { calls++; });
    assert.equal(calls, 0);
});

test('withDeadline: passes the value through when it finishes in time', async () => {
    assert.equal(await withDeadline(Promise.resolve('ok'), 1000, 'x'), 'ok');
});

test('withDeadline: rejects with the label once the deadline passes', async () => {
    await assert.rejects(
        withDeadline(tick(200), 20, 'Dice detail https://example.test/job'),
        /Dice detail https:\/\/example\.test\/job exceeded 20ms/,
    );
});

test('withDeadline: the original rejection wins over the deadline', async () => {
    await assert.rejects(withDeadline(Promise.reject(new Error('nav failed')), 1000, 'x'), /nav failed/);
});

test('withDeadline: clears its timer so it cannot hold the event loop open', async () => {
    // If the timer leaked, node --test would hang here rather than finish.
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await withDeadline(Promise.resolve('done'), 60_000, 'x');
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.equal(after, before);
});
