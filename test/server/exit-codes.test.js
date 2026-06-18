import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor, EXIT_REASONS } from '../../src/server/exit-codes.js';

test('exitCodeFor: signal → 0 (clean)', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.SIGNAL), 0);
    assert.equal(exitCodeFor('signal'), 0);
});

test('exitCodeFor: auth-dead → 2', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.AUTH_DEAD), 2);
});

test('exitCodeFor: lease-starved → 3', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.LEASE_STARVED), 3);
});

test('exitCodeFor: crash → 42', () => {
    assert.equal(exitCodeFor(EXIT_REASONS.CRASH), 42);
});

test('exitCodeFor: unknown reason → 1', () => {
    assert.equal(exitCodeFor('nope'), 1);
    assert.equal(exitCodeFor(undefined), 1);
});
