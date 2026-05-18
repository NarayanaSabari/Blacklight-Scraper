import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../src/metrics/classify.js';
import {
    BlockedError,
    DomChangedError,
    AuthError,
    TimeoutError,
    NetworkError,
} from '../../src/core/errors.js';

test('BlockedError classifies as "blocked"', () => {
    assert.equal(classifyError(new BlockedError('cf', { kind: 'cloudflare' })), 'blocked');
});

test('DomChangedError classifies as "dom_changed"', () => {
    assert.equal(classifyError(new DomChangedError('no containers')), 'dom_changed');
});

test('existing mappings are unchanged', () => {
    assert.equal(classifyError(new AuthError('login failed')), 'auth_required');
    assert.equal(classifyError(new TimeoutError('timed out')), 'timeout');
    assert.equal(classifyError(new NetworkError('boom', { statusCode: 429 })), 'rate_limited');
    assert.equal(classifyError(new NetworkError('boom', { statusCode: 403 })), 'auth_required');
    assert.equal(classifyError(new Error('captcha challenge datadome')), 'captcha');
    assert.equal(classifyError(null), 'unknown');
});
