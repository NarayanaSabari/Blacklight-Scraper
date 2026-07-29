// LinkedIn is served by the RSC transport only. The DOM scraper (scrolling plus
// per-post clipboard-menu permalink resolution) was removed: it resolved zero
// permalinks against live LinkedIn, so every post it extracted was dropped by the
// importable filter while the scrape reported success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRAPERS, PLATFORM_NAMES, getScraper } from '../../src/scrapers/registry.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';

test('registry: linkedin is served by the RSC scraper', () => {
    assert.equal(SCRAPERS.linkedin.scraperFn, scrapeLinkedInRsc);
    assert.equal(SCRAPERS.linkedin.platform, 'linkedin');
});

test('registry: linkedin arms the silent-empty guards', () => {
    // Safe here (and NOT on the old DOM path): permalinks come from the payload,
    // so a genuine empty is distinguishable from a block.
    assert.equal(SCRAPERS.linkedin.strictEmpty, true);
});

test('registry: linkedin is still resolvable by name and listed as a platform', () => {
    assert.equal(getScraper('linkedin'), SCRAPERS.linkedin);
    assert.equal(getScraper('LinkedIn'), SCRAPERS.linkedin);
    assert.ok(PLATFORM_NAMES.includes('linkedin'));
});

test('registry: no transport flag remains — there is only one LinkedIn path', async () => {
    const mod = await import('../../src/scrapers/registry.js');
    assert.equal(mod.linkedinTransport, undefined);
    assert.equal(mod.resolveLinkedinScraper, undefined);
});
