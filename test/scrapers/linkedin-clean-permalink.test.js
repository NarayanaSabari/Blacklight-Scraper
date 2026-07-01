import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPostPermalink } from '../../scrapers/linkedin.js';

// Real clipboard output from LinkedIn's "Copy link to post" (Jul 2026).
const REAL = 'https://www.linkedin.com/posts/sheetal-verma-889241395_rivomind-sales-internship-program-2026-ugcPost-7478104615113216001-dYGw/?utm_source=share&utm_medium=member_desktop&rcm=ACoAAG';

test('cleanPostPermalink: keeps a /posts/ permalink, strips tracking params', () => {
    assert.equal(
        cleanPostPermalink(REAL),
        'https://www.linkedin.com/posts/sheetal-verma-889241395_rivomind-sales-internship-program-2026-ugcPost-7478104615113216001-dYGw/',
    );
});

test('cleanPostPermalink: keeps a /feed/update/ permalink, strips params + fragment', () => {
    assert.equal(
        cleanPostPermalink('https://www.linkedin.com/feed/update/urn:li:activity:999/?utm_source=x#comments'),
        'https://www.linkedin.com/feed/update/urn:li:activity:999/',
    );
});

test('cleanPostPermalink: rejects profile / search / empty / nullish (never wrong)', () => {
    assert.equal(cleanPostPermalink('https://www.linkedin.com/in/sheetal-verma-889241395/'), '');
    assert.equal(cleanPostPermalink('https://www.linkedin.com/search/results/content/?q=x'), '');
    assert.equal(cleanPostPermalink(''), '');
    assert.equal(cleanPostPermalink(null), '');
    assert.equal(cleanPostPermalink(undefined), '');
    assert.equal(cleanPostPermalink('CLIP_ERR: NotAllowedError'), '');
});
