import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformsOnCooldown, cooldownSnapshot } from '../../src/core/platform-cooldowns.js';
import { ProxyPool } from '../../src/core/proxy-pool.js';

const NOW = new Date('2026-06-14T12:00:00.000Z');

function fakeModule(active) {
    return {
        cooldownPath: () => '/tmp/fake-marker',
        defaultReadFile: () => () => 'x',
        readCooldownMarker: () => ({ blockedUntil: active ? new Date('2026-06-14T13:00:00.000Z') : null }),
        isOnCooldown: (marker, now) => !!(marker.blockedUntil && marker.blockedUntil > now),
    };
}

test('platformsOnCooldown: returns only the platforms with an active cooldown', () => {
    const mods = { monster: fakeModule(true), indeed: fakeModule(false), glassdoor: fakeModule(true) };
    assert.deepEqual(platformsOnCooldown(NOW, mods).sort(), ['glassdoor', 'monster']);
});

test('platformsOnCooldown: none active → empty array', () => {
    const mods = { monster: fakeModule(false), indeed: fakeModule(false), glassdoor: fakeModule(false) };
    assert.deepEqual(platformsOnCooldown(NOW, mods), []);
});

test('a fully cooled proxy pool excludes proxied platforms from claims, preserving direct exclusions', () => {
    let time = 0;
    const pool = new ProxyPool([{ id: 'proxy', server: 'http://example:80' }], {
        now: () => time, cooldownMs: 1000, excluded: new Set(['monster']),
    });
    pool.acquire('indeed');
    pool.reportBlocked('indeed');
    assert.deepEqual(platformsOnCooldown(NOW, {}, pool).sort(), ['dice', 'glassdoor', 'indeed', 'techfetch']);
    time = 1000;
    assert.deepEqual(platformsOnCooldown(NOW, {}, pool), []);
});

test('platformsOnCooldown: a throwing module is isolated, never breaks the result', () => {
    const boom = {
        cooldownPath: () => { throw new Error('boom'); },
        defaultReadFile: () => () => '',
        readCooldownMarker: () => ({}),
        isOnCooldown: () => false,
    };
    const mods = { monster: boom, glassdoor: fakeModule(true) };
    assert.deepEqual(platformsOnCooldown(NOW, mods), ['glassdoor']);
});

test('platformsOnCooldown: default (real) modules return an array without throwing', () => {
    assert.ok(Array.isArray(platformsOnCooldown(NOW)));
});

test('cooldownSnapshot: reports onCooldown + until per platform, isolating a throwing module', () => {
    const boom = {
        cooldownPath: () => { throw new Error('boom'); },
        defaultReadFile: () => () => '',
        readCooldownMarker: () => ({}),
        isOnCooldown: () => false,
    };
    const mods = { monster: fakeModule(true), indeed: fakeModule(false), glassdoor: boom };
    const snap = cooldownSnapshot(NOW, mods);
    assert.deepEqual(snap.monster, { onCooldown: true, until: '2026-06-14T13:00:00.000Z' });
    assert.deepEqual(snap.indeed, { onCooldown: false, until: null });
    assert.deepEqual(snap.glassdoor, { onCooldown: false, until: null });
});
