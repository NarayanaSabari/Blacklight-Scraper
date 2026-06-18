import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    blockingEnabled, blockedTypes, shouldBlock, applyResourceBlocking,
} from '../../src/core/resource-blocking.js';

test('blockingEnabled: default ON; explicit off values disable', () => {
    assert.equal(blockingEnabled({}), true);
    assert.equal(blockingEnabled({ SCRAPER_BLOCK_RESOURCES: '' }), true);
    for (const v of ['0', 'false', 'no', 'off', 'OFF', 'False']) {
        assert.equal(blockingEnabled({ SCRAPER_BLOCK_RESOURCES: v }), false, `"${v}" should disable`);
    }
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
        assert.equal(blockingEnabled({ SCRAPER_BLOCK_RESOURCES: v }), true, `"${v}" should enable`);
    }
});

test('blockedTypes: default trio; env override; garbage → default', () => {
    assert.deepEqual(blockedTypes({}), ['image', 'media', 'font']);
    assert.deepEqual(blockedTypes({ SCRAPER_BLOCK_RESOURCE_TYPES: 'image, stylesheet ,FONT' }),
        ['image', 'stylesheet', 'font']);
    assert.deepEqual(blockedTypes({ SCRAPER_BLOCK_RESOURCE_TYPES: ' , ,' }), ['image', 'media', 'font']);
});

test('shouldBlock: blocks default trio, allows document/script/xhr', () => {
    for (const t of ['image', 'media', 'font']) assert.equal(shouldBlock(t, {}), true, t);
    for (const t of ['document', 'script', 'stylesheet', 'xhr', 'fetch']) {
        assert.equal(shouldBlock(t, {}), false, t);
    }
    assert.equal(shouldBlock('image', { SCRAPER_BLOCK_RESOURCES: '0' }), false, 'disabled → allow all');
});

// Fake Playwright route/context to assert the handler aborts vs continues.
function fakeRoute(resourceType) {
    const calls = { abort: 0, continue: 0 };
    return {
        request: () => ({ resourceType: () => resourceType }),
        abort: async () => { calls.abort++; },
        continue: async () => { calls.continue++; },
        _calls: calls,
    };
}
function fakeContext() {
    let handler = null;
    return {
        route: async (_glob, fn) => { handler = fn; },
        async fire(resourceType) { const r = fakeRoute(resourceType); await handler(r); return r._calls; },
        get installed() { return !!handler; },
    };
}

test('applyResourceBlocking: installs a route that aborts images, continues documents', async () => {
    const ctx = fakeContext();
    const ok = await applyResourceBlocking(ctx, {});
    assert.equal(ok, true);
    assert.equal(ctx.installed, true);
    assert.deepEqual(await ctx.fire('image'), { abort: 1, continue: 0 });
    assert.deepEqual(await ctx.fire('font'), { abort: 1, continue: 0 });
    assert.deepEqual(await ctx.fire('document'), { abort: 0, continue: 1 });
    assert.deepEqual(await ctx.fire('xhr'), { abort: 0, continue: 1 });
});

test('applyResourceBlocking: no-op when disabled or target cannot route', async () => {
    const ctx = fakeContext();
    assert.equal(await applyResourceBlocking(ctx, { SCRAPER_BLOCK_RESOURCES: '0' }), false);
    assert.equal(ctx.installed, false);
    assert.equal(await applyResourceBlocking(null, {}), false);
    assert.equal(await applyResourceBlocking({}, {}), false);
});
