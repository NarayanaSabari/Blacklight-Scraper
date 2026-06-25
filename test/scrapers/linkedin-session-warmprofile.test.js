import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../src/scrapers/linkedin-session.js';

function warmDeps({ authed }) {
    const calls = { launchedWith: null, addCookies: 0 };
    const context = {
        addCookies: async () => { calls.addCookies++; },
        cookies: async () => (authed ? [{ name: 'li_at', value: 'x' }] : []),
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
    };
    const launcher = async (o) => { calls.launchedWith = o; return context; };
    const apiClient = { isLocal: false, acquire: async () => ({
        credential: { id: 'c1', profile_key: 'li-acct-1', proxy: 'host:1:u:p', cookies: null },
        release: async () => {} }) };
    return { calls, launcher, apiClient, isAuthed: (c) => c.some((x) => x.name === 'li_at') };
}

test('per-account establish reuses the warm profile and NEVER injects cookies', async () => {
    const d = warmDeps({ authed: true });
    const s = new LinkedInSession({
        apiClient: d.apiClient, launcher: d.launcher, maxConcurrency: 1,
        jitter: () => Promise.resolve(), readCookies: (c) => c.cookies(), isAuthed: d.isAuthed,
    });
    await s.ensureReady('sid');
    assert.deepEqual(d.calls.launchedWith, { profileKey: 'li-acct-1', proxy: 'host:1:u:p' });
    assert.equal(d.calls.addCookies, 0, 'no cookie injection in the warm-profile model');
    assert.ok(s.isAlive());
});
