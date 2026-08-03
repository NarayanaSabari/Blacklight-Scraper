import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, list, __resetForTest } from '../../src/panel/recent.js';

test.beforeEach(() => __resetForTest());

test('record + list: most recent entry first', () => {
    record({ platform: 'dice', sessionId: 's1', jobsSent: 3, outcome: 'accepted' });
    record({ platform: 'indeed', sessionId: 's2', jobsSent: 0, outcome: 'empty_confirmed' });
    const entries = list();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].platform, 'indeed');
    assert.equal(entries[1].platform, 'dice');
    assert.equal(typeof entries[0].timestamp, 'string');
});

test('ring buffer wraps at 50 entries, dropping the oldest', () => {
    for (let i = 0; i < 55; i++) {
        record({ platform: 'dice', sessionId: `s${i}`, jobsSent: i, outcome: 'accepted' });
    }
    const entries = list();
    assert.equal(entries.length, 50);
    // Most recent (s54) first; oldest retained is s5 (0..4 dropped).
    assert.equal(entries[0].sessionId, 's54');
    assert.equal(entries[entries.length - 1].sessionId, 's5');
});

test('defensive: missing/malformed fields never throw and normalize to safe defaults', () => {
    assert.doesNotThrow(() => record(undefined));
    assert.doesNotThrow(() => record(null));
    assert.doesNotThrow(() => record({}));
    assert.doesNotThrow(() => record({ jobsSent: 'not-a-number' }));
    const entries = list();
    assert.equal(entries.length, 4);
    for (const e of entries) {
        assert.equal(typeof e.platform, 'string');
        assert.equal(typeof e.jobsSent, 'number');
        assert.equal(typeof e.outcome, 'string');
    }
});
