import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformsOnCooldown, cooldownSnapshot } from '../../src/core/platform-cooldowns.js';

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
