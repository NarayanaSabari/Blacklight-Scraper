import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scraperHeadless, stealthLaunchOptions } from '../../src/core/launch-config.js';

test('scraperHeadless: default true; false/0/no/off → headful', () => {
    assert.equal(scraperHeadless({}), true);
    assert.equal(scraperHeadless({ SCRAPER_HEADLESS: '' }), true);
    assert.equal(scraperHeadless({ SCRAPER_HEADLESS: 'true' }), true);
    assert.equal(scraperHeadless({ SCRAPER_HEADLESS: '1' }), true);
    for (const v of ['false', '0', 'no', 'off']) {
        assert.equal(scraperHeadless({ SCRAPER_HEADLESS: v }), false, `"${v}" should be headful`);
    }
});

test('stealthLaunchOptions: geoip + us tz/locale + humanize; proxy optional; headless honors env', () => {
    const o = stealthLaunchOptions({}, {});
    assert.equal(o.geoip, true);
    assert.equal(o.timezone, 'America/New_York');
    assert.equal(o.locale, 'en-US');
    assert.equal(o.humanize, true);
    assert.equal(o.headless, true);
    assert.ok(!('proxy' in o), 'no proxy key when none passed (direct)');

    const p = { server: 'http://ip:1', username: 'u', password: 'x' };
    const o2 = stealthLaunchOptions({ proxy: p }, { SCRAPER_HEADLESS: 'false' });
    assert.deepEqual(o2.proxy, p);
    assert.equal(o2.headless, false);
});
