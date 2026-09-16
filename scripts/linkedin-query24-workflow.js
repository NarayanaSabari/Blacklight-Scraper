#!/usr/bin/env node
// One-shot, guarded normal-workflow harness for candidate query 24.
//
// WHY THIS EXISTS
// query24 returns zero in production intermittently. The single diagnostic
// (scripts/linkedin-query24-diagnostic.js) proved the FIRST PAGE is served, but
// it deliberately bypasses the full sweep: it calls paginate() directly, does
// not claim a backend session, and does not submit or finalize. To observe the
// exact production path - real backend claim -> candidateScoped scrape (uncapped,
// time-budgeted) -> submitJobs(empty_confirmed) -> completeSession - we must run
// the real QueueOrchestrator workflow, once, for exactly this candidate.
//
// WHAT MAKES IT SAFE (and why it changes no production core)
//   • Bootstraps getConfig() and the REMOTE credential client first; fails
//     closed off REMOTE, same as the diagnostic.
//   • Uses the REAL QueueOrchestrator and the REAL LinkedIn scraper through the
//     orchestrator's existing injection seams. No orchestrator source changes.
//   • Injects an IN-MEMORY platform-overrides stub that pauses the other five
//     platforms, so this invocation can only claim LinkedIn. The daemon's
//     persisted pauses (config/platform-overrides.json) are never read or
//     written by this harness - it runs in its own process with its own stub.
//   • Injects a client wrapper that OMITS claimLinkedInGroup, which disables the
//     group-claim path entirely through the orchestrator's own `canTryGroup`
//     gate. The group scraper is a stub that throws if ever reached.
//   • Claims AT MOST ONE assignment: after the first real claim the gate latches
//     and every follow-up poll (the orchestrator's post-settle setImmediate)
//     returns empty WITHOUT hitting the backend, so no second session is claimed.
//   • VALIDATES candidate_query.id === 24 before anything executes. Only a
//     single-platform LinkedIn target is handed to the orchestrator to run. Any
//     unexpected claimed session fails closed and is returned as outstanding -
//     never scraped, submitted, completed, or reset by this harness.
//   • Never starts a timer: startAutoChecker() is not called; runOnce() is
//     invoked exactly once and the harness awaits the real terminal
//     completeSession before returning.
//   • Logs an allowlist of non-secret facts only (candidate id, session id,
//     platform, counts, status, empty_confirmed, imported/found, stop reason).
//     The raw boolean is NEVER logged.
//
// Real backend, real session (minted by the backend, never fabricated). No
// cadence or credential mutation. Stops on any real scrape auth/challenge/rate
// failure with no retry (one-shot by construction).
//
//     node scripts/linkedin-query24-workflow.js

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getConfig } from '../src/config/env.js';
import { initializeCredentialsClient } from '../src/api/credentials.js';
import { QueueOrchestrator } from '../src/queue/orchestrator.js';
import { BlacklightApiClient } from '../src/api/blacklight.js';
import { getScraper } from '../src/scrapers/registry.js';

// The candidate row under investigation. The backend owns the query text; this
// harness only ever asserts the id, never rewrites or logs the boolean.
export const TARGET_CANDIDATE_ID = 24;
export const ONLY_PLATFORM = 'linkedin';
export const OTHER_PLATFORMS = Object.freeze([
    'dice', 'glassdoor', 'indeed', 'monster', 'techfetch',
]);

export function assignmentHasPlatform(assignment, platformName) {
    const expected = String(platformName).toLowerCase();
    return (assignment?.platforms ?? []).some((p) => {
        const name = typeof p === 'string' ? p : p?.name;
        return String(name ?? '').toLowerCase() === expected;
    });
}

export function assignmentIsLinkedInOnly(assignment) {
    const platforms = assignment?.platforms;
    return Array.isArray(platforms)
        && platforms.length === 1
        && assignmentHasPlatform(assignment, ONLY_PLATFORM);
}

/**
 * Partition a claim response into the validated target and everything else.
 * The target is the LinkedIn assignment whose candidate_query.id matches.
 *
 * @returns {{target: object|null, others: object[]}}
 */
export function pickTargetAssignment(assignments, targetId = TARGET_CANDIDATE_ID) {
    const list = Array.isArray(assignments) ? assignments : [];
    const target = list.find((a) => a?.candidate_query?.id === targetId
        && assignmentIsLinkedInOnly(a)) ?? null;
    const others = list.filter((a) => a !== target);
    return { target, others };
}

// An in-memory overrides object that pauses every platform except LinkedIn.
// Implements only the two methods the orchestrator's claim path calls, and
// touches no file - so the daemon's persisted pauses are untouched.
export function pausedExceptLinkedIn(paused = OTHER_PLATFORMS) {
    const list = [...paused].map((p) => String(p).toLowerCase()).sort();
    return {
        pausedList: () => list,
        // null == "claimable every cycle"; a fresh SweepSchedule has no history
        // so LinkedIn is claimable immediately without a cadence override.
        intervalMinutes: () => null,
    };
}

/**
 * Wrap the real Blacklight client so that:
 *   - the group-claim capability is hidden (disables the orchestrator's group
 *     path via its own `typeof client.claimLinkedInGroup === 'function'` gate);
 *   - exactly ONE real claim happens (latched); later polls return empty;
 *   - only a validated candidate-24 assignment is handed on to execute;
 *   - any unexpected claim fails closed and remains outstanding for coordinator
 *     recovery; this wrapper never completes or resets it;
 *   - submit/complete for the target are recorded and signal terminal done.
 *
 * The wrapper delegates every other method untouched.
 */
export function buildGatedClient(realClient, {
    targetId = TARGET_CANDIDATE_ID,
    onStage = () => {},
    signalDone = () => {},
    state = {},
} = {}) {
    let claimed = false;
    return {
        // Read-only passthroughs the claim path needs.
        checkActiveSession: (...a) => realClient.checkActiveSession(...a),
        checkCredentialAvailability: () => realClient.checkCredentialAvailability(),

        // NOTE: claimLinkedInGroup intentionally absent -> group path disabled.

        getNextRole: async (opts) => {
            // Latch: only one real claim, ever. A follow-up poll returns empty
            // without touching the backend, so no second session is claimed.
            if (claimed) return { assignments: [] };
            claimed = true;

            const res = await realClient.getNextRole(opts);
            const assignments = res?.assignments ?? [];
            if (assignments.length === 0) {
                onStage({ stage: 'claim', outcome: 'empty' });
                state.terminalOutcome = { outcome: 'empty' };
                signalDone({ outcome: 'empty' });
                return { assignments: [] };
            }

            const { target, others } = pickTargetAssignment(assignments, targetId);

            // A claim response outside the exact target shape is unsafe to
            // interpret. Stop the whole one-shot, including a valid target
            // appearing beside an unexpected assignment. The coordinator owns
            // any recovery for these backend-created sessions.
            if (!target || others.length > 0) {
                const outstandingSessionIds = assignments
                    .map((assignment) => assignment?.session_id)
                    .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0);
                state.outstandingSessionIds = outstandingSessionIds;
                onStage({
                    stage: 'claim',
                    outcome: 'unexpected_assignment',
                    claimed: assignments.length,
                    outstandingSessionIds,
                });
                state.terminalOutcome = { outcome: 'unexpected_assignment', outstandingSessionIds };
                signalDone({ outcome: 'unexpected_assignment', outstandingSessionIds });
                return { assignments: [] };
            }

            state.targetSession = target.session_id;
            onStage({
                stage: 'claim',
                outcome: 'target',
                sessionId: target.session_id,
                candidateId: targetId,
            });
            // Only the validated target is executed by the orchestrator.
            return { ...res, assignments: [target] };
        },

        submitJobs: async (sessionId, platform, jobs, status, errorMessage, meta) => {
            const response = await realClient.submitJobs(
                sessionId, platform, jobs, status, errorMessage, meta,
            );
            if (sessionId === state.targetSession) {
                onStage({
                    stage: 'submit',
                    platform,
                    count: Array.isArray(jobs) ? jobs.length : 0,
                    status: status ?? 'success',
                    emptyConfirmed: typeof meta?.emptyConfirmed === 'boolean'
                        ? meta.emptyConfirmed : null,
                });
            }
            return response;
        },

        completeSession: async (sessionId) => {
            let r;
            try {
                r = await realClient.completeSession(sessionId);
            } catch (err) {
                if (sessionId === state.targetSession) {
                    onStage({
                        stage: 'completion_failed',
                        outcome: 'completion_failed',
                        sessionId,
                        errorKind: err?.name ?? 'Error',
                    });
                    signalDone({ outcome: 'completion_failed', sessionId });
                }
                throw err;
            }
            if (sessionId === state.targetSession) {
                onStage({
                    stage: 'complete',
                    outcome: 'completed',
                    sessionId,
                    imported: r?.jobs?.total_imported ?? null,
                    found: r?.jobs?.total_found ?? null,
                    durationSec: r?.duration_seconds ?? null,
                });
                signalDone({ outcome: 'completed', sessionId });
            }
            return r;
        },
    };
}

// Group scraper that must never run in this harness. If the group path were
// somehow reached, failing loudly is safer than silently collecting group work.
function refusingGroupScraper() {
    return {
        executeWithMeta: async () => {
            throw new Error('group collection is disabled in the query24 workflow harness');
        },
    };
}

function withTimeout(promise, ms, onTimeout) {
    if (!(ms > 0)) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { onTimeout?.(); } catch { /* best effort */ }
            reject(new Error(`query24 workflow did not reach terminal completion within ${ms}ms`));
        }, ms);
        timer.unref?.();
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

// The real orchestrator and scraper loggers write directly to console. Their
// normal LinkedIn start line includes the recruiter boolean, so the CLI must
// suppress those lines rather than capture them for filtering. Harness records
// use process.stdout through defaultLog and remain visible. This stores only
// method references, never logger output.
export async function withUnderlyingLogsSuppressed(operation, consoleImpl = console) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const methods = ['debug', 'info', 'log', 'warn', 'error'];
    const originals = [];
    for (const method of methods) {
        const original = consoleImpl?.[method];
        if (typeof original !== 'function') continue;
        try {
            consoleImpl[method] = () => {};
            originals.push({ method, original });
        } catch {
            // A non-writable console method is outside the CLI's control.
        }
    }
    try {
        return await operation();
    } finally {
        for (const { method, original } of originals) {
            try { consoleImpl[method] = original; } catch { /* best effort */ }
        }
    }
}

function hasActiveWorkflow(orchestrator) {
    const snapshot = orchestrator?.snapshot?.();
    const activeSessions = snapshot?.activeSessions;
    return Array.isArray(activeSessions) && activeSessions.length > 0;
}

function summaryFor({ startedAt, outcome, targetSession, outstandingSessionIds, stages }) {
    return {
        kind: 'linkedin-query24-workflow',
        startedAt,
        outcome,
        targetSession: targetSession ?? null,
        outstandingSessionIds: outstandingSessionIds ?? [],
        stages,
    };
}

/**
 * Run the guarded one-shot query24 workflow and resolve with the collected
 * non-secret evidence once the target session reaches terminal completion.
 *
 * Every collaborator is injectable so the whole path runs under fakes with no
 * live network in tests.
 */
export async function runQuery24Workflow({
    getConfigImpl = getConfig,
    initCredentials = initializeCredentialsClient,
    makeClient = (config) => new BlacklightApiClient(config.blacklight.apiUrl, config.blacklight.apiKey),
    makeOrchestrator = (opts) => new QueueOrchestrator(opts),
    scraperResolver = getScraper,
    // Prod defaults: real cooldown check + global metrics. Tests inject stubs.
    cooldownCheck = undefined,
    metrics = undefined,
    targetId = TARGET_CANDIDATE_ID,
    timeoutMs = 600_000,
    log = defaultLog,
    now = () => Date.now(),
} = {}) {
    const startedAt = new Date(now()).toISOString();
    const stages = [];
    const record = (s) => {
        const entry = { kind: 'linkedin-query24-workflow', startedAt, ...s };
        stages.push(entry);
        log(entry);
    };

    // 1) Bootstrap config, then require REMOTE - identical fail-closed rule as
    //    the diagnostic. A LOCAL client would lease a credentials.json account.
    getConfigImpl();
    const credClient = initCredentials();
    if (credClient?.isLocal !== false) {
        record({ stage: 'bootstrap', stopReason: 'not_remote_mode' });
        const err = new Error('Refusing to run: credential client is not in REMOTE mode');
        err.code = 'NOT_REMOTE';
        throw err;
    }
    record({ stage: 'bootstrap', remoteMode: true, targetId });

    const config = getConfigImpl();
    const realClient = makeClient(config);

    let signalDone;
    const done = new Promise((resolve) => { signalDone = resolve; });
    const state = {};
    const gatedClient = buildGatedClient(realClient, {
        targetId,
        onStage: record,
        signalDone,
        state,
    });

    const orchestrator = makeOrchestrator({
        client: gatedClient,
        queueConfig: config.queue,
        defaultLocation: config.queue?.defaultLocation,
        scraperResolver,
        platformOverrides: pausedExceptLinkedIn(),
        groupScraper: refusingGroupScraper(),
        ...(cooldownCheck ? { cooldownCheck } : {}),
        ...(metrics ? { metrics } : {}),
    });

    // Exactly one cycle. Never startAutoChecker() - no timers.
    const runResult = await orchestrator.runOnce();

    // Pre-claim gates (mutex, credential availability, cooldown, pause, or
    // cadence) can return without invoking the gated client at all. In that
    // case there is no terminal completion callback to await. Return a truthful
    // explicit skip only when no assignment was started and no workflow is
    // active; an actual empty claim or unexpected claim already signalled its
    // own terminal outcome above.
    if (state.terminalOutcome === undefined
        && state.targetSession === undefined
        && !(runResult?.batched > 0)
        && !hasActiveWorkflow(orchestrator)) {
        const stopReason = runResult?.skipped ? 'claim_in_flight' : 'no_claimable_work';
        record({ stage: 'run_once', outcome: 'skipped', stopReason });
        return summaryFor({
            startedAt,
            outcome: 'skipped',
            targetSession: state.targetSession,
            outstandingSessionIds: state.outstandingSessionIds,
            stages,
        });
    }

    // Await the REAL terminal completion (or the empty/no-target short-circuit).
    const outcome = await withTimeout(done, timeoutMs, () => {
        record({ stage: 'timeout' });
    });

    const summary = summaryFor({
        startedAt,
        outcome: outcome?.outcome ?? 'unknown',
        targetSession: state.targetSession ?? null,
        outstandingSessionIds: outcome?.outstandingSessionIds ?? state.outstandingSessionIds,
        stages,
    });
    return summary;
}

function defaultLog(record) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function main() {
    try {
        const summary = await withUnderlyingLogsSuppressed(() => runQuery24Workflow());
        defaultLog({
            kind: 'linkedin-query24-workflow',
            stage: 'summary',
            outcome: summary.outcome,
            targetSession: summary.targetSession,
            outstandingSessionIds: summary.outstandingSessionIds,
        });
    } catch (error) {
        defaultLog({
            kind: 'linkedin-query24-workflow',
            stage: 'error',
            errorKind: error?.name ?? 'Error',
            errorCode: error?.code ?? null,
        });
        process.exitCode = 1;
    }
}

export function isMainEntrypoint(argv = process.argv, moduleUrl = import.meta.url) {
    const entry = argv?.[1];
    if (!entry) return false;
    try {
        return moduleUrl === pathToFileURL(path.resolve(entry)).href;
    } catch {
        return false;
    }
}

if (isMainEntrypoint()) {
    main();
}
