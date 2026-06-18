import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPasswordLogin } from '../../scrapers/linkedin.js';

test('canPasswordLogin: true only with non-empty email AND password', () => {
    assert.equal(canPasswordLogin({ email: 'a@b.c', password: 'p' }), true);
});

test('canPasswordLogin: false for cookie-only / partial / missing creds', () => {
    assert.equal(canPasswordLogin({}), false);
    assert.equal(canPasswordLogin({ email: 'a@b.c' }), false);
    assert.equal(canPasswordLogin({ password: 'p' }), false);
    assert.equal(canPasswordLogin({ email: '', password: 'p' }), false);
    assert.equal(canPasswordLogin({ email: 'a@b.c', password: '' }), false);
    assert.equal(canPasswordLogin(null), false);
    assert.equal(canPasswordLogin(undefined), false);
    assert.equal(canPasswordLogin({ credentials: [{ name: 'li_at' }] }), false);
});
