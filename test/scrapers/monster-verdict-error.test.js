import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monsterErrorForVerdict, isRetryableMonsterError, classifyMonsterPage } from '../../scrapers/monster.js';

// Monster is DataDome-gated and the block is per-IP and roughly a coin flip, so
// scrapeMonster is built to retry across rotating IPs. That only works if the
// block actually surfaces as a retryable error. The 'network_error' verdict
// ("page rendered but the appsapi POST never fired") is a DataDome suppression,
// not a transport failure — a genuine transport failure throws out of page.goto
// and never reaches the classifier. It used to raise NetworkError, which the
// retry loop skipped, so a recoverable block ended the whole scrape after one
// attempt. These lock that contract in.

test('soft_blocked → retryable BlockedError tagged datadome', () => {
    const e = monsterErrorForVerdict({ state: 'soft_blocked', signal: 'appsapi suppressed + 0 cards' });
    assert.equal(e.name, 'BlockedError');
    assert.equal(e.kind ?? e.context?.kind ?? e.details?.kind, 'datadome');
    assert.equal(isRetryableMonsterError(e), true);
});

test('network_error (appsapi never fired) → retryable BlockedError, not NetworkError', () => {
    const e = monsterErrorForVerdict({ state: 'network_error', signal: 'no appsapi response, no positive page signal' });
    assert.equal(e.name, 'BlockedError', 'a suppressed appsapi is a block, so the caller rotates IP and retries');
    assert.equal(isRetryableMonsterError(e), true);
    assert.match(e.message, /appsapi/);
});

test('the two block modes stay distinguishable for metrics', () => {
    const suppressed = monsterErrorForVerdict({ state: 'network_error', signal: 'x' });
    const blocked = monsterErrorForVerdict({ state: 'soft_blocked', signal: 'x' });
    const kindOf = (e) => e.kind ?? e.context?.kind ?? e.details?.kind;
    assert.notEqual(kindOf(suppressed), kindOf(blocked));
});

test('dom_changed → retryable DomChangedError', () => {
    const e = monsterErrorForVerdict({ state: 'dom_changed', signal: 'appsapi has jobs but 0 cards' });
    assert.equal(e.name, 'DomChangedError');
    assert.equal(isRetryableMonsterError(e), true);
});

test('an unexpected verdict is a non-retryable NetworkError', () => {
    const e = monsterErrorForVerdict({ state: 'something-new', signal: 'y' });
    assert.equal(e.name, 'NetworkError');
    assert.equal(isRetryableMonsterError(e), false);
});

test('the real classifier output for a suppressed appsapi is retryable end to end', () => {
    const verdict = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=Java+Developer&where=&page=1',
        bodyText: 'Monster',
        cardCount: 0,
        sawApiResponse: false,
        apiResponseInspection: null,
    });
    assert.equal(verdict.state, 'network_error');
    assert.equal(isRetryableMonsterError(monsterErrorForVerdict(verdict)), true);
});
