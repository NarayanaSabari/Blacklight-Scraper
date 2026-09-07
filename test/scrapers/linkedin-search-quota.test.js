import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchQuotaTracker, SearchQuotaRegistry } from '../../src/scrapers/linkedin-rsc/search-quota.js';

test('empty queries request a diagnostic without creating a cooldown', () => {
    const q = new SearchQuotaTracker();
    for (let n = 0; n < 24; n++) assert.equal(q.recordEmpty().probeDue, false);
    assert.equal(q.recordEmpty().probeDue, true);
    assert.equal(q.snapshot().paused, false);
    assert.equal(q.snapshot().consecutiveTrips, 0);
    assert.equal(q.beginSearch().recovery, true);
});

test('corroborated empties retry within fifteen minutes and healthy recovery retires escalation', () => {
    let now = 1_000_000;
    const q = new SearchQuotaTracker({ now: () => now });
    assert.equal(q.finishRecovery('empty').tripped, false);
    for (const expected of [5, 10, 15, 15, 15, 15]) {
        now += 60 * 60_000;
        assert.equal(q.finishRecovery('empty').pauseMs, expected * 60_000);
    }
    q.finishRecovery('healthy');
    assert.equal(q.snapshot().consecutiveTrips, 0);
    assert.equal(q.snapshot().paused, false);
    assert.equal(q.finishRecovery('empty').tripped, false);
    now += 60_000;
    assert.equal(q.finishRecovery('empty').pauseMs, 5 * 60_000);
});

test('an inconclusive probe invalidates empty evidence and has a bounded retry', () => {
    let now = 1_000_000;
    const q = new SearchQuotaTracker({ now: () => now });
    q.finishRecovery('empty');
    for (const expected of [60_000, 120_000, 240_000, 300_000, 300_000]) {
        const result = q.finishRecovery('network_unknown');
        assert.equal(result.tripped, false);
        assert.equal(result.pauseMs, expected);
        now += expected;
    }
    assert.equal(q.snapshot().consecutiveTrips, 0);
    assert.equal(q.finishRecovery('empty').tripped, false, 'old empty evidence was invalidated');
});

test('one account cannot pause another or reset its evidence', () => {
    const registry = new SearchQuotaRegistry();
    const a = registry.forAccount({ credential: { id: 15 } });
    const b = registry.forAccount({ credential: { id: 17 } });
    a.finishRecovery('rate_limited');
    b.finishRecovery('healthy');
    assert.equal(a.beginSearch().allowed, false);
    assert.equal(b.beginSearch().allowed, true);
    assert.equal(registry.snapshot().accounts['id:15'].paused, true);
    assert.equal(registry.snapshot().accounts['id:17'].paused, false);
    assert.equal(registry.forAccount({ credential: { id: 15 } }), a);
});

test('expired cooldown admits one diagnostic and releases the slot after failure', () => {
    let now = 1_000_000;
    const q = new SearchQuotaTracker({ now: () => now });
    q.finishRecovery('rate_limited');
    assert.equal(q.beginSearch().allowed, false);
    now += 5 * 60_000;
    assert.equal(q.beginSearch().recovery, true);
    assert.equal(q.beginSearch().allowed, false);
    q.endSearch();
    assert.equal(q.beginSearch().allowed, true);
});

test('explicit rate limits retain exponential backoff and the configured maximum', () => {
    for (const [maxPause, expected] of [
        [60 * 60_000, [5, 10, 20, 40, 60, 60]],
        [90 * 60_000, [5, 10, 20, 40, 80, 90]],
    ]) {
        const q = new SearchQuotaTracker({ maxPause });
        for (const minutes of expected) {
            assert.equal(q.finishRecovery('rate_limited').pauseMs, minutes * 60_000);
        }
        assert.equal(q.snapshot().nextPauseMs, maxPause);
    }
});

test('empty recovery stays bounded after a large rate-limit trip count without weakening later rate limits', () => {
    let now = 1_000_000;
    const q = new SearchQuotaTracker({ now: () => now });
    for (let n = 0; n < 100; n++) q.finishRecovery('rate_limited');
    const result = q.finishRecovery('empty');
    assert.equal(result.pauseMs, 15 * 60_000);
    assert.equal(q.snapshot().nextPauseMs, 15 * 60_000);
    now += 15 * 60_000 - 1;
    assert.equal(q.beginSearch().allowed, false);
    now++;
    assert.equal(q.beginSearch().allowed, true);
    q.endSearch();
    assert.equal(q.finishRecovery('rate_limited').pauseMs, 60 * 60_000);
});

test('empty recovery respects a configured maximum shorter than fifteen minutes', () => {
    const q = new SearchQuotaTracker({ maxPause: 8 * 60_000 });
    q.finishRecovery('empty');
    assert.equal(q.finishRecovery('empty').pauseMs, 5 * 60_000);
    assert.equal(q.finishRecovery('empty').pauseMs, 8 * 60_000);
    assert.equal(q.snapshot().nextPauseMs, 8 * 60_000);
});
