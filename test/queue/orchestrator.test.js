import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueOrchestrator } from '../../src/queue/orchestrator.js';

function fakeMetrics() {
    const calls = { allFailed: 0, queueCheck: [], jobsSubmitted: [] };
    return {
        calls,
        recordSessionAllFailed: () => { calls.allFailed += 1; },
        recordQueueCheck: (r) => calls.queueCheck.push(r),
        recordJobsSubmitted: (p, s, n) => calls.jobsSubmitted.push([p, s, n]),
    };
}

function fakeClient(overrides = {}) {
    const calls = { submitJobs: [], completeSession: [] };
    return {
        calls,
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => ({ assignments: [] }),
        submitJobs: async (sid, p, jobs, status) => { calls.submitJobs.push({ sid, p, n: jobs.length, status }); return { progress: '1/1' }; },
        completeSession: async (sid) => { calls.completeSession.push(sid); return { duration_seconds: 1, jobs: {} }; },
        ...overrides,
    };
}

test('constructor accepts injected client + metrics (no blacklightConfig needed)', () => {
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: fakeClient(),
        metrics: fakeMetrics(),
    });
    assert.equal(typeof o.runOnce, 'function');
});

test('runOnce uses the injected metrics (recordQueueCheck) not the global registry', async () => {
    const m = fakeMetrics();
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: fakeClient({ getNextRole: async () => ({ assignments: [] }) }),
        metrics: m,
    });
    await o.runOnce();
    assert.ok(m.calls.queueCheck.length >= 1, 'injected metrics.recordQueueCheck was not used');
});

test('legacy constructor still requires blacklightConfig when no client injected', () => {
    assert.throws(
        () => new QueueOrchestrator({ queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 } }),
        /requires blacklightConfig/,
    );
});

function assignmentClient(extra = {}) {
    let served = false;
    return fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1, dice: 1 }),
        getNextRole: async () => {
            if (served) return { assignments: [] };
            served = true;
            return {
                assignments: [{
                    session_id: 'sess-AF',
                    role: { name: 'Backend Engineer', search_queries: null },
                    platforms: [{ name: 'indeed' }, { name: 'dice' }],
                }],
            };
        },
        ...extra,
    });
}

const allThrowResolver = () => ({
    execute: async () => { throw new Error('boom'); },
});

test('C3: when every platform fails, recordSessionAllFailed fires and completeSession is still called', async () => {
    const m = fakeMetrics();
    const c = assignmentClient();
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        scraperResolver: allThrowResolver,
    });
    await o.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.calls.allFailed, 1, 'recordSessionAllFailed should fire exactly once for an all-failed assignment');
    assert.deepEqual(c.calls.completeSession, ['sess-AF'], 'completeSession must still be called (backend coordination)');
});

test('C3: when at least one platform succeeds, recordSessionAllFailed does NOT fire', async () => {
    const m = fakeMetrics();
    const c = assignmentClient();
    const mixedResolver = (name) => ({
        execute: async () => (name === 'indeed' ? [{ id: 1 }] : (() => { throw new Error('boom'); })()),
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        scraperResolver: mixedResolver,
    });
    await o.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.calls.allFailed, 0, 'recordSessionAllFailed must not fire when a platform succeeded');
    assert.deepEqual(c.calls.completeSession, ['sess-AF']);
});
