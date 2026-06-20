import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, reloadConfig } from '../../src/config/env.js';

// ensureApiKey() can write config/credentials.json AFTER another module has
// already triggered the getConfig() singleton at import time (src/http/client.js
// reads getConfig() at module scope). reloadConfig() invalidates that cache so
// the freshly-written API key is picked up on the next read.
test('reloadConfig rebuilds the cached config (returns a fresh instance)', () => {
    const a = getConfig();
    assert.equal(getConfig(), a, 'getConfig caches and returns the same instance');
    const b = reloadConfig();
    assert.notEqual(b, a, 'reloadConfig returns a newly-built instance');
    assert.equal(getConfig(), b, 'subsequent getConfig returns the reloaded instance');
});
