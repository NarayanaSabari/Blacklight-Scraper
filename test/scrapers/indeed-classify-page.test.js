import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyIndeedSearchPage } from '../../scrapers/indeed.js';

const NO_RESULTS_HTML = fs.readFileSync(new URL('../fixtures/indeed-no-results.html', import.meta.url), 'utf-8');

test('classifyIndeedSearchPage: anchors > 0 → results', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer&l=US',
        bodyText: 'Software Engineer jobs in United States',
        anchorCount: 16,
        sawAuthBounce: false,
        bytes: 1_500_000,
        html: '',
    });
    assert.equal(r.state, 'results');
});

test('classifyIndeedSearchPage: secure.indeed.com/auth bounce → auth_required', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://secure.indeed.com/auth?co=US&hl=en_US&continue=...&branding=page-two-signin',
        bodyText: '',
        anchorCount: 0,
        sawAuthBounce: true,
        bytes: 50_000,
        html: '',
    });
    assert.equal(r.state, 'auth_required');
});

test('classifyIndeedSearchPage: Cloudflare interstitial → soft_blocked', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: 'Just a moment... Verify you are human. Ray ID: abc123',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: 8_000,
        html: '',
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyIndeedSearchPage: real no-results fixture → empty_confirmed', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=xyzqqq',
        bodyText: 'We didn\'t find any results for this search.',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: NO_RESULTS_HTML.length,
        html: NO_RESULTS_HTML,
    });
    assert.equal(r.state, 'empty_confirmed');
});

test('classifyIndeedSearchPage: 200 + large page + 0 anchors + no signals → dom_changed', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: 'Some long marketing prose without job cards',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: 200_000,
        html: '<html><body>...nothing matching empty-result regex...</body></html>',
    });
    assert.equal(r.state, 'dom_changed');
});

test('classifyIndeedSearchPage: tiny body + no positive signal → network_error', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: '',
        anchorCount: 0,
        sawAuthBounce: false,
        bytes: 5_000,
        html: '',
    });
    assert.equal(r.state, 'network_error');
});

test('classifyIndeedSearchPage: Cloudflare text wins over anchors (defensive)', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://www.indeed.com/jobs?q=engineer',
        bodyText: 'access denied — please verify you are human',
        anchorCount: 16,
        sawAuthBounce: false,
        bytes: 100_000,
        html: '',
    });
    assert.equal(r.state, 'soft_blocked');
});

test('classifyIndeedSearchPage: auth_required wins over cards (cookies invalid, partial render)', () => {
    const r = classifyIndeedSearchPage({
        url: 'https://secure.indeed.com/auth?continue=...&from=page-two-signin',
        bodyText: 'Sign in',
        anchorCount: 16,
        sawAuthBounce: true,
        bytes: 100_000,
        html: '',
    });
    assert.equal(r.state, 'auth_required');
});
