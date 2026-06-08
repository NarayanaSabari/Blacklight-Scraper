import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMonsterPage } from '../../scrapers/monster.js';

test('classifyMonsterPage: appsapi POST seen + cards > 0 → results', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results for Software Engineer ...',
        cardCount: 18,
        sawApiResponse: true,
    });
    assert.equal(r.state, 'results');
});

test('classifyMonsterPage: "No jobs found matching" text → empty_confirmed', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=unobtainium&page=1',
        bodyText: 'No jobs found matching your search ...',
        cardCount: 0,
        sawApiResponse: true,
    });
    assert.equal(r.state, 'empty_confirmed');
});

test('classifyMonsterPage: redirect to captcha-delivery.com → soft_blocked', () => {
    const r = classifyMonsterPage({
        url: 'https://geo.captcha-delivery.com/interstitial/?...',
        bodyText: 'Please verify you are human',
        cardCount: 0,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'soft_blocked');
    assert.match(r.signal, /captcha-delivery|verify/i);
});

test('classifyMonsterPage: DataDome body text → soft_blocked', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=2',
        bodyText: 'Welcome. Please complete the security check. DataDome ray id #abc',
        cardCount: 0,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyMonsterPage: appsapi POST seen + cards=0 + no empty-results text → dom_changed', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results for Software Engineer in United States ... some boilerplate',
        cardCount: 0,
        sawApiResponse: true,
    });
    assert.equal(r.state, 'dom_changed');
});

test('classifyMonsterPage: no appsapi + cards=0 + no block text → network_error', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Empty body',
        cardCount: 0,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'network_error');
});

test('classifyMonsterPage: cards > 0 even without explicit appsapi → results (degraded)', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results ...',
        cardCount: 18,
        sawApiResponse: false,
    });
    assert.equal(r.state, 'results');
});

test('classifyMonsterPage: apiResponseInspection="empty-payload" + cardCount=0 → soft_blocked (DataDome silent suppress)', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results for Software Engineer ... boilerplate',
        cardCount: 0,
        sawApiResponse: true,
        apiResponseInspection: 'empty-payload',
    });
    assert.equal(r.state, 'soft_blocked');
    assert.match(r.signal, /empty-payload|empty payload/i);
});

test('classifyMonsterPage: apiResponseInspection="has-jobs" + cardCount=0 → dom_changed (cards missing despite API data)', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results for Software Engineer in United States ... boilerplate',
        cardCount: 0,
        sawApiResponse: true,
        apiResponseInspection: 'has-jobs',
    });
    assert.equal(r.state, 'dom_changed');
});

test('classifyMonsterPage: apiResponseInspection is optional (existing callers unaffected)', () => {
    const r = classifyMonsterPage({
        url: 'https://www.monster.com/jobs/search?q=engineer&page=1',
        bodyText: 'Search results',
        cardCount: 60,
        sawApiResponse: true,
    });
    assert.equal(r.state, 'results');
});
