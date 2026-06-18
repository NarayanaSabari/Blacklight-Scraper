import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../../src/core/semaphore.js';

const tick = () => new Promise((r) => setImmediate(r));

test('acquire: grants immediately up to max', async () => {
    const s = new Semaphore(2);
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    assert.equal(typeof r1, 'function');
    assert.equal(typeof r2, 'function');
});

test('acquire: blocks beyond max until a slot frees (FIFO)', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    let got2 = false;
    let got3 = false;
    const p2 = s.acquire().then((r) => { got2 = true; return r; });
    const p3 = s.acquire().then((r) => { got3 = true; return r; });
    await tick();
    assert.equal(got2, false, 'second waiter blocked while slot held');
    assert.equal(got3, false);
    r1();
    const r2 = await p2;
    assert.equal(got2, true);
    assert.equal(got3, false, 'third waiter still blocked (FIFO)');
    r2();
    await p3;
    assert.equal(got3, true);
});

test('release is idempotent — double-release does not over-grant', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    r1();
    r1();
    const r2 = await s.acquire();
    let got3 = false;
    s.acquire().then(() => { got3 = true; });
    await tick();
    assert.equal(got3, false, 'double-release must not have granted an extra slot');
    r2();
});

test('never exceeds max under a burst of M >> max acquirers', async () => {
    const s = new Semaphore(2);
    let live = 0;
    let maxLive = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
        const release = await s.acquire();
        live++; maxLive = Math.max(maxLive, live);
        await tick(); await tick();
        live--; release();
    }));
    assert.equal(maxLive, 2, `observed max concurrency ${maxLive}, expected 2`);
    assert.equal(live, 0);
});

test('max < 1 is clamped to 1', async () => {
    const s = new Semaphore(0);
    const r1 = await s.acquire();
    let got2 = false;
    s.acquire().then(() => { got2 = true; });
    await tick();
    assert.equal(got2, false, 'clamped to 1 → second blocks');
    r1();
});

test('inUse reflects held slots', async () => {
    const s = new Semaphore(2);
    assert.equal(s.inUse, 0);
    const r1 = await s.acquire();
    assert.equal(s.inUse, 1);
    const r2 = await s.acquire();
    assert.equal(s.inUse, 2);
    r1();
    assert.equal(s.inUse, 1);
    r2();
    assert.equal(s.inUse, 0);
});
