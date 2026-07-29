import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPool, excludedPlatforms, parseProxyLine } from '../../src/core/proxy-pool.js';

// Platforms disagree about what a good IP is. Verified live 2026-07-28: Monster
// returns 36 jobs through Decodo ISP IPs but is DataDome-blocked direct, while
// Glassdoor is the inverse — Cloudflare challenges those ISP IPs and only the
// residential line gets through. PROXY_EXCLUDE_PLATFORMS lets one host serve
// both instead of forcing an all-or-nothing choice.

const PROXIES = [
    parseProxyLine('isp.example.com:10001:user:pass'),
    parseProxyLine('isp.example.com:10002:user:pass'),
];

test('excludedPlatforms: parses, trims, lowercases, ignores blanks', () => {
    assert.deepEqual([...excludedPlatforms({ PROXY_EXCLUDE_PLATFORMS: 'glassdoor' })], ['glassdoor']);
    assert.deepEqual([...excludedPlatforms({ PROXY_EXCLUDE_PLATFORMS: ' Glassdoor , MONSTER ' })], ['glassdoor', 'monster']);
    assert.deepEqual([...excludedPlatforms({ PROXY_EXCLUDE_PLATFORMS: 'a,,  ,b' })], ['a', 'b']);
    assert.deepEqual([...excludedPlatforms({})], []);
});

test('an excluded platform gets no proxy even when the pool is full', () => {
    const pool = new ProxyPool(PROXIES, { excluded: new Set(['glassdoor']) });
    assert.equal(pool.acquire('glassdoor'), null, 'excluded platform must run direct');
    assert.equal(pool.size, 2, 'the pool itself is untouched');
});

test('non-excluded platforms still get proxies and still rotate', () => {
    const pool = new ProxyPool(PROXIES, { excluded: new Set(['glassdoor']) });
    const first = pool.acquire('monster');
    const second = pool.acquire('monster');
    assert.ok(first?.server, 'monster should be proxied');
    assert.ok(second?.server);
    assert.notEqual(first.server, second.server, 'round-robin should hand out a different IP');
});

test('matching is case-insensitive', () => {
    const pool = new ProxyPool(PROXIES, { excluded: new Set(['glassdoor']) });
    assert.equal(pool.acquire('GlassDoor'), null);
});

test('no exclusions configured keeps the previous behaviour for every platform', () => {
    const pool = new ProxyPool(PROXIES, { excluded: new Set() });
    for (const p of ['glassdoor', 'monster', 'indeed', 'dice', 'techfetch']) {
        assert.ok(pool.acquire(p)?.server, `${p} should be proxied by default`);
    }
});

test('reporting a block for an excluded platform is a harmless no-op', () => {
    const pool = new ProxyPool(PROXIES, { excluded: new Set(['glassdoor']) });
    pool.acquire('glassdoor');
    pool.reportBlocked('glassdoor');
    // Nothing was leased, so nothing may be cooled.
    assert.equal(pool.stats().cooled, 0);
});
