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

test('platformOverrides: a locally-paused platform is excluded from the claim, same as a cooldown', async () => {
    let requestedPlatforms;
    const c = fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1, glassdoor: 1 }),
        getNextRole: async ({ platforms }) => { requestedPlatforms = platforms; return { assignments: [] }; },
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: fakeMetrics(),
        platformOverrides: { pausedList: () => ['glassdoor'] },
    });
    await o.runOnce();
    assert.deepEqual(requestedPlatforms, ['indeed']);
});

test('snapshot: reports poll state — not running before startAutoChecker, mutex reflects an in-flight claim', async () => {
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1000, startupDelayMs: 1 },
        client: fakeClient(),
        metrics: fakeMetrics(),
    });
    assert.equal(o.snapshot().running, false);
    assert.equal(o.snapshot().mutexLocked, false);
    await o.runOnce();
    assert.equal(o.snapshot().lastPollOutcome, 'empty');
    assert.equal(typeof o.snapshot().lastPollAt, 'string');
});

test('snapshot: an assignment in flight shows up as an active session, then clears on completion', async () => {
    let releaseScraper;
    const gate = new Promise((resolve) => { releaseScraper = resolve; });
    let claimed = false;
    const c = fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => {
            if (claimed) return { assignments: [] }; // only claim once — avoid an infinite re-poll loop
            claimed = true;
            return {
                assignments: [{
                    session_id: 'sess-SNAP',
                    role: { name: 'Backend Engineer', search_queries: null },
                    platforms: [{ id: 1, name: 'indeed' }],
                }],
            };
        },
    });
    const resolver = () => ({
        executeWithMeta: async () => { await gate; return { jobs: [], emptyConfirmed: true }; },
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: fakeMetrics(),
        scraperResolver: resolver,
    });
    await o.runOnce();
    await new Promise((r) => setImmediate(r)); // let #runAssignment register the session

    const mid = o.snapshot();
    assert.equal(mid.activeSessions.length, 1);
    assert.equal(mid.activeSessions[0].sessionId, 'sess-SNAP');
    assert.equal(mid.activeSessions[0].platforms.indeed, 'pending');

    releaseScraper();
    await new Promise((r) => setTimeout(r, 20)); // let the assignment finish + clean up

    assert.deepEqual(o.snapshot().activeSessions, []);
});

// ─── cadence gate wired into the real orchestrator (2026-08-03) ─────────
// sweep-schedule.test.js covers the gate in isolation. These drive the ACTUAL
// orchestrator, because the unit tests passed while the integration was
// broken: a missing `import { SweepSchedule }` only fails at runtime, and it
// shipped — the panel 500'd with "SweepSchedule is not defined".

test('buildStatus path: sweepSnapshot() constructs without a missing import', () => {
    const orchestrator = new QueueOrchestrator({
        client: {}, queueConfig: {}, defaultLocation: 'United States',
        platformOverrides: { intervalMinutes: () => 60, pausedList: () => [] },
    });
    // Would throw ReferenceError if SweepSchedule were not imported.
    const snap = orchestrator.sweepSnapshot();
    assert.equal(typeof snap, 'object');
});

test('sweepSnapshot reflects a platform that has begun a sweep', () => {
    const orchestrator = new QueueOrchestrator({
        client: {}, queueConfig: {}, defaultLocation: 'United States',
        platformOverrides: { intervalMinutes: (p) => (p === 'indeed' ? 60 : null), pausedList: () => [] },
    });
    const snap = orchestrator.sweepSnapshot();
    assert.deepEqual(snap, {}, 'nothing swept yet');
});

test('sweep counters are attributed to the platform NAME, not "[object object]"', async () => {
    // The claim response returns platforms as {id, name, display_name} objects
    // while the gate works in strings. Recording the object stringified it to
    // one junk key, so every sweep summary read roles: 0 / sessions: 0 — which
    // is precisely the number the cadence change was supposed to be judged on.
    // Observed live on m1 2026-08-03: the panel listed an "[object object]"
    // platform alongside the real six.
    const m = fakeMetrics();
    let claimed = false;
    const c = fakeClient({
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => {
            if (claimed) return { assignments: [] };   // claim once — else re-polls forever
            claimed = true;
            return {
                assignments: [{
                    session_id: 'sess-1',
                    role: { name: 'Backend Engineer', search_queries: ['backend engineer'] },
                    platforms: [{ id: 1, name: 'indeed', display_name: 'Indeed' }],
                }],
            };
        },
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: c,
        metrics: m,
        platformOverrides: { intervalMinutes: (p) => (p === 'indeed' ? 60 : null), pausedList: () => [] },
        scraperResolver: () => ({
            executeWithMeta: async () => ({ jobs: [], emptyConfirmed: true }),
        }),
    });

    await o.runOnce().catch(() => {});

    const snap = o.sweepSnapshot();
    assert.ok(!('[object object]' in snap), `junk platform key present: ${Object.keys(snap)}`);
    assert.ok('indeed' in snap, `expected indeed, got ${Object.keys(snap)}`);
});

// --- candidate boolean queries ----------------------------------------------

test('runAssignment forwards a candidate query to the scraper', async () => {
    // The backend has already flagged this session to bypass the role-relevance
    // filter, so if the query fails to reach the scraper the session imports an
    // UNFILTERED role sweep — worse than importing nothing.
    const seen = [];
    let served = false;
    const client = fakeClient({
        checkCredentialAvailability: async () => ({ linkedin: 1 }),
        getNextRole: async () => {
            if (served) return { assignments: [] };
            served = true;
            return {
                assignments: [{
                    session_id: 'sess-CQ',
                    role: { name: 'Senior Java Developer', search_queries: ['role variant'] },
                    candidate_query: {
                        id: 12,
                        query: '("Java" OR "Kotlin") AND ("AWS" OR "Azure") NOT junior',
                        candidate_id: 34,
                    },
                    platforms: [{ name: 'linkedin' }],
                }],
            };
        },
    });
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client,
        metrics: fakeMetrics(),
        // LinkedIn carries a real cooldown in the default check; stub it so this
        // test measures assignment plumbing rather than cooldown state.
        cooldownCheck: () => [],
        scraperResolver: () => ({
            executeWithMeta: async (_role, _loc, _sid, options) => {
                seen.push(options);
                return { jobs: [], emptyConfirmed: true };
            },
        }),
    });

    await o.runOnce();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].candidateQuery, '("Java" OR "Kotlin") AND ("AWS" OR "Azure") NOT junior');
    // The role's own variants still ride along untouched — the scraper decides
    // precedence, the orchestrator does not silently drop one path.
    assert.deepEqual(seen[0].searchQueries, ['role variant']);
});

test('runAssignment passes candidateQuery: null for an ordinary role sweep', async () => {
    const seen = [];
    const o = new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 1, startupDelayMs: 1 },
        client: assignmentClient(),
        metrics: fakeMetrics(),
        scraperResolver: () => ({
            executeWithMeta: async (_role, _loc, _sid, options) => {
                seen.push(options);
                return { jobs: [], emptyConfirmed: true };
            },
        }),
    });

    await o.runOnce();

    assert.ok(seen.length >= 1);
    assert.equal(seen[0].candidateQuery, null);
});
