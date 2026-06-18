import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ScraperError,
    BlockedError,
    DomChangedError,
} from '../../src/core/errors.js';

test('BlockedError extends ScraperError with BLOCKED code and kind', () => {
    const err = new BlockedError('blocked on indeed', {
        kind: 'cloudflare',
        platform: 'indeed',
    });
    assert.ok(err instanceof ScraperError);
    assert.ok(err instanceof BlockedError);
    assert.equal(err.name, 'BlockedError');
    assert.equal(err.code, 'BLOCKED');
    assert.equal(err.kind, 'cloudflare');
    assert.equal(err.platform, 'indeed');
});

test('BlockedError defaults kind to null and preserves cause', () => {
    const cause = new Error('root');
    const err = new BlockedError('blocked', { cause });
    assert.equal(err.kind, null);
    assert.equal(err.cause, cause);
});

test('DomChangedError extends ScraperError with DOM_CHANGED code', () => {
    const err = new DomChangedError('selectors matched 0 of expected', {
        platform: 'linkedin',
    });
    assert.ok(err instanceof ScraperError);
    assert.ok(err instanceof DomChangedError);
    assert.equal(err.name, 'DomChangedError');
    assert.equal(err.code, 'DOM_CHANGED');
    assert.equal(err.platform, 'linkedin');
});

test('DomChangedError preserves cause', () => {
    const cause = new Error('selector not found');
    const err = new DomChangedError('DOM changed', { cause });
    assert.equal(err.cause, cause);
});
