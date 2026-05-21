import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession, getLinkedInSession, __resetLinkedInSessionForTest } from '../../src/scrapers/linkedin-session.js';

function fakeDeps() {
    const closed = { context: 0, pages: 0 }; let released = 0;
    const apiClient = { acquire: async () => ({ credential: { id: 12 }, release: async () => { released++; } }) };
    // launchPersistentProfile returns a BrowserContext directly; teardown
    // closes the context (no separate Browser handle).
    const launcher = async () => ({
        newPage: async () => ({ close: async () => { closed.pages++; } }),
        close: async () => { closed.context++; },
        browser: () => null,
    });
    return { apiClient, launcher, closed, released: () => released };
}

test('withPage opens a page, runs fn, closes the page even on throw', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    const out = await s.withPage('sess', async (page) => { assert.ok(page); return 'ok'; });
    assert.equal(out, 'ok');
    await assert.rejects(() => s.withPage('sess', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(d.closed.pages, 2);   // both pages closed
    assert.equal(d.closed.context, 0); // context stays open across roles
});

test('shutdown closes context + releases lease exactly once, idempotent', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await s.ensureReady('sess');
    await s.shutdown();
    await s.shutdown(); // idempotent
    assert.equal(d.closed.context, 1);
    assert.equal(d.released(), 1);
    assert.equal(s.isAlive(), false);
});

test('reestablish tears down then re-leases + re-launches', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await s.ensureReady('sess');
    await s.reestablish('sess');
    assert.equal(d.closed.context, 1); // old context closed
    assert.equal(s.isAlive(), true);   // new one up
});

test('getLinkedInSession is a singleton; reset clears it', () => {
    __resetLinkedInSessionForTest();
    const a = getLinkedInSession();
    const b = getLinkedInSession();
    assert.equal(a, b);
    __resetLinkedInSessionForTest();
    assert.notEqual(getLinkedInSession(), a);
});
