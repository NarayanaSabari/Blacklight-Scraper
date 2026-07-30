// SCR-18 (#401): a settling platform schedules ONE follow-up claim, not one each.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueOrchestrator } from '../../src/queue/orchestrator.js';

const tick = () => new Promise((r) => setImmediate(r));

function fakeMetrics() {
    return {
        recordQueueCheck() {}, recordJobsSubmitted() {}, recordSessionAllFailed() {},
        recordCredentialsAvailability() {}, recordAssignmentBatch() {},
    };
}

// A client whose queue is always empty, so runOnce() finishes immediately and we
// are measuring poll COUNT rather than scrape behaviour.
function countingClient(counter) {
    return {
        // Non-empty, or #claim short-circuits before reaching getNextRole.
        checkCredentialAvailability: async () => ({ indeed: 1 }),
        getNextRole: async () => { counter.polls += 1; return null; },
        checkActiveSession: async () => ({ has_active_session: false }),
        submitJobs: async () => ({}),
        completeSession: async () => ({}),
    };
}

function makeOrchestrator(counter) {
    return new QueueOrchestrator({
        queueConfig: { checkIntervalMs: 100000, startupDelayMs: 100000 },
        client: countingClient(counter),
        metrics: fakeMetrics(),
        scraperResolver: () => ({ executeWithMeta: async () => ({ jobs: [], emptyConfirmed: true }) }),
        cooldownCheck: () => [],
    });
}

test('a burst of triggers in one tick collapses to a single poll', async () => {
    // Six platforms settling together used to fire six setImmediate(runOnce).
    const counter = { polls: 0 };
    const o = makeOrchestrator(counter);

    for (let i = 0; i < 6; i += 1) o._schedulePollForTest('indeed');
    await tick();
    await tick();

    assert.equal(counter.polls, 1, 'six triggers must produce ONE backend claim');
});

test('a trigger arriving after the poll has run schedules a fresh one', async () => {
    // The flag is cleared before running, so work settling DURING a poll is not
    // swallowed — otherwise a fast platform could stall until the 30s tick.
    const counter = { polls: 0 };
    const o = makeOrchestrator(counter);

    o._schedulePollForTest('indeed');
    await tick();
    await tick();
    assert.equal(counter.polls, 1);

    o._schedulePollForTest('dice');
    await tick();
    await tick();
    assert.equal(counter.polls, 2, 'a later settle must still get its own claim');
});

test('coalescing does not delay the first trigger', async () => {
    const counter = { polls: 0 };
    const o = makeOrchestrator(counter);

    o._schedulePollForTest('indeed');
    await tick();
    await tick();

    assert.equal(counter.polls, 1, 'still fires on the next tick, no added latency');
});
