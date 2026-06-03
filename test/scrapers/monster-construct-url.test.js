import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructJobUrl } from '../../scrapers/monster.js';

const UUID = '8026b6c6-ba38-4c42-aea1-67cb6f0feed5';

test('constructJobUrl: real href takes priority over uuid', () => {
    const href = 'https://www.monster.com/job-openings/principal-engineer-redmond-wa--abcdef';
    assert.equal(constructJobUrl(href, UUID), href);
});

test('constructJobUrl: missing href → constructs from uuid', () => {
    assert.equal(constructJobUrl(null, UUID), `https://www.monster.com/job-openings/${UUID}`);
    assert.equal(constructJobUrl(undefined, UUID), `https://www.monster.com/job-openings/${UUID}`);
    assert.equal(constructJobUrl('', UUID), `https://www.monster.com/job-openings/${UUID}`);
});

test('constructJobUrl: relative href is resolved against monster.com', () => {
    assert.equal(constructJobUrl('/job-openings/foo--abc', UUID), 'https://www.monster.com/job-openings/foo--abc');
});

test('constructJobUrl: missing both → null', () => {
    assert.equal(constructJobUrl(null, null), null);
    assert.equal(constructJobUrl('', ''), null);
    assert.equal(constructJobUrl(undefined, undefined), null);
});

test('constructJobUrl: invalid uuid + no href → null (rejects garbage)', () => {
    assert.equal(constructJobUrl(null, ''), null);
});
