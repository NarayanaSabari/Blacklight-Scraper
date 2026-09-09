// Covers the concurrency/timeout/dedup primitives that replaced
// CheerioCrawler in Dice's detail stage. The point of the swap was that
// crawlee fetched every detail page over HTTP and the handler then re-fetched
// the same URL through Playwright, so each page was pulled twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    closeDiceResources,
    createContextPool,
    dedupeUrls,
    mapWithConcurrency,
    withDeadline,
} from '../../scrapers/dice.js';

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

test('withDeadline: waits for a timed-out page to close before releasing its slot', async () => {
    const events = [];
    const page = {
        close: async () => {
            events.push('close:start');
            await tick(15);
            events.push('close:end');
        },
    };

    await mapWithConcurrency(['stuck', 'next'], 1, async (item) => {
        if (item === 'stuck') {
            await assert.rejects(
                withDeadline(
                    new Promise(() => {}),
                    5,
                    'Dice detail stuck',
                    () => page.close(),
                    100,
                ),
                /Dice detail stuck exceeded 5ms/,
            );
            events.push('stuck:released');
            return;
        }
        events.push('next:started');
    });

    assert.deepEqual(events, ['close:start', 'close:end', 'stuck:released', 'next:started']);
});

test('withDeadline: a page rejection after timeout cannot bypass cleanup', async () => {
    const events = [];
    let rejectPage;
    const pageOperation = new Promise((_, reject) => { rejectPage = reject; });

    const result = withDeadline(
        pageOperation,
        5,
        'Dice detail stuck',
        async () => {
            events.push('close:start');
            await tick(15);
            events.push('close:end');
        },
        100,
    );
    setTimeout(() => rejectPage(new Error('page closed')), 8);

    await assert.rejects(result, /Dice detail stuck exceeded 5ms/);
    assert.deepEqual(events, ['close:start', 'close:end']);
});

test('withDeadline: bounds a hung page cleanup instead of holding the slot forever', async () => {
    const started = Date.now();
    await assert.rejects(
        withDeadline(
            new Promise(() => {}),
            5,
            'Dice detail stuck',
            () => new Promise(() => {}),
            20,
        ),
        /Dice detail stuck exceeded 5ms/,
    );
    assert.ok(Date.now() - started < 100, 'hung page cleanup exceeded its bound');
});

test('a timed-out page quarantines its context until the page is gone', async () => {
    const stuckContext = { name: 'stuck' };
    const healthyContext = { name: 'healthy' };
    const contexts = createContextPool([stuckContext, healthyContext]);
    let releasePage;
    const pageClosed = new Promise((resolve) => { releasePage = resolve; });
    const selected = contexts.next();

    contexts.quarantine(selected, pageClosed);
    assert.equal(contexts.isQuarantined(stuckContext), true);
    assert.equal(contexts.next(), healthyContext, 'healthy context remains available');
    assert.equal(contexts.next(), healthyContext, 'quarantined context is not reused');

    const singleContext = createContextPool([stuckContext]);
    singleContext.quarantine(stuckContext, pageClosed);
    assert.equal(singleContext.next(), null, 'a quarantined context supplies no replacement capacity');

    releasePage();
    await pageClosed;
    await tick(0);
    assert.equal(contexts.isQuarantined(stuckContext), false);
    assert.equal(contexts.next(), stuckContext, 'context returns after the page closes');
});

test('the next detail job skips a context whose timed-out page is still alive', async () => {
    const stuckContext = { name: 'stuck' };
    const healthyContext = { name: 'healthy' };
    const contexts = createContextPool([stuckContext, healthyContext]);
    const started = [];
    let releasePage;
    const pageClosed = new Promise((resolve) => { releasePage = resolve; });
    const stuckPage = { close: () => pageClosed };

    await mapWithConcurrency(['stuck', 'next'], 1, async (item) => {
        const context = contexts.next();
        started.push([item, context.name]);
        if (item !== 'stuck') return;

        await assert.rejects(
            withDeadline(
                new Promise(() => {}),
                5,
                'Dice detail stuck',
                () => {
                    const cleanup = stuckPage.close();
                    contexts.quarantine(context, cleanup);
                    return cleanup;
                },
                10,
            ),
            /Dice detail stuck exceeded 5ms/,
        );
    });

    assert.deepEqual(started, [['stuck', 'stuck'], ['next', 'healthy']]);
    releasePage();
    await pageClosed;
    await tick(0);
    assert.equal(contexts.next(), stuckContext, 'the recovered context is reusable');
});

test('a shared context stays quarantined until every pending page is gone', async () => {
    const stuckContext = { name: 'stuck' };
    const healthyContext = { name: 'healthy' };
    const contexts = createContextPool([stuckContext, healthyContext]);
    let releaseFirst;
    let releaseSecond;
    const firstPage = new Promise((resolve) => { releaseFirst = resolve; });
    const secondPage = new Promise((resolve) => { releaseSecond = resolve; });

    contexts.quarantine(stuckContext, firstPage);
    contexts.quarantine(stuckContext, secondPage);
    releaseFirst();
    await firstPage;
    await tick(0);

    assert.equal(contexts.isQuarantined(stuckContext), true);
    assert.equal(contexts.next(), healthyContext);

    releaseSecond();
    await secondPage;
    await tick(0);
    assert.equal(contexts.isQuarantined(stuckContext), false);
});

test('outer cleanup attempts the browser even when a context close hangs', async () => {
    const events = [];
    const hangingContext = { close: () => new Promise(() => {}) };
    const healthyContext = { close: async () => { events.push('healthy-context'); } };
    const browser = { close: async () => { events.push('browser'); } };

    const started = Date.now();
    await closeDiceResources([hangingContext, healthyContext], browser, 20);

    assert.equal(events.includes('healthy-context'), true);
    assert.equal(events.includes('browser'), true, 'browser close must be attempted independently');
    assert.ok(Date.now() - started < 100, 'hung context cleanup exceeded its bound');
});
