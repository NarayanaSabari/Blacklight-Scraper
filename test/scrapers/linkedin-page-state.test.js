import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedinPageState } from '../../scrapers/linkedin.js';

test('results: componentkey post containers present', () => {
    assert.equal(linkedinPageState(
        '<main><div componentkey="expandedXYFeedType_FLAGSHIP_SEARCH"></div></main>',
        'https://www.linkedin.com/search/results/content/?keywords=x', 'Search | LinkedIn'), 'results');
});
test('results: legacy feed-shared container present', () => {
    assert.equal(linkedinPageState(
        '<div class="feed-shared-update-v2">post</div>', 'https://www.linkedin.com/feed/', 'Feed | LinkedIn'), 'results');
});
test('no_results: LinkedIn empty-state text, no containers', () => {
    assert.equal(linkedinPageState(
        '<div>No results found</div><div>Try searching for something else</div>',
        'https://www.linkedin.com/search/results/content/?keywords=zzz', 'Search | LinkedIn'), 'no_results');
});
test('auth_wall: login/authwall URL', () => {
    assert.equal(linkedinPageState('<html></html>',
        'https://www.linkedin.com/authwall?trk=x', 'Sign In | LinkedIn'), 'auth_wall');
});
test('auth_wall: checkpoint URL', () => {
    assert.equal(linkedinPageState('<html></html>',
        'https://www.linkedin.com/checkpoint/lg/login-submit', 'Security Verification'), 'auth_wall');
});
test('challenge: cloudflare/datadome marker (defensive)', () => {
    assert.equal(linkedinPageState('<div id="challenge-platform"></div>',
        'https://www.linkedin.com/feed/', 'Just a moment...'), 'challenge');
});
test('unknown: nothing recognizable (not falsely "results")', () => {
    assert.equal(linkedinPageState('<div>weird partial</div>',
        'https://www.linkedin.com/feed/', 'LinkedIn'), 'unknown');
});
test('safe on junk input', () => {
    assert.equal(linkedinPageState(null, null, null), 'unknown');
    assert.equal(linkedinPageState(42, {}, []), 'unknown');
});
