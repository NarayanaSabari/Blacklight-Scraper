// Scraper registry — the one place that knows which platforms exist.
//
// Each entry wraps a concrete scraper function in a BaseScraper, giving
// consistent logging + error normalization without forcing each scraper
// file to reshape into a class.

import { BaseScraper } from '../core/base-scraper.js';
import { scrapeDice } from '../../scrapers/dice.js';
import { scrapeTechFetch } from '../../scrapers/techfetch.js';
import { scrapeLinkedIn } from '../../scrapers/linkedin.js';
import { scrapeGlassdoor } from '../../scrapers/glassdoor.js';
import { scrapeIndeed } from '../../scrapers/indeed.js';
import { scrapeMonster } from '../../scrapers/monster.js';

export const SCRAPERS = Object.freeze({
    dice: new BaseScraper('dice', scrapeDice, { strictEmpty: true }),
    techfetch: new BaseScraper('techfetch', scrapeTechFetch),
    linkedin: new BaseScraper('linkedin', scrapeLinkedIn),
    glassdoor: new BaseScraper('glassdoor', scrapeGlassdoor),
    indeed: new BaseScraper('indeed', scrapeIndeed),
    monster: new BaseScraper('monster', scrapeMonster, { strictEmpty: true }),
});

export const PLATFORM_NAMES = Object.freeze(Object.keys(SCRAPERS));

export function getScraper(platform) {
    return SCRAPERS[platform.toLowerCase()] ?? null;
}
