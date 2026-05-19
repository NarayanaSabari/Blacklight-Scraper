import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCookieRefresh } from '../../src/api/credentials.js';

const LI = [{ name: 'li_at', value: 'tok', domain: '.www.linkedin.com' },
            { name: 'lidc', value: 'x', domain: '.linkedin.com' }];

test('local lease → skip (skipped_local), no body', () => {
    const p = planCookieRefresh({ isLocal: true, sessionId: 's', cookies: LI });
    assert.equal(p.action, 'skip');
    assert.equal(p.outcome, 'skipped_local');
});

test('missing/empty/li_at-less jar → skip (skipped_no_li_at)', () => {
    for (const c of [null, undefined, [], [{ name: 'lidc', value: 'x' }],
                     [{ name: 'li_at', value: '' }], [{ name: 'li_at' }]]) {
        const p = planCookieRefresh({ isLocal: false, sessionId: 's', cookies: c });
        assert.equal(p.action, 'skip', JSON.stringify(c));
        assert.equal(p.outcome, 'skipped_no_li_at');
    }
});

test('valid jar → post with body { session_id, cookies }', () => {
    const p = planCookieRefresh({ isLocal: false, sessionId: 'sess-9', cookies: LI });
    assert.equal(p.action, 'post');
    assert.equal(p.outcome, 'refreshed');
    assert.deepEqual(p.body, { session_id: 'sess-9', cookies: LI });
});

test('null sessionId still posts with session_id:null', () => {
    const p = planCookieRefresh({ isLocal: false, sessionId: null, cookies: LI });
    assert.equal(p.action, 'post');
    assert.equal(p.body.session_id, null);
});

test('jar over 64 KB → skip (skipped_too_large)', () => {
    const big = [{ name: 'li_at', value: 'v', domain: '.www.linkedin.com' },
                 { name: 'pad', value: 'A'.repeat(70 * 1024), domain: '.linkedin.com' }];
    const p = planCookieRefresh({ isLocal: false, sessionId: 's', cookies: big });
    assert.equal(p.action, 'skip');
    assert.equal(p.outcome, 'skipped_too_large');
});
