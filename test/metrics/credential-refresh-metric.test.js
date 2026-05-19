import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMetrics } from '../../src/metrics/registry.js';

test('recordCredentialRefresh exists and is crash-safe for any args', () => {
    const m = getMetrics();
    assert.equal(typeof m.recordCredentialRefresh, 'function');
    assert.doesNotThrow(() => m.recordCredentialRefresh('linkedin', 'refreshed'));
    assert.doesNotThrow(() => m.recordCredentialRefresh('linkedin', 'skipped_no_li_at'));
    assert.doesNotThrow(() => m.recordCredentialRefresh(undefined, undefined));
});
