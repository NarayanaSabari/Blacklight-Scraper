import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cooldownPath,
    cooldownMs,
    readCooldownMarker,
    writeCooldownMarker,
    isOnCooldown,
} from '../../src/core/monster-cooldown.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');

// --- cooldownPath -----------------------------------------------------------

test('cooldownPath: ends with .blacklight-monster-cooldown in the homedir', () => {
    const p = cooldownPath();
    assert.ok(p.endsWith('.blacklight-monster-cooldown'), `got ${p}`);
});

// --- cooldownMs -------------------------------------------------------------

test('cooldownMs: defaults to 30 minutes when env unset', () => {
    assert.equal(cooldownMs({}), 30 * 60 * 1000);
});

test('cooldownMs: reads positive integer env MONSTER_BLOCK_COOLDOWN_MIN', () => {
    assert.equal(cooldownMs({ MONSTER_BLOCK_COOLDOWN_MIN: '15' }), 15 * 60 * 1000);
    assert.equal(cooldownMs({ MONSTER_BLOCK_COOLDOWN_MIN: '120' }), 120 * 60 * 1000);
});

test('cooldownMs: ignores zero / negative / garbage env values', () => {
    assert.equal(cooldownMs({ MONSTER_BLOCK_COOLDOWN_MIN: '0' }), 30 * 60 * 1000);
    assert.equal(cooldownMs({ MONSTER_BLOCK_COOLDOWN_MIN: '-5' }), 30 * 60 * 1000);
    assert.equal(cooldownMs({ MONSTER_BLOCK_COOLDOWN_MIN: 'abc' }), 30 * 60 * 1000);
    assert.equal(cooldownMs({ MONSTER_BLOCK_COOLDOWN_MIN: '' }), 30 * 60 * 1000);
});

// --- readCooldownMarker -----------------------------------------------------

test('readCooldownMarker: ENOENT → {blockedUntil: null}', () => {
    const readFile = () => { const e = new Error('no'); e.code = 'ENOENT'; throw e; };
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.deepEqual(r, { blockedUntil: null });
});

test('readCooldownMarker: future ISO → {blockedUntil: Date}', () => {
    const future = new Date('2026-06-08T12:30:00.000Z').toISOString();
    const readFile = () => future;
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.ok(r.blockedUntil instanceof Date);
    assert.equal(r.blockedUntil.toISOString(), future);
});

test('readCooldownMarker: stale (past) ISO → {blockedUntil: null}', () => {
    const past = new Date('2026-06-08T11:00:00.000Z').toISOString();
    const readFile = () => past;
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.deepEqual(r, { blockedUntil: null });
});

test('readCooldownMarker: garbage file → {blockedUntil: null}', () => {
    const readFile = () => 'not-an-iso-timestamp';
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.deepEqual(r, { blockedUntil: null });
});

test('readCooldownMarker: trailing whitespace tolerated', () => {
    const future = new Date('2026-06-08T12:30:00.000Z').toISOString();
    const readFile = () => `${future}\n`;
    const r = readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' });
    assert.ok(r.blockedUntil instanceof Date);
});

// --- writeCooldownMarker (atomic) -------------------------------------------

test('writeCooldownMarker: writes to <path>.tmp then renames', () => {
    const calls = [];
    const writeFile = (p, content) => calls.push({ op: 'writeFile', path: p, content });
    const rename = (from, to) => calls.push({ op: 'rename', from, to });
    writeCooldownMarker({
        writeFile, rename, now: NOW, cooldownMs: 30 * 60 * 1000, path: '/tmp/x',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].op, 'writeFile');
    assert.equal(calls[0].path, '/tmp/x.tmp');
    assert.equal(calls[0].content, new Date('2026-06-08T12:30:00.000Z').toISOString());
    assert.equal(calls[1].op, 'rename');
    assert.equal(calls[1].from, '/tmp/x.tmp');
    assert.equal(calls[1].to, '/tmp/x');
});

// --- isOnCooldown -----------------------------------------------------------

test('isOnCooldown: null marker → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: null }, NOW), false);
});

test('isOnCooldown: blockedUntil in the future → true', () => {
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-08T12:30:00.000Z') }, NOW), true);
});

test('isOnCooldown: blockedUntil in the past → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-08T11:00:00.000Z') }, NOW), false);
});

test('isOnCooldown: blockedUntil exactly equal to now → false (expired)', () => {
    assert.equal(isOnCooldown({ blockedUntil: NOW }, NOW), false);
});
