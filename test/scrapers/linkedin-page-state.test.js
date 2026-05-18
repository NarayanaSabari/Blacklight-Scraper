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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scrapers', 'linkedin.js'), 'utf8');

test('precedence: challenge marker wins even if results markers also present', () => {
    assert.equal(linkedinPageState(
        '<div id="challenge-platform"><div componentkey="expandedZ"></div></div>',
        'https://www.linkedin.com/feed/', 'Just a moment...'), 'challenge');
});
test('imports assertNotBlocked from the proven module', () => {
    assert.match(SRC, /import\s*\{\s*assertNotBlocked\s*\}\s*from\s*['"]\.\.\/src\/core\/block-detection\.js['"]/);
});
test('STRICT const present and every assertNotBlocked() is STRICT-gated', () => {
    assert.match(SRC, /const\s+STRICT\s*=\s*process\.env\.SCRAPER_STRICT_EMPTY\s*===\s*['"]true['"]/);
    const calls = [...SRC.matchAll(/assertNotBlocked\s*\(/g)];
    assert.ok(calls.length >= 1);
    for (const m of calls) {
        assert.ok(/if\s*\(\s*STRICT\s*\)/.test(SRC.slice(Math.max(0, m.index - 500), m.index)),
            'assertNotBlocked call not within an if (STRICT) guard');
    }
});
test('the new 0-posts throw is STRICT-gated', () => {
    assert.match(SRC, /if\s*\(\s*STRICT\b[^)]*\)\s*\{[^}]*throw new DomChangedError/s);
});
test('scrapeLinkedIn returns the {jobs, emptyConfirmed} contract', () => {
    assert.match(SRC, /return\s*\{\s*jobs:\s*normalizedPosts\s*,\s*emptyConfirmed/);
});
test('D4: sameSite never passes the raw value through', () => {
    assert.doesNotMatch(SRC, /:\s*c\.sameSite\s*\|\|\s*'Lax'/);
});
test('L5: stale "(CDP Method)" banner removed', () => {
    assert.doesNotMatch(SRC, /CDP Method/);
});
test('catch routes typed errors via instanceof BEFORE substring fallback', () => {
    const i = SRC.indexOf('lastError = error;');
    const blk = SRC.indexOf('error instanceof BlockedError');
    const dom = SRC.indexOf('error instanceof DomChangedError');
    const aut = SRC.indexOf('error instanceof AuthError');
    const sub = SRC.indexOf("!loginSuccess");
    assert.ok(i >= 0 && blk > i && dom > blk && aut > dom, 'typed branches missing/misordered');
    assert.ok(sub > aut, 'instanceof routing must precede the !loginSuccess substring branch');
    assert.match(SRC, /instanceof BlockedError[^]*reportFailure\([^,]+,\s*60\)/);
    assert.match(SRC, /instanceof DomChangedError[^]*reportFailure\([^,]+,\s*30\)/);
});
test('auth-wall throws AuthError (not a plain Error)', () => {
    assert.match(SRC, /throw new AuthError\('LinkedIn auth-wall \/ checkpoint after search navigation/);
    assert.match(SRC, /import\s*\{[^}]*\bAuthError\b[^}]*\}\s*from\s*['"]\.\.\/src\/core\/errors\.js['"]/);
});
test('LinkedIn launches HEADED by default (headless only via LINKEDIN_HEADLESS=true)', () => {
    assert.match(SRC, /launch\(\{\s*headless:\s*process\.env\.LINKEDIN_HEADLESS\s*===\s*'true',\s*humanize:\s*true\s*\}\)/);
    assert.doesNotMatch(SRC, /launch\(\{\s*headless:\s*true,\s*humanize:\s*true\s*\}\)/);
});
