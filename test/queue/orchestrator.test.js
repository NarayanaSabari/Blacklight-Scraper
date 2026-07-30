import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueOrchestrator } from '../../src/queue/orchestrator.js';
import { TimeoutError } from '../../src/core/errors.js';

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
    executeWithMeta: async () => { throw new Error('boom'); },
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
        executeWithMeta: async () => (name === 'indeed'
            ? { jobs: [{ id: 1 }], emptyConfirmed: false }
            : (() => { throw new Error('boom'); })()),
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

test('B: a claim that times out recovers and RESUMES the orphaned active session', async () => {
    // Incident 2026-06-23: getNextRole timed out client-side AFTER the backend
    // committed the claim, orphaning the session. The orchestrator must detect
    // a TimeoutError, ask the backend for its active session, and resume it —
    // scraping its pending platforms and completing it.
    const m = fakeMetrics();
    let claimCalls = 0;
    let activeChecks = 0;
    const c = fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => {
            claimCalls += 1;
            if (claimCalls === 1) throw new TimeoutError('Request timed out after 30000ms');
            return { assignments: [] };
        },
        checkActiveSession: async () => {
            activeChecks += 1;
            return {
                has_active_session: true,
                session: {
                    session_id: 'sess-ORPHAN',
                    role_name: 'Backend Engineer',
                    search_queries: ['backend engineer'],
                    platforms: [{ id: 1, name: 'indeed' }],
                },
            };
        },
    });
    const resolver = () => ({
        executeWithMeta: async () => ({ jobs: [{ id: 1 }], emptyConfirmed: false }),
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        scraperResolver: resolver,
    });
    // .catch keeps the RED a clean assertion failure: pre-fix runOnce rejects
    // with the TimeoutError; post-fix it resolves after resuming.
    await o.runOnce().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(activeChecks >= 1, 'should ask the backend for its active session after a claim timeout');
    const sub = c.calls.submitJobs.find((s) => s.sid === 'sess-ORPHAN');
    assert.ok(sub, 'orphaned session should be resumed — submitJobs called for its pending platform');
    assert.equal(sub.p, 'indeed');
    assert.deepEqual(c.calls.completeSession, ['sess-ORPHAN'], 'resumed session must be completed');
});

test('O9: a platform returning 0 jobs still submits success but is recorded distinctly', async () => {
    const m = fakeMetrics();
    let served = false;
    const c = fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => {
            if (served) return { assignments: [] };
            served = true;
            return {
                assignments: [{
                    session_id: 'sess-ZERO',
                    role: { name: 'Backend Engineer', search_queries: null },
                    platforms: [{ name: 'indeed' }],
                }],
            };
        },
    });
    // 0 jobs, no throw. emptyConfirmed:false is the SUSPICIOUS case — a zero-job
    // success the scraper could NOT verify as a genuine empty (SCR-20 / #403).
    const emptyResolver = () => ({
        executeWithMeta: async () => ({ jobs: [], emptyConfirmed: false }),
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        scraperResolver: emptyResolver,
    });
    await o.runOnce();
    await new Promise((r) => setTimeout(r, 50));
    const sub = c.calls.submitJobs.find((s) => s.sid === 'sess-ZERO');
    assert.ok(sub, 'submitJobs should have been called for the zero-job platform');
    assert.equal(sub.n, 0);
    assert.equal(sub.status, 'success');
    assert.deepEqual(
        m.calls.jobsSubmitted.find((j) => j[0] === 'indeed'),
        ['indeed', 'success', 0],
    );
});

// SCR-10: prod 2026-06-14 burned ~185 zero-result sessions/min because the
// local-cooldown filter sat inside `if (Array.isArray(usablePlatforms))` —
// when the availability pre-flight threw, usablePlatforms became null, the
// guard was false, and cooled-down platforms were claimed anyway. These
// tests pin the fix: the cooldown filter must run even in the degraded
// (pre-flight-failed) path.

test('SCR-10: pre-flight throws + one platform on cooldown → that platform is excluded from the claim', async () => {
    const m = fakeMetrics();
    let requestedPlatforms;
    const c = fakeClient({
        checkCredentialAvailability: async () => { throw new Error('backend 503'); },
        getNextRole: async ({ platforms }) => {
            requestedPlatforms = platforms;
            return { assignments: [] };
        },
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        cooldownCheck: () => ['glassdoor'],
    });
    await o.runOnce();

    assert.ok(Array.isArray(requestedPlatforms), 'a degraded pre-flight must still resolve to an explicit platform list');
    assert.ok(!requestedPlatforms.includes('glassdoor'), 'the cooled-down platform must be excluded even when the pre-flight failed');
    assert.ok(requestedPlatforms.length > 0, 'other platforms should still be claimable');
    assert.ok(m.calls.queueCheck.includes('preflight_failed'), 'the degraded pre-flight must be countable on a metric');
});

test('SCR-10: pre-flight throws + ALL platforms cooled → no claim at all', async () => {
    const m = fakeMetrics();
    let getNextRoleCalled = false;
    const c = fakeClient({
        checkCredentialAvailability: async () => { throw new Error('backend 503'); },
        getNextRole: async () => { getNextRoleCalled = true; return { assignments: [] }; },
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        // Every platform the registry knows about is cooled down.
        cooldownCheck: () => ['dice', 'techfetch', 'linkedin', 'glassdoor', 'indeed', 'monster'],
    });
    const result = await o.runOnce();

    assert.equal(getNextRoleCalled, false, 'must not claim once every platform is on cooldown');
    assert.deepEqual(result, { message: 'Queue is empty for idle platforms' });
    assert.ok(m.calls.queueCheck.includes('preflight_failed'));
    assert.ok(m.calls.queueCheck.includes('all_cooldown'));
});

test('SCR-10: cooldown filter still applies on the happy path (pre-flight succeeds)', async () => {
    const m = fakeMetrics();
    let requestedPlatforms;
    const c = fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1, glassdoor: 1 }),
        getNextRole: async ({ platforms }) => {
            requestedPlatforms = platforms;
            return { assignments: [] };
        },
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        cooldownCheck: () => ['glassdoor'],
    });
    await o.runOnce();

    assert.deepEqual(requestedPlatforms, ['indeed']);
    assert.ok(!m.calls.queueCheck.includes('preflight_failed'), 'happy path should not record a preflight_failed check');
});
