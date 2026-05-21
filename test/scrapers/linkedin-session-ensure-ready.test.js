import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../src/scrapers/linkedin-session.js';

function fakeDeps() {
    let leases = 0, launches = 0;
    const apiClient = {
        acquire: async () => { leases++; return { credential: { id: 12, email: 'a@b.c', password: 'p' }, reportSuccess: async () => {}, reportFailure: async () => {}, release: async () => {} }; },
    };
    const launcher = async () => { launches++; return { browser: { close: async () => {} }, context: { newPage: async () => ({ close: async () => {} }) } }; };
    return { apiClient, launcher, counts: () => ({ leases, launches }) };
}

test('ensureReady leases + launches exactly once', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await s.ensureReady('sess-1');
    await s.ensureReady('sess-1');
    assert.deepEqual(d.counts(), { leases: 1, launches: 1 });
});

test('ensureReady is single-flight under concurrency (1 lease/launch for 10 callers)', async () => {
    const d = fakeDeps();
    const s = new LinkedInSession({ apiClient: d.apiClient, launcher: d.launcher });
    await Promise.all(Array.from({ length: 10 }, () => s.ensureReady('sess-1')));
    assert.deepEqual(d.counts(), { leases: 1, launches: 1 });
});

test('ensureReady throws if no credential available', async () => {
    const apiClient = { acquire: async () => null };
    const launcher = async () => { throw new Error('should not launch'); };
    const s = new LinkedInSession({ apiClient, launcher, leaseRetryDelayMs: 0, maxLeaseRetries: 2 });
    await assert.rejects(() => s.ensureReady('sess-1'), /No LinkedIn credential/);
});
