// Scraper registry — the one place that knows which platforms exist.
//
// Each entry wraps a concrete scraper function in a BaseScraper, giving
// consistent logging + error normalization without forcing each scraper
// file to reshape into a class.

import { BaseScraper } from '../core/base-scraper.js';
import { scrapeDice } from '../../scrapers/dice.js';
import { scrapeTechFetch } from '../../scrapers/techfetch.js';
import { scrapeLinkedInRsc } from './linkedin-rsc/scraper.js';
import { scrapeGlassdoor } from '../../scrapers/glassdoor.js';
import { scrapeIndeed } from '../../scrapers/indeed.js';
import { scrapeMonster } from '../../scrapers/monster.js';

export const SCRAPERS = Object.freeze({
    dice: new BaseScraper('dice', scrapeDice, { strictEmpty: true }),
    techfetch: new BaseScraper('techfetch', scrapeTechFetch, { strictEmpty: true }),
    // LinkedIn reads permalinks straight out of the search payload, so the
    // silent-empty guards are safe to arm: there is no clipboard-menu step whose
    // breakage would look like a clean zero.
    linkedin: new BaseScraper('linkedin', scrapeLinkedInRsc, { strictEmpty: true }),
    glassdoor: new BaseScraper('glassdoor', scrapeGlassdoor, { strictEmpty: true }),
    indeed: new BaseScraper('indeed', scrapeIndeed, { strictEmpty: true }),
    monster: new BaseScraper('monster', scrapeMonster, { strictEmpty: true }),
});

export const PLATFORM_NAMES = Object.freeze(Object.keys(SCRAPERS));

export function getScraper(platform) {
    return SCRAPERS[platform.toLowerCase()] ?? null;
}
