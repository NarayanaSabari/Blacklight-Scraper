import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractActivityId, activityPermalink, postSourceUrl } from '../../scrapers/linkedin.js';

test('extractActivityId: pulls digits from a urn:li:activity blob', () => {
    assert.equal(extractActivityId('urn:li:activity:7334567890123456789'), '7334567890123456789');
    assert.equal(extractActivityId('https://www.linkedin.com/feed/update/urn:li:activity:123/'), '123');
    assert.equal(extractActivityId('<div data-urn="urn:li:activity:456">x</div>'), '456');
});

test('extractActivityId: returns first match', () => {
    assert.equal(extractActivityId('urn:li:activity:111 ... urn:li:activity:222'), '111');
});

test('extractActivityId: empty for no match / nullish / non-string', () => {
    assert.equal(extractActivityId('no urn here'), '');
    assert.equal(extractActivityId(''), '');
    assert.equal(extractActivityId(null), '');
    assert.equal(extractActivityId(undefined), '');
    assert.equal(extractActivityId({}), '');
});

test('activityPermalink: builds canonical permalink for a numeric id', () => {
    assert.equal(activityPermalink('12345'),
        'https://www.linkedin.com/feed/update/urn:li:activity:12345/');
});

test('activityPermalink: empty for non-numeric / blank / nullish', () => {
    assert.equal(activityPermalink(''), '');
    assert.equal(activityPermalink('abc'), '');
    assert.equal(activityPermalink('123abc'), '');
    assert.equal(activityPermalink(null), '');
    assert.equal(activityPermalink(undefined), '');
});

test('postSourceUrl: passes a real post permalink through', () => {
    const u = 'https://www.linkedin.com/feed/update/urn:li:activity:123/';
    assert.equal(postSourceUrl(u), u);
    assert.equal(postSourceUrl('https://www.linkedin.com/posts/jane-doe-activity-999-abcd'),
        'https://www.linkedin.com/posts/jane-doe-activity-999-abcd');
});

test('postSourceUrl: NEVER returns an /in/ author profile link', () => {
    assert.equal(postSourceUrl('https://www.linkedin.com/in/arunyerkuntwar/'), '');
    assert.equal(postSourceUrl('https://www.linkedin.com/in/sharath-a-35b488193/'), '');
});

test('postSourceUrl: empty for blank / nullish; trims whitespace', () => {
    assert.equal(postSourceUrl(''), '');
    assert.equal(postSourceUrl('   '), '');
    assert.equal(postSourceUrl(null), '');
    assert.equal(postSourceUrl(undefined), '');
    assert.equal(postSourceUrl('  https://www.linkedin.com/feed/update/urn:li:activity:7/  '),
        'https://www.linkedin.com/feed/update/urn:li:activity:7/');
});

test('map composition: profile postUrl + activityUrn → permalink, never /in/', () => {
    // Mirrors scrapeLinkedIn's url expression.
    const url = (post) => postSourceUrl(post.postUrl)
        || activityPermalink(extractActivityId(post.activityUrn || post.postUrl));
    // Bug repro: extractor only got the /in/ link, but an activity URN exists.
    assert.equal(url({ postUrl: 'https://www.linkedin.com/in/arun/', activityUrn: 'urn:li:activity:42' }),
        'https://www.linkedin.com/feed/update/urn:li:activity:42/');
    // Happy path: real permalink already extracted.
    assert.equal(url({ postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:9/', activityUrn: '' }),
        'https://www.linkedin.com/feed/update/urn:li:activity:9/');
    // Nothing usable → empty, never the /in/ profile.
    assert.equal(url({ postUrl: 'https://www.linkedin.com/in/arun/', activityUrn: '' }), '');
});
