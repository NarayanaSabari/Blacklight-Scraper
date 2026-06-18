import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTechFetchJobUrl } from '../../scrapers/techfetch.js';

test('canonical: absolutizes relative hrefs', () => {
    assert.equal(
        canonicalTechFetchJobUrl('/job-description/senior-java-dev-jackson-ms-j3631463&aid=tfjstfviewjob'),
        'https://www.techfetch.com/job-description/senior-java-dev-jackson-ms-j3631463&aid=tfjstfviewjob',
    );
});
test('canonical: strips utm_* query params but keeps aid (unverified to strip)', () => {
    assert.equal(
        canonicalTechFetchJobUrl('/job-description/x-j999&aid=tfjstfviewjob&utm_source=techfetch&utm_medium=web&utm_campaign=tfjobsearch'),
        'https://www.techfetch.com/job-description/x-j999&aid=tfjstfviewjob',
    );
});
test('canonical: absolute http URL passes through (utm still stripped)', () => {
    assert.equal(
        canonicalTechFetchJobUrl('https://www.techfetch.com/job-description/y-j1&utm_source=a'),
        'https://www.techfetch.com/job-description/y-j1',
    );
});
test('canonical: null/empty → null', () => {
    assert.equal(canonicalTechFetchJobUrl(null), null);
    assert.equal(canonicalTechFetchJobUrl(''), null);
});
