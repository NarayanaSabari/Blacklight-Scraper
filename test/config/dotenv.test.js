import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv, applyDotEnv } from '../../src/config/env.js';

test('parseDotEnv: skips blanks/comments, splits on first =, strips one quote layer', () => {
    const kv = parseDotEnv([
        '# a comment',
        '',
        '   ',
        'NODE_ENV=production',
        'PORT = 3001 ',
        'Q="has = and spaces"',
        "S='single'",
        'NOEQUALSLINE',
        '=novalue',
        'URL=https://x/y?a=b',
    ].join('\n'));
    assert.deepEqual(kv, {
        NODE_ENV: 'production',
        PORT: '3001',
        Q: 'has = and spaces',
        S: 'single',
        URL: 'https://x/y?a=b',
    });
});

test('applyDotEnv: only sets keys that are undefined (real env wins)', () => {
    const env = { EXISTING: 'keep' };
    applyDotEnv({ EXISTING: 'override', NEW: 'set' }, env);
    assert.equal(env.EXISTING, 'keep');
    assert.equal(env.NEW, 'set');
});

test('applyDotEnv: treats empty-string existing as set (does not override)', () => {
    const env = { E: '' };
    applyDotEnv({ E: 'x' }, env);
    assert.equal(env.E, '');
});
