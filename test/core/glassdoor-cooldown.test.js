import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cooldownPath,
    cooldownMs,
    readCooldownMarker,
    writeCooldownMarker,
    isOnCooldown,
} from '../../src/core/glassdoor-cooldown.js';

const NOW = new Date('2026-06-14T12:00:00.000Z');

test('cooldownPath: ends with .blacklight-glassdoor-cooldown in the homedir', () => {
    assert.ok(cooldownPath().endsWith('.blacklight-glassdoor-cooldown'), cooldownPath());
});

test('cooldownMs: defaults to 60 minutes when env unset', () => {
    assert.equal(cooldownMs({}), 60 * 60 * 1000);
});

test('cooldownMs: reads positive integer env GLASSDOOR_BLOCK_COOLDOWN_MIN', () => {
    assert.equal(cooldownMs({ GLASSDOOR_BLOCK_COOLDOWN_MIN: '15' }), 15 * 60 * 1000);
    assert.equal(cooldownMs({ GLASSDOOR_BLOCK_COOLDOWN_MIN: '120' }), 120 * 60 * 1000);
});

test('cooldownMs: ignores zero / negative / garbage env values (60-min default)', () => {
    assert.equal(cooldownMs({ GLASSDOOR_BLOCK_COOLDOWN_MIN: '0' }), 60 * 60 * 1000);
    assert.equal(cooldownMs({ GLASSDOOR_BLOCK_COOLDOWN_MIN: '-5' }), 60 * 60 * 1000);
    assert.equal(cooldownMs({ GLASSDOOR_BLOCK_COOLDOWN_MIN: 'abc' }), 60 * 60 * 1000);
    assert.equal(cooldownMs({ GLASSDOOR_BLOCK_COOLDOWN_MIN: '' }), 60 * 60 * 1000);
});

test('readCooldownMarker: ENOENT → {blockedUntil: null}', () => {
    const readFile = () => { const e = new Error('no'); e.code = 'ENOENT'; throw e; };
    assert.deepEqual(readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' }), { blockedUntil: null });
});

test('readCooldownMarker: future ISO → {blockedUntil: Date}', () => {
    const future = new Date('2026-06-14T13:00:00.000Z').toISOString();
    const r = readCooldownMarker({ readFile: () => future, now: NOW, path: '/tmp/x' });
    assert.ok(r.blockedUntil instanceof Date);
    assert.equal(r.blockedUntil.toISOString(), future);
});

test('readCooldownMarker: stale (past) ISO → {blockedUntil: null}', () => {
    const past = new Date('2026-06-14T11:00:00.000Z').toISOString();
    assert.deepEqual(readCooldownMarker({ readFile: () => past, now: NOW, path: '/tmp/x' }), { blockedUntil: null });
});

test('readCooldownMarker: garbage file → {blockedUntil: null}', () => {
    assert.deepEqual(readCooldownMarker({ readFile: () => 'not-an-iso', now: NOW, path: '/tmp/x' }), { blockedUntil: null });
});

test('writeCooldownMarker: writes to <path>.tmp then renames', () => {
    const calls = [];
    writeCooldownMarker({
        writeFile: (p, content) => calls.push({ op: 'writeFile', path: p, content }),
        rename: (from, to) => calls.push({ op: 'rename', from, to }),
        now: NOW, cooldownMs: 60 * 60 * 1000, path: '/tmp/x',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].op, 'writeFile');
    assert.equal(calls[0].path, '/tmp/x.tmp');
    assert.equal(calls[0].content, new Date('2026-06-14T13:00:00.000Z').toISOString());
    assert.equal(calls[1].op, 'rename');
    assert.equal(calls[1].from, '/tmp/x.tmp');
    assert.equal(calls[1].to, '/tmp/x');
});

test('isOnCooldown: null marker → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: null }, NOW), false);
});

test('isOnCooldown: future blockedUntil → true', () => {
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-14T13:00:00.000Z') }, NOW), true);
});

test('isOnCooldown: past blockedUntil → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-14T11:00:00.000Z') }, NOW), false);
});

test('isOnCooldown: blockedUntil equal to now → false (expired)', () => {
    assert.equal(isOnCooldown({ blockedUntil: NOW }, NOW), false);
});
