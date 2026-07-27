// SCR-28: SCRAPE_SAVE_RESULTS gates the manual /scrape results/ file write,
// off by default. See DEFAULTS.SCRAPE_SAVE_RESULTS in src/config/env.js for
// the rationale.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, resetConfigForTest } from '../../src/config/env.js';

let originalValue;

before(() => {
    originalValue = process.env.SCRAPE_SAVE_RESULTS;
});

after(() => {
    if (originalValue === undefined) delete process.env.SCRAPE_SAVE_RESULTS;
    else process.env.SCRAPE_SAVE_RESULTS = originalValue;
    resetConfigForTest();
});

test('scrape.saveResultsToDisk defaults to false when unset', () => {
    delete process.env.SCRAPE_SAVE_RESULTS;
    resetConfigForTest();
    assert.equal(getConfig().scrape.saveResultsToDisk, false);
});

test('scrape.saveResultsToDisk is false for any non-"true" value', () => {
    process.env.SCRAPE_SAVE_RESULTS = 'yes';
    resetConfigForTest();
    assert.equal(getConfig().scrape.saveResultsToDisk, false);
});

test('scrape.saveResultsToDisk is true only when explicitly set to "true"', () => {
    process.env.SCRAPE_SAVE_RESULTS = 'true';
    resetConfigForTest();
    assert.equal(getConfig().scrape.saveResultsToDisk, true);
});
