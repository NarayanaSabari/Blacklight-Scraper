import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityIdFromMenuHref } from '../../scrapers/linkedin.js';

// A real "Report post" href from the "···" control menu (URL-encoded).
const REAL = 'https://www.linkedin.com/preload/report-in-modal/?entityUrn=urn%3Ali%3Ashare%3A7462490742549012480&contentSource=UGC_POST&authorUrn=urn%3Ali%3Amember%3A713024955&feedType=FeedType_FLAGSHIP_SEARCH&updateUrn=urn%3Ali%3Aactivity%3A7462490743035731968&trackingId=abc%3D%3D';

test('activityIdFromMenuHref: extracts the updateUrn activity id (encoded)', () => {
    assert.equal(activityIdFromMenuHref(REAL), '7462490743035731968');
});

test('activityIdFromMenuHref: works on an already-decoded href', () => {
    assert.equal(
        activityIdFromMenuHref('https://x/?updateUrn=urn:li:activity:999&foo=bar'),
        '999',
    );
});

test('activityIdFromMenuHref: ignores entityUrn (share) — only updateUrn (activity)', () => {
    // entityUrn share id (…012480) must NOT be returned; updateUrn activity is.
    assert.equal(activityIdFromMenuHref(REAL), '7462490743035731968');
    assert.notEqual(activityIdFromMenuHref(REAL), '7462490742549012480');
});

test('activityIdFromMenuHref: empty for hrefs without updateUrn / nullish', () => {
    assert.equal(activityIdFromMenuHref('https://x/?entityUrn=urn%3Ali%3Ashare%3A123'), '');
    assert.equal(activityIdFromMenuHref('https://x/?foo=bar'), '');
    assert.equal(activityIdFromMenuHref(''), '');
    assert.equal(activityIdFromMenuHref(null), '');
    assert.equal(activityIdFromMenuHref(undefined), '');
});
