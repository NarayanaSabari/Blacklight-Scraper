// The guarded one-shot query24 workflow harness: exactly one backend claim,
// only the candidate-24 LinkedIn assignment executed/submitted/completed,
// unexpected claims left outstanding, no group path, the other five platforms
// excluded, no timers, and the daemon's persisted pauses untouched. Everything
// runs through the REAL QueueOrchestrator with injected fakes - no live network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    runQuery24Workflow,
    pickTargetAssignment,
    pausedExceptLinkedIn,
    assignmentHasPlatform,
    assignmentIsLinkedInOnly,
    buildGatedClient,
    isMainEntrypoint,
    withUnderlyingLogsSuppressed,
    TARGET_CANDIDATE_ID,
    OTHER_PLATFORMS,
} from '../../scripts/linkedin-query24-workflow.js';

const REMOTE_CONFIG = {
    blacklight: { apiUrl: 'https://backend.test', apiKey: 'k' },
    queue: { checkIntervalMs: 30000, startupDelayMs: 5000, defaultLocation: 'United States' },
};

const CANDIDATE_QUERY = '("Senior .NET Developer" OR ".NET Developer") AND (".NET Core" OR ASP.NET)';

function linkedinAssignment(sessionId, candidateId, query = CANDIDATE_QUERY) {
    return {
        session_id: sessionId,
        role: { name: '.NET Developer', search_queries: null },
        candidate_query: { id: candidateId, query },
        platforms: [{ id: 1, name: 'linkedin', display_name: 'LinkedIn' }],
    };
}

// A backend client fake: one claim response, then empty. Records every call so
// the test can assert exactly-once semantics and fail-closed handling.
function fakeRealClient({ assignments = [], availability = { linkedin: 1 } } = {}) {
    const calls = { getNextRole: 0, submitJobs: [], completeSession: [], availability: 0 };
    return {
        calls,
        checkCredentialAvailability: async () => { calls.availability += 1; return availability; },
        getNextRole: async () => { calls.getNextRole += 1; return { assignments }; },
        submitJobs: async (sessionId, platform, jobs, status, errMsg, meta) => {
            calls.submitJobs.push({ sessionId, platform, count: jobs.length, status, meta });
            return { progress: { imported: jobs.length } };
        },
        completeSession: async (sessionId) => {
            calls.completeSession.push(sessionId);
            return { duration_seconds: 1, jobs: { total_imported: 0, total_found: 0 } };
        },
        // Deliberately present here so a test can prove the harness HIDES it.
        claimLinkedInGroup: async () => { throw new Error('group claim must never be called'); },
    };
}

// A scraper fake standing in for the real LinkedIn RSC scraper's contract.
function fakeScraper(onExecute) {
    return {
        executeWithMeta: async (role, location, sessionId, options) => {
            return onExecute({ role, location, sessionId, options });
        },
    };
}

function runDeps({ realClient, onExecute, cooldown = [], targetId = TARGET_CANDIDATE_ID } = {}) {
    const logs = [];
    const executes = [];
    const scraper = fakeScraper((args) => {
        executes.push(args);
        return (onExecute ?? (() => ({ jobs: [{ title: 'x' }], emptyConfirmed: false })))(args);
    });
    return {
        logs,
        executes,
        deps: {
            getConfigImpl: () => REMOTE_CONFIG,
            initCredentials: () => ({ isLocal: false }),
            makeClient: () => realClient,
            scraperResolver: () => scraper,
            cooldownCheck: () => cooldown,
            metrics: { // silent metrics stub - every method a no-op
                recordQueueCheck() {}, recordJobsSubmitted() {}, recordSessionAllFailed() {},
                recordUrlQuality() {}, recordScrapeDuration() {}, recordScrapeResult() {},
            },
            targetId,
            timeoutMs: 5000,
            log: (r) => logs.push(r),
        },
    };
}

// --- pure helpers -----------------------------------------------------------

test('pickTargetAssignment: selects the linkedin candidate-24 row, others separated', () => {
    const target = linkedinAssignment('s-24', 24);
    const other = { session_id: 's-9', candidate_query: { id: 9 }, platforms: [{ name: 'linkedin' }] };
    const role = { session_id: 's-role', platforms: [{ name: 'linkedin' }] }; // no candidate_query
    const { target: got, others } = pickTargetAssignment([other, target, role], 24);
    assert.equal(got.session_id, 's-24');
    assert.equal(others.length, 2);
    assert.ok(!others.includes(target));
});

test('pickTargetAssignment: no target when candidate id does not match', () => {
    const { target, others } = pickTargetAssignment([linkedinAssignment('s', 99)], 24);
    assert.equal(target, null);
    assert.equal(others.length, 1);
});

test('pickTargetAssignment: rejects a candidate-24 row with mixed platforms', () => {
    const mixed = {
        ...linkedinAssignment('s-mixed', 24),
        platforms: [{ name: 'linkedin' }, { name: 'dice' }],
    };
    const { target, others } = pickTargetAssignment([mixed], 24);
    assert.equal(target, null);
    assert.deepEqual(others, [mixed]);
    assert.equal(assignmentIsLinkedInOnly(mixed), false);
    assert.equal(assignmentIsLinkedInOnly(linkedinAssignment('s-only', 24)), true);
});

test('pausedExceptLinkedIn: pauses exactly the other five, linkedin claimable', () => {
    const o = pausedExceptLinkedIn();
    assert.deepEqual(o.pausedList(), [...OTHER_PLATFORMS].sort());
    assert.ok(!o.pausedList().includes('linkedin'));
    assert.equal(o.intervalMinutes('linkedin'), null);
});

test('assignmentHasPlatform: matches by name across string/object forms', () => {
    assert.equal(assignmentHasPlatform({ platforms: ['linkedin'] }, 'linkedin'), true);
    assert.equal(assignmentHasPlatform({ platforms: [{ name: 'LinkedIn' }] }, 'linkedin'), true);
    assert.equal(assignmentHasPlatform({ platforms: [{ name: 'dice' }] }, 'linkedin'), false);
});

// --- full workflow through the real orchestrator ----------------------------

test('runs candidate-24 end to end: claim -> candidateScoped scrape -> submit -> complete', async () => {
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps, executes, logs } = runDeps({ realClient });
    const summary = await runQuery24Workflow(deps);

    // Exactly one real claim.
    assert.equal(realClient.calls.getNextRole, 1);
    // The scraper ran once, candidate-scoped, for the LinkedIn role.
    assert.equal(executes.length, 1);
    assert.equal(executes[0].options.candidateQuery, CANDIDATE_QUERY);
    assert.equal(executes[0].sessionId, 'sess-24');
    // Submitted for the target session, then completed it.
    assert.equal(realClient.calls.submitJobs.length, 1);
    assert.equal(realClient.calls.submitJobs[0].sessionId, 'sess-24');
    assert.equal(realClient.calls.submitJobs[0].platform, 'linkedin');
    assert.deepEqual(realClient.calls.completeSession, ['sess-24']);
    assert.equal(summary.outcome, 'completed');
    // Terminal completion stage was recorded.
    assert.ok(logs.some((l) => l.stage === 'complete' && l.sessionId === 'sess-24'));
});

test('forwards empty_confirmed on a zero-job candidate result', async () => {
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps } = runDeps({
        realClient,
        onExecute: () => ({ jobs: [], emptyConfirmed: true }),
    });
    await runQuery24Workflow(deps);
    const submit = realClient.calls.submitJobs[0];
    assert.equal(submit.count, 0);
    assert.equal(submit.meta.emptyConfirmed, true);
});

test('completion API failure is propagated and reported as completion_failed', async () => {
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    realClient.completeSession = async (sessionId) => {
        realClient.calls.completeSession.push(sessionId);
        throw new Error('backend completion failed');
    };
    const { deps, logs } = runDeps({ realClient });
    const summary = await runQuery24Workflow(deps);

    assert.deepEqual(realClient.calls.completeSession, ['sess-24']);
    assert.equal(summary.outcome, 'completion_failed');
    assert.ok(logs.some((l) => l.stage === 'completion_failed'
        && l.outcome === 'completion_failed'
        && l.sessionId === 'sess-24'));
});

test('preclaim mutex skip returns explicitly when no workflow is active', async () => {
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps, logs } = runDeps({ realClient });
    const { QueueOrchestrator } = await import('../../src/queue/orchestrator.js');
    let orchestrator;
    const depsWithBusyClaim = {
        ...deps,
        makeOrchestrator: (opts) => {
            orchestrator = new QueueOrchestrator(opts);
            assert.equal(orchestrator.mutex.tryAcquire(), true);
            return orchestrator;
        },
        timeoutMs: 50,
    };

    let summary;
    try {
        summary = await runQuery24Workflow(depsWithBusyClaim);
    } finally {
        orchestrator?.mutex.release();
    }

    assert.equal(realClient.calls.getNextRole, 0);
    assert.equal(summary.outcome, 'skipped');
    assert.ok(logs.some((l) => l.stage === 'run_once' && l.outcome === 'skipped'));
});

test('no credential availability returns explicitly skipped without a claim', async () => {
    const realClient = fakeRealClient({
        assignments: [linkedinAssignment('sess-24', 24)],
        availability: { linkedin: 0 },
    });
    const { deps, executes, logs } = runDeps({ realClient });
    const summary = await runQuery24Workflow({ ...deps, timeoutMs: 50 });

    assert.equal(realClient.calls.getNextRole, 0);
    assert.equal(executes.length, 0);
    assert.equal(summary.outcome, 'skipped');
    assert.ok(logs.some((l) => l.stage === 'run_once' && l.outcome === 'skipped'));
});

test('all LinkedIn cooldown returns explicitly skipped without a claim', async () => {
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps, executes, logs } = runDeps({ realClient, cooldown: ['linkedin'] });
    const summary = await runQuery24Workflow({ ...deps, timeoutMs: 50 });

    assert.equal(realClient.calls.getNextRole, 0);
    assert.equal(executes.length, 0);
    assert.equal(summary.outcome, 'skipped');
    assert.ok(logs.some((l) => l.stage === 'run_once' && l.outcome === 'skipped'));
});

test('claims AT MOST ONE assignment: a follow-up poll does not hit the backend', async () => {
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps } = runDeps({ realClient });
    await runQuery24Workflow(deps);
    // Give any coalesced post-settle poll a tick to fire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(realClient.calls.getNextRole, 1, 'the gate must latch after one claim');
});

test('the other five platforms are never claimed (paused via in-memory overrides)', async () => {
    // The orchestrator's claim path subtracts pausedList() from availability.
    // With everything but linkedin paused, only linkedin can be requested.
    const realClient = fakeRealClient({
        assignments: [linkedinAssignment('sess-24', 24)],
        availability: { linkedin: 1, dice: 5, indeed: 5, glassdoor: 999, monster: 2, techfetch: 3 },
    });
    let requestedPlatforms = null;
    realClient.getNextRole = async () => {
        realClient.calls.getNextRole += 1;
        return { assignments: [linkedinAssignment('sess-24', 24)] };
    };
    // Wrap to capture what the orchestrator asked for.
    const orig = realClient.getNextRole;
    realClient.getNextRole = async (opts) => { requestedPlatforms = opts?.platforms ?? null; return orig(opts); };
    const { deps } = runDeps({ realClient });
    await runQuery24Workflow(deps);
    assert.ok(Array.isArray(requestedPlatforms));
    assert.deepEqual(requestedPlatforms, ['linkedin'], 'only linkedin may be claimed');
});

test('the group path is disabled: claimLinkedInGroup is never invoked', async () => {
    // fakeRealClient.claimLinkedInGroup throws if called; the gated client hides
    // it so the orchestrator's `typeof client.claimLinkedInGroup === "function"`
    // gate is false and the group path is skipped entirely.
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps } = runDeps({ realClient });
    const summary = await runQuery24Workflow(deps);
    assert.equal(summary.outcome, 'completed'); // no throw from a group claim
});

test('an unexpected non-target claim fails closed, never scraped, submitted, or completed', async () => {
    // The backend hands back a different candidate. The harness must stop and
    // leave its backend-created session outstanding for coordinator recovery.
    const wrong = linkedinAssignment('sess-99', 99);
    const realClient = fakeRealClient({ assignments: [wrong] });
    const { deps, executes, logs } = runDeps({ realClient });
    const summary = await runQuery24Workflow(deps);
    assert.equal(executes.length, 0, 'a non-target must never be scraped');
    assert.equal(realClient.calls.submitJobs.length, 0, 'a non-target must never be submitted');
    assert.deepEqual(realClient.calls.completeSession, [], 'the harness must not complete an unexpected claim');
    assert.equal(summary.outcome, 'unexpected_assignment');
    assert.deepEqual(summary.outstandingSessionIds, ['sess-99']);
    assert.ok(logs.some((l) => l.outcome === 'unexpected_assignment'
        && l.outstandingSessionIds?.includes('sess-99')));
});

test('a valid target beside an unexpected claim still fails closed without side effects', async () => {
    const target = linkedinAssignment('sess-24', 24);
    const wrong = linkedinAssignment('sess-99', 99);
    const realClient = fakeRealClient({ assignments: [target, wrong] });
    const { deps, executes } = runDeps({ realClient });
    const summary = await runQuery24Workflow(deps);

    assert.equal(executes.length, 0);
    assert.equal(realClient.calls.submitJobs.length, 0);
    assert.deepEqual(realClient.calls.completeSession, []);
    assert.equal(summary.outcome, 'unexpected_assignment');
    assert.deepEqual(summary.outstandingSessionIds, ['sess-24', 'sess-99']);
});

test('an empty claim resolves cleanly without scraping', async () => {
    const realClient = fakeRealClient({ assignments: [] });
    const { deps, executes } = runDeps({ realClient });
    const summary = await runQuery24Workflow(deps);
    assert.equal(executes.length, 0);
    assert.equal(realClient.calls.submitJobs.length, 0);
    assert.equal(summary.outcome, 'empty');
});

test('fails closed off REMOTE mode, before any claim', async () => {
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps } = runDeps({ realClient });
    await assert.rejects(
        () => runQuery24Workflow({ ...deps, initCredentials: () => ({ isLocal: true }) }),
        (err) => err.code === 'NOT_REMOTE',
    );
    assert.equal(realClient.calls.getNextRole, 0, 'no claim may happen off REMOTE');
});

test('no timers are started: startAutoChecker is never called, runOnce runs once', async () => {
    // The harness must invoke runOnce() exactly once and never start the auto
    // checker. Assert by spying on the real orchestrator through the factory.
    const realClient = fakeRealClient({ assignments: [linkedinAssignment('sess-24', 24)] });
    const { deps } = runDeps({ realClient });
    let startAutoCalled = 0;
    let runOnceCalled = 0;
    const madeOrchestrators = [];
    const { QueueOrchestrator } = await import('../../src/queue/orchestrator.js');
    await runQuery24Workflow({
        ...deps,
        makeOrchestrator: (opts) => {
            const orch = new QueueOrchestrator(opts);
            madeOrchestrators.push(orch);
            const realRunOnce = orch.runOnce.bind(orch);
            orch.runOnce = async (...a) => { runOnceCalled += 1; return realRunOnce(...a); };
            const realStart = orch.startAutoChecker.bind(orch);
            orch.startAutoChecker = (...a) => { startAutoCalled += 1; return realStart(...a); };
            return orch;
        },
    });
    assert.equal(runOnceCalled, 1, 'runOnce runs exactly once');
    assert.equal(startAutoCalled, 0, 'no timer / auto-checker');
    assert.equal(madeOrchestrators[0].autoInterval, null, 'no interval handle exists');
});

test('does not mutate the daemon persisted pauses: overrides stub touches no file', () => {
    // pausedExceptLinkedIn returns a plain in-memory object with only read
    // methods - it has no pause()/resume()/persist and no filesystem handle.
    const o = pausedExceptLinkedIn();
    assert.equal(typeof o.pause, 'undefined');
    assert.equal(typeof o.resume, 'undefined');
    assert.equal(typeof o.setInterval, 'undefined');
    assert.ok(Object.keys(o).every((k) => k === 'pausedList' || k === 'intervalMinutes'));
});

test('isMainEntrypoint: Windows-safe URL comparison', async () => {
    const { pathToFileURL } = await import('node:url');
    const p = await import('node:path');
    const self = p.join(import.meta.dirname, '../../scripts/linkedin-query24-workflow.js');
    const selfUrl = pathToFileURL(self).href;
    assert.equal(isMainEntrypoint([process.execPath, self], selfUrl), true);
    assert.equal(isMainEntrypoint([process.execPath, self], `${selfUrl}.x`), false);
    assert.equal(isMainEntrypoint([process.execPath], selfUrl), false);
});

test('gated client hides claimLinkedInGroup on the wrapped surface', () => {
    const real = fakeRealClient();
    const gated = buildGatedClient(real, {});
    assert.equal(typeof gated.claimLinkedInGroup, 'undefined');
    assert.equal(typeof gated.getNextRole, 'function');
    assert.equal(typeof gated.submitJobs, 'function');
    assert.equal(typeof gated.completeSession, 'function');
});

test('CLI logger guard suppresses underlying output without retaining raw lines', async () => {
    let forwarded = 0;
    const fakeConsole = {
        debug: () => { forwarded += 1; },
        info: () => { forwarded += 1; },
        log: () => { forwarded += 1; },
        warn: () => { forwarded += 1; },
        error: () => { forwarded += 1; },
    };
    const originals = { ...fakeConsole };

    await withUnderlyingLogsSuppressed(async () => {
        fakeConsole.debug('raw query');
        fakeConsole.info('raw query');
        fakeConsole.log('raw query');
        fakeConsole.warn('raw query');
        fakeConsole.error('raw query');
    }, fakeConsole);

    assert.equal(forwarded, 0);
    assert.strictEqual(fakeConsole.debug, originals.debug);
    assert.strictEqual(fakeConsole.info, originals.info);
    assert.strictEqual(fakeConsole.log, originals.log);
    assert.strictEqual(fakeConsole.warn, originals.warn);
    assert.strictEqual(fakeConsole.error, originals.error);
});
