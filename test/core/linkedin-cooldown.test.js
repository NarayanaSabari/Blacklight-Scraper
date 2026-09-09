import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    cooldownPath,
    cooldownMs,
    readCooldownMarker,
    writeCooldownMarker,
    isOnCooldown,
} from '../../src/core/linkedin-cooldown.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

// --- cooldownPath -----------------------------------------------------------

test('cooldownPath: ends with .blacklight-linkedin-cooldown in the homedir', () => {
    const p = cooldownPath();
    assert.ok(p.endsWith('.blacklight-linkedin-cooldown'), `got ${p}`);
});

// --- cooldownMs -------------------------------------------------------------

test('cooldownMs: defaults to 30 minutes when env unset', () => {
    assert.equal(cooldownMs({}), 30 * 60 * 1000);
});

test('cooldownMs: reads positive integer env LINKEDIN_AUTH_COOLDOWN_MIN', () => {
    assert.equal(cooldownMs({ LINKEDIN_AUTH_COOLDOWN_MIN: '15' }), 15 * 60 * 1000);
    assert.equal(cooldownMs({ LINKEDIN_AUTH_COOLDOWN_MIN: '90' }), 90 * 60 * 1000);
});

test('cooldownMs: ignores zero / negative / garbage env values (falls back to 30-min default)', () => {
    assert.equal(cooldownMs({ LINKEDIN_AUTH_COOLDOWN_MIN: '0' }), 30 * 60 * 1000);
    assert.equal(cooldownMs({ LINKEDIN_AUTH_COOLDOWN_MIN: '-5' }), 30 * 60 * 1000);
    assert.equal(cooldownMs({ LINKEDIN_AUTH_COOLDOWN_MIN: 'abc' }), 30 * 60 * 1000);
    assert.equal(cooldownMs({ LINKEDIN_AUTH_COOLDOWN_MIN: '' }), 30 * 60 * 1000);
});

// --- readCooldownMarker -----------------------------------------------------

test('readCooldownMarker: ENOENT → {blockedUntil: null}', () => {
    const readFile = () => { const e = new Error('no'); e.code = 'ENOENT'; throw e; };
    assert.deepEqual(readCooldownMarker({ readFile, now: NOW, path: '/tmp/x' }), { blockedUntil: null });
});

test('readCooldownMarker: future ISO → {blockedUntil: Date}', () => {
    const future = new Date('2026-06-21T12:30:00.000Z').toISOString();
    const r = readCooldownMarker({ readFile: () => future, now: NOW, path: '/tmp/x' });
    assert.ok(r.blockedUntil instanceof Date);
    assert.equal(r.blockedUntil.toISOString(), future);
});

test('readCooldownMarker: stale (past) ISO → {blockedUntil: null}', () => {
    const past = new Date('2026-06-21T11:00:00.000Z').toISOString();
    assert.deepEqual(readCooldownMarker({ readFile: () => past, now: NOW, path: '/tmp/x' }), { blockedUntil: null });
});

test('readCooldownMarker: garbage file → {blockedUntil: null}', () => {
    assert.deepEqual(readCooldownMarker({ readFile: () => 'not-iso', now: NOW, path: '/tmp/x' }), { blockedUntil: null });
});

test('readCooldownMarker: trailing whitespace tolerated', () => {
    const future = new Date('2026-06-21T12:30:00.000Z').toISOString();
    const r = readCooldownMarker({ readFile: () => `${future}\n`, now: NOW, path: '/tmp/x' });
    assert.ok(r.blockedUntil instanceof Date);
});

// --- writeCooldownMarker (atomic) -------------------------------------------

test('writeCooldownMarker: writes to <path>.tmp then renames, with now+cooldown expiry', () => {
    const calls = [];
    const writeFile = (p, content) => calls.push({ op: 'writeFile', path: p, content });
    const rename = (from, to) => calls.push({ op: 'rename', from, to });
    writeCooldownMarker({ writeFile, rename, now: NOW, cooldownMs: 30 * 60 * 1000, path: '/tmp/x' });
    assert.deepEqual(calls, [
        { op: 'writeFile', path: '/tmp/x.tmp', content: new Date('2026-06-21T12:30:00.000Z').toISOString() },
        { op: 'rename', from: '/tmp/x.tmp', to: '/tmp/x' },
    ]);
});

// --- isOnCooldown -----------------------------------------------------------

test('isOnCooldown: null marker → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: null }, NOW), false);
});

test('isOnCooldown: future → true; past → false; equal-to-now → false', () => {
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-21T12:30:00.000Z') }, NOW), true);
    assert.equal(isOnCooldown({ blockedUntil: new Date('2026-06-21T11:00:00.000Z') }, NOW), false);
    assert.equal(isOnCooldown({ blockedUntil: NOW }, NOW), false);
});

// ── Two writers, one marker file (production 2026-08-19/20) ────────────────
//
// search-quota.js and session.js both write ~/.blacklight-linkedin-cooldown and
// cannot see each other. A last-one-wins write truncated a 4h quota pause to
// 30 minutes, and separately buried the auth cooldown that carries the
// "run npm run linkedin:login" instruction.
describe('writeCooldownMarker never moves an expiry backward', () => {
    const NOW = new Date('2026-08-20T10:00:00.000Z');
    const markerPath = '/tmp/marker';

    function harness(existing) {
        const written = {};
        return {
            written,
            writeFile: (p, d) => { written.tmp = d; },
            rename: () => { written.final = written.tmp; },
            readFile: existing === null
                ? () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }
                : () => existing,
        };
    }

    it('keeps the LONGER existing claim when the new one is shorter', () => {
        // A 4h quota pause is already in force; the auth path writes 30 min.
        const existing = '2026-08-20T14:00:00.000Z';
        const h = harness(existing);
        writeCooldownMarker({
            writeFile: h.writeFile, rename: h.rename, readFile: h.readFile,
            now: NOW, cooldownMs: 30 * 60 * 1000, path: markerPath,
        });
        assert.equal(h.written.final, existing, 'the 4h quota pause must survive a 30-min auth write');
    });

    it('extends when the new claim is longer', () => {
        const h = harness('2026-08-20T10:30:00.000Z');   // 30 min left
        writeCooldownMarker({
            writeFile: h.writeFile, rename: h.rename, readFile: h.readFile,
            now: NOW, cooldownMs: 4 * 60 * 60 * 1000, path: markerPath,
        });
        assert.equal(h.written.final, '2026-08-20T14:00:00.000Z');
    });

    it('writes normally when no marker exists', () => {
        const h = harness(null);
        writeCooldownMarker({
            writeFile: h.writeFile, rename: h.rename, readFile: h.readFile,
            now: NOW, cooldownMs: 30 * 60 * 1000, path: markerPath,
        });
        assert.equal(h.written.final, '2026-08-20T10:30:00.000Z');
    });

    it('still writes when readFile is omitted (back-compat with other callers)', () => {
        const h = harness(null);
        writeCooldownMarker({
            writeFile: h.writeFile, rename: h.rename,
            now: NOW, cooldownMs: 30 * 60 * 1000, path: markerPath,
        });
        assert.equal(h.written.final, '2026-08-20T10:30:00.000Z');
    });

    it('falls back to the new expiry when the existing marker is unreadable', () => {
        const h = harness('not-a-date');
        writeCooldownMarker({
            writeFile: h.writeFile, rename: h.rename, readFile: h.readFile,
            now: NOW, cooldownMs: 30 * 60 * 1000, path: markerPath,
        });
        assert.equal(h.written.final, '2026-08-20T10:30:00.000Z');
    });
});
