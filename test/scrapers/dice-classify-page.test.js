import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiceSearchPage } from '../../scrapers/dice.js';

test('classifyDiceSearchPage: anchors > 0 → results', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'Search Results 1 - 60 of...',
        anchorCount: 60,
        bytes: 350_000,
    });
    assert.equal(r.state, 'results');
});

test('classifyDiceSearchPage: "no jobs found" text + 0 anchors → empty_confirmed', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=unobtainium&page=1',
        bodyText: 'No jobs found matching your search.',
        anchorCount: 0,
        bytes: 280_000,
    });
    assert.equal(r.state, 'empty_confirmed');
});

test('classifyDiceSearchPage: Cloudflare interstitial → soft_blocked', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'Please verify you are human. Ray ID: abc123. Cloudflare.',
        anchorCount: 0,
        bytes: 12_000,
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyDiceSearchPage: 0 anchors + no empty text + large rendered page → dom_changed', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'Some long marketing page with totally different structure that did render fully.',
        anchorCount: 0,
        bytes: 200_000,
    });
    assert.equal(r.state, 'dom_changed');
});

test('classifyDiceSearchPage: 0 anchors + small body + no signal → network_error', () => {
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: '',
        anchorCount: 0,
        bytes: 8_000,
    });
    assert.equal(r.state, 'network_error');
});

test('classifyDiceSearchPage: cards present but Cloudflare text → soft_blocked still wins', () => {
    // Defensive: if both signals are present somehow, the block signal
    // is canonical because cards could be a stale prerender.
    const r = classifyDiceSearchPage({
        url: 'https://www.dice.com/jobs?q=engineer&page=1',
        bodyText: 'access denied — verify human',
        anchorCount: 60,
        bytes: 350_000,
    });
    assert.equal(r.state, 'soft_blocked');
});
