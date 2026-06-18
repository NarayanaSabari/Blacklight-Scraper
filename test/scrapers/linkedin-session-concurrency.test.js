import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession, linkedinMaxConcurrency } from '../../src/scrapers/linkedin-session.js';

const tick = () => new Promise((r) => setImmediate(r));

function makeFakeDeps() {
    const state = { live: 0, maxLive: 0, opened: 0 };
    const context = {
        newPage: async () => {
            state.opened++;
            state.live++;
            state.maxLive = Math.max(state.maxLive, state.live);
            return { close: async () => { state.live--; } };
        },
    };
    const apiClient = { acquire: async () => ({ credential: { id: 'test' }, release: async () => {} }) };
    const launcher = async () => context;
    return { state, apiClient, launcher };
}

test('linkedinMaxConcurrency: default 2, env override, invalid → default', () => {
    assert.equal(linkedinMaxConcurrency({}), 2);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '3' }), 3);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '1' }), 1);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '0' }), 2);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: 'abc' }), 2);
    assert.equal(linkedinMaxConcurrency({ LINKEDIN_MAX_CONCURRENCY: '' }), 2);
});

test('withPage never exceeds maxConcurrency under a burst, and all complete', async () => {
    const { state, apiClient, launcher } = makeFakeDeps();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 2, jitter: () => Promise.resolve(),
    });
    let done = 0;
    await Promise.all(Array.from({ length: 6 }, () =>
        session.withPage('sid', async () => { await tick(); await tick(); done++; })));
    assert.equal(state.maxLive, 2, `observed max ${state.maxLive}, expected 2`);
    assert.equal(state.opened, 6, 'all 6 borrowers opened a page');
    assert.equal(done, 6, 'all 6 completed');
    assert.equal(state.live, 0, 'every page closed');
});

test('withPage releases the slot even when fn throws', async () => {
    const { state, apiClient, launcher } = makeFakeDeps();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 1, jitter: () => Promise.resolve(),
    });
    await assert.rejects(session.withPage('sid', async () => { throw new Error('boom'); }));
    let ok = false;
    await session.withPage('sid', async () => { ok = true; });
    assert.equal(ok, true);
    assert.equal(state.live, 0);
});

test('maxConcurrency: 1 serializes (max live never exceeds 1)', async () => {
    const { state, apiClient, launcher } = makeFakeDeps();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 1, jitter: () => Promise.resolve(),
    });
    await Promise.all(Array.from({ length: 4 }, () =>
        session.withPage('sid', async () => { await tick(); })));
    assert.equal(state.maxLive, 1);
});

test('withPage passes the established lease to the callback (stable per-borrower ref)', async () => {
    const { apiClient, launcher } = makeFakeDeps();
    const session = new LinkedInSession({
        apiClient, launcher, maxConcurrency: 2, jitter: () => Promise.resolve(),
    });
    let seen;
    await session.withPage('sid', async (page, lease) => { seen = lease; });
    assert.ok(seen, 'lease handed to the callback');
    assert.equal(seen.credential.id, 'test');
});

test('reestablish keeps the shared context while sibling borrowers are active', async () => {
    let closed = 0;
    const context = { newPage: async () => ({ close: async () => {} }), close: async () => { closed++; } };
    const apiClient = { acquire: async () => ({ credential: { id: 'x' }, release: async () => {} }) };
    const session = new LinkedInSession({ apiClient, launcher: async () => context, maxConcurrency: 2, jitter: () => Promise.resolve() });
    await session.ensureReady('sid');
    session._sem._inUse = 1;                  // simulate an active sibling borrower
    await session.reestablish('sid');
    assert.equal(closed, 0, 'shared context NOT torn down while a borrower is active');
    assert.ok(session.isAlive(), 'context still alive');
});

test('withPage recovers when newPage throws (closed context) — re-establishes + retries once', async () => {
    let launches = 0;
    const launcher = async () => {
        launches++;
        const n = launches;
        return {
            newPage: async () => {
                if (n === 1) throw new Error('Target page, context or browser has been closed');
                return { close: async () => {} };
            },
            close: async () => {},
        };
    };
    const apiClient = { acquire: async () => ({ credential: { id: 'x' }, release: async () => {} }) };
    const session = new LinkedInSession({ apiClient, launcher, maxConcurrency: 1, jitter: () => Promise.resolve() });
    let ran = false;
    await session.withPage('sid', async () => { ran = true; });
    assert.equal(ran, true, 'callback ran after the retry');
    assert.ok(launches >= 2, 're-established a fresh context after the closed-context error');
});
