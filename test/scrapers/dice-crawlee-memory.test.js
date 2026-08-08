import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Configuration } from 'crawlee';

import { crawleeMemoryMb } from '../../scrapers/dice.js';

const GB = 1024 * 1024 * 1024;

test('crawleeMemoryMb: defaults to 75% of host RAM, not crawlee\'s 25%', () => {
    // 16 GB is the m1 host. crawlee's own default would be 4040 MB, which is
    // what it was measuring 4887 MB against while the OS had 7.5 GB free.
    assert.equal(crawleeMemoryMb({}, 16 * GB), 12288);
    assert.ok(crawleeMemoryMb({}, 16 * GB) > 4040);
});

test('crawleeMemoryMb: an explicit override wins', () => {
    assert.equal(crawleeMemoryMb({ DICE_CRAWLER_MEMORY_MB: '2048' }, 16 * GB), 2048);
});

test('crawleeMemoryMb: garbage and non-positive overrides fall back to the ratio', () => {
    assert.equal(crawleeMemoryMb({ DICE_CRAWLER_MEMORY_MB: 'lots' }, 8 * GB), 6144);
    assert.equal(crawleeMemoryMb({ DICE_CRAWLER_MEMORY_MB: '0' }, 8 * GB), 6144);
    assert.equal(crawleeMemoryMb({ DICE_CRAWLER_MEMORY_MB: '-1' }, 8 * GB), 6144);
});

test('crawleeMemoryMb: always an integer - crawlee rejects fractional MB', () => {
    const value = crawleeMemoryMb({}, 15.78 * GB);
    assert.equal(Number.isInteger(value), true);
});

test('importing dice.js applies the budget to the GLOBAL crawlee config', () => {
    // Not a per-crawler Configuration: RequestQueue.open() resolves its storage
    // client from the global config, so a split config would hand the crawler
    // a queue it does not own.
    assert.equal(Configuration.getGlobalConfig().get('memoryMbytes'), crawleeMemoryMb());
});
