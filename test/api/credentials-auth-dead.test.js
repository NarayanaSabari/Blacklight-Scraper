import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFailureBody } from '../../src/api/credentials.js';

test('planFailureBody with authDead:true → auth_dead:true + existing fields preserved', () => {
    const body = planFailureBody({ errorMessage: 'needs relogin', cooldownMinutes: 30, authDead: true });
    assert.equal(body.auth_dead, true);
    assert.equal(body.error_message, 'needs relogin');
    assert.equal(body.cooldown_minutes, 30);
});

test('planFailureBody default (no authDead) → auth_dead:false', () => {
    const body = planFailureBody({ errorMessage: 'timeout', cooldownMinutes: 0 });
    assert.equal(body.auth_dead, false);
    assert.equal(body.error_message, 'timeout');
    assert.equal(body.cooldown_minutes, 0);
});

test('planFailureBody authDead:false explicitly → auth_dead:false', () => {
    const body = planFailureBody({ errorMessage: 'err', cooldownMinutes: 5, authDead: false });
    assert.equal(body.auth_dead, false);
});

test('planFailureBody truthy non-boolean authDead → auth_dead:true (boolean coercion)', () => {
    const body = planFailureBody({ errorMessage: 'err', cooldownMinutes: 0, authDead: 1 });
    assert.equal(body.auth_dead, true);
    assert.equal(typeof body.auth_dead, 'boolean');
});
