import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlock } from '../../src/core/block-detection.js';

test('clean results page is not blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.indeed.com/jobs?q=node&start=0',
        title: 'node jobs, Employment | Indeed.com',
        html: '<div class="job_seen_beacon">...</div>',
    });
    assert.equal(r.blocked, false);
    assert.equal(r.kind, null);
});

test('HTTP 403 is blocked (http_forbidden)', () => {
    const r = detectBlock({ status: 403, finalUrl: 'https://x', title: '' });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'http_forbidden');
});

test('HTTP 429 is blocked (rate_limited)', () => {
    const r = detectBlock({ status: 429, finalUrl: 'https://x', title: '' });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'rate_limited');
});

test('Cloudflare "Just a moment" interstitial is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.glassdoor.com/Job/jobs.htm',
        title: 'Just a moment...',
        html: '<div id="challenge-platform"></div>',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'cloudflare');
});

test('DataDome captcha marker is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.monster.com/jobs/search',
        title: 'monster',
        html: '<script src="https://geo.captcha-delivery.com/captcha/"></script>',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'datadome');
});

test('Indeed "Additional Verification Required" title is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.indeed.com/jobs?q=node',
        title: 'Additional Verification Required',
        html: '<body>Ray ID: 8a...</body>',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'challenge_page');
});

test('auth-wall URL fragment is blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.linkedin.com/checkpoint/lg/login-submit',
        title: 'LinkedIn',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.kind, 'auth_wall');
});

test('legit title containing the word "security" is NOT a false positive', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.dice.com/jobs?q=security+engineer',
        title: 'Security Engineer Jobs | Dice.com',
        html: '<div data-testid="job-search-results"></div>',
    });
    assert.equal(r.blocked, false);
});

test('legit job URL slug containing "challenge" is NOT blocked (segment-anchored fragment)', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.indeed.com/jobs/challenge-engineer-12345',
        title: 'Challenge Engineer Jobs | Indeed.com',
        html: '<div class="job_seen_beacon">role</div>',
    });
    assert.equal(r.blocked, false);
});

test('job page whose body merely mentions datadome/cloudflare is NOT blocked', () => {
    const r = detectBlock({
        status: 200,
        finalUrl: 'https://www.dice.com/job/12345',
        title: 'Security Engineer | Example',
        html: '<p>We use DataDome and Cloudflare to protect our API. Now hiring a security engineer.</p>',
    });
    assert.equal(r.blocked, false);
});
