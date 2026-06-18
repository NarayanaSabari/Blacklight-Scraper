import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pickGlassdoorLocation } from '../../scrapers/glassdoor.js';

const CANNED = JSON.parse(fs.readFileSync(new URL('../fixtures/glassdoor-locations.json', import.meta.url), 'utf-8'));

test('pick: remote term short-circuits to the remote sentinel (no results needed)', () => {
    assert.deepEqual(pickGlassdoorLocation([], 'Remote'), { remote: true });
    assert.deepEqual(pickGlassdoorLocation(null, 'remote '), { remote: true });
});
test('pick: exact label match preferred (United States → N1)', () => {
    const r = pickGlassdoorLocation(CANNED['United States'], 'United States');
    assert.deepEqual(r, { locType: 'N', locId: 1, slug: 'united-states' });
});
test('pick: first ranked result when no exact match (New York → city)', () => {
    const r = pickGlassdoorLocation(CANNED['New York'], 'New York');
    assert.equal(r.locType, 'C');
    assert.equal(r.locId, 1132348);
    assert.equal(r.slug, 'new-york');
});
test('pick: state results (California → S2280)', () => {
    const r = pickGlassdoorLocation(CANNED['California'], 'California');
    assert.deepEqual(r, { locType: 'S', locId: 2280, slug: 'california' });
});
test('pick: empty results → null (caller falls back to US pin)', () => {
    assert.equal(pickGlassdoorLocation(CANNED['garbage-no-match'], 'zzz'), null);
    assert.equal(pickGlassdoorLocation(undefined, 'zzz'), null);
});
