import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchUrl } from '../../scrapers/monster.js';

// VERIFIED LIVE: where=United States → appsapi 403 (Monster can't geocode it);
// where=(empty) → appsapi 200 + jobs. So country-level values must map to empty.
test('searchUrl: country-level locations → empty where (nationwide)', () => {
    for (const loc of ['United States', 'united states', 'USA', 'U.S.A.', 'US', 'Remote', 'Nationwide', '', null, undefined]) {
        const u = searchUrl('software engineer', loc, 1);
        assert.match(u, /[?&]where=&/, `expected empty where for "${loc}" → ${u}`);
    }
});

test('searchUrl: a real city/state location is preserved', () => {
    const u = searchUrl('software engineer', 'New York, NY', 1);
    assert.match(u, /where=New%20York%2C%20NY/);
});

test('searchUrl: encodes query + sets page', () => {
    const u = searchUrl('c++ developer', 'Austin, TX', 3);
    assert.match(u, /\?q=c%2B%2B%20developer/);
    assert.match(u, /&page=3$/);
});
