import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugifyForGlassdoor, buildGlassdoorSearchUrl } from '../../scrapers/glassdoor.js';

test('slugify: lowercase, spaces to hyphens', () => {
    assert.equal(slugifyForGlassdoor('Software Engineer'), 'software-engineer');
});
test('slugify: strips non-alphanumerics, collapses runs', () => {
    assert.equal(slugifyForGlassdoor('C++ / .NET  Developer!'), 'c-net-developer');
});
test('buildGlassdoorSearchUrl: verified live example (US country pin)', () => {
    // united-states (13 chars) + software-engineer (17) → IL.0,13_IN1_KO14,31
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'software engineer', loc: { locType: 'N', locId: 1, slug: 'united-states' } }),
        'https://www.glassdoor.com/Job/united-states-software-engineer-jobs-SRCH_IL.0,13_IN1_KO14,31.htm?fromAge=7',
    );
});
test('buildGlassdoorSearchUrl: state pin (California S2280)', () => {
    // california (10) + data-scientist (14) → IL.0,10_IS2280_KO11,25
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'data scientist', loc: { locType: 'S', locId: 2280, slug: 'california' } }),
        'https://www.glassdoor.com/Job/california-data-scientist-jobs-SRCH_IL.0,10_IS2280_KO11,25.htm?fromAge=7',
    );
});
test('buildGlassdoorSearchUrl: city pin (New York C1132348)', () => {
    // new-york (8) + nurse (5) → IL.0,8_IC1132348_KO9,14
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'nurse', loc: { locType: 'C', locId: 1132348, slug: 'new-york' } }),
        'https://www.glassdoor.com/Job/new-york-nurse-jobs-SRCH_IL.0,8_IC1132348_KO9,14.htm?fromAge=7',
    );
});
test('buildGlassdoorSearchUrl: remote sentinel pins US + remoteWorkType', () => {
    assert.equal(
        buildGlassdoorSearchUrl({ keyword: 'devops engineer', loc: { remote: true } }),
        'https://www.glassdoor.com/Job/united-states-devops-engineer-jobs-SRCH_IL.0,13_IN1_KO14,29.htm?fromAge=7&remoteWorkType=1',
    );
});
