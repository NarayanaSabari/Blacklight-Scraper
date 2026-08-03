// Per-platform sweep cadence.
//
// Measured 2026-08-03: Indeed ran 39,539 sessions over 141 roles in 24h (one
// re-scrape per role every ~5.1 min) to import 4,374 jobs — 344 scraped records
// per import, against Dice's 4. 69.4% of its skips were duplicate_platform_id.
// These pin the gate that turns that into one hourly sweep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SweepSchedule } from '../../src/queue/sweep-schedule.js';

const MIN = 60_000;

function harness(intervals = {}, start = 1_000_000) {
    let t = start;
    const schedule = new SweepSchedule({
        intervalMinutes: (p) => intervals[p] ?? null,
        now: () => t,
    });
    return { schedule, advance: (ms) => { t += ms; }, at: () => t };
}

test('a platform with NO configured interval is always claimable (legacy behaviour)', () => {
    const { schedule, advance } = harness({});
    assert.equal(schedule.isScheduled('dice'), false);
    assert.equal(schedule.isClaimable('dice'), true);
    assert.equal(schedule.begin('dice'), false, 'unscheduled platforms have no sweeps');
    advance(1);
    assert.equal(schedule.isClaimable('dice'), true, 'still claimable on the very next cycle');
});

test('indeed at 60 min: sweeps once, then is excluded until the hour is up', () => {
    const { schedule, advance } = harness({ indeed: 60 });

    assert.equal(schedule.isDue('indeed'), true, 'never swept → due immediately');
    assert.equal(schedule.begin('indeed'), true);

    // Queue drains; sweep closes.
    schedule.end('indeed');

    advance(59 * MIN);
    assert.equal(schedule.isClaimable('indeed'), false, 'not due 59 min in');
    assert.equal(schedule.begin('indeed'), false);

    advance(2 * MIN);                       // 61 min after the sweep STARTED
    assert.equal(schedule.isClaimable('indeed'), true);
    assert.equal(schedule.begin('indeed'), true, 'next sweep opens on the hour');
});

test('an in-flight sweep stays claimable so it can drain every queued role', () => {
    const { schedule, advance } = harness({ indeed: 60 });
    schedule.begin('indeed');

    // Mid-sweep: many claim cycles, all must be allowed through.
    for (let i = 0; i < 5; i += 1) {
        advance(30_000);
        assert.equal(schedule.isClaimable('indeed'), true, 'sweep in flight → keep claiming');
        assert.equal(schedule.begin('indeed'), false, 'but never opens a second sweep');
    }
    assert.ok(schedule.end('indeed'));
});

test('the interval is measured from sweep START, not finish', () => {
    const { schedule, advance } = harness({ indeed: 60 });
    schedule.begin('indeed');
    advance(20 * MIN);                       // a slow 20-minute sweep
    schedule.end('indeed');

    advance(39 * MIN);                       // 59 min after start
    assert.equal(schedule.isDue('indeed'), false);
    advance(2 * MIN);                        // 61 min after start
    assert.equal(schedule.isDue('indeed'), true);
});

test('a sweep that outruns its interval does NOT stack a second one', () => {
    const { schedule, advance } = harness({ indeed: 60 });
    schedule.begin('indeed');
    advance(75 * MIN);                       // still running, past the hour

    assert.equal(schedule.begin('indeed'), false, 'skip, do not queue');
    assert.equal(schedule.isClaimable('indeed'), true, 'the running sweep keeps going');

    schedule.end('indeed');
    assert.equal(schedule.begin('indeed'), true, 'a new sweep may start once it finishes');
});

test('end() returns the summary that makes the -83% prediction checkable', () => {
    const { schedule, advance } = harness({ indeed: 60 });
    schedule.begin('indeed');
    schedule.record('indeed', { roles: 3, sessions: 3, jobsSeen: 120, jobsImported: 4 });
    schedule.record('indeed', { roles: 2, sessions: 2, jobsSeen: 80, jobsImported: 1 });
    advance(90_000);

    const summary = schedule.end('indeed');
    assert.equal(summary.platform, 'indeed');
    assert.equal(summary.roles, 5);
    assert.equal(summary.sessions, 5);
    assert.equal(summary.jobsSeen, 200);
    assert.equal(summary.jobsImported, 5);
    assert.equal(summary.durationMs, 90_000);
    assert.equal(typeof summary.nextDueAt, 'string');
});

test('record() outside a sweep is ignored rather than throwing', () => {
    const { schedule } = harness({ indeed: 60 });
    schedule.record('indeed', { sessions: 5 });        // no sweep open
    schedule.begin('indeed');
    const summary = schedule.end('indeed');
    assert.equal(summary.sessions, 0, 'counters start clean at sweep open');
});

test('end() with no sweep running returns null', () => {
    const { schedule } = harness({ indeed: 60 });
    assert.equal(schedule.end('indeed'), null);
});

test('platforms are gated independently', () => {
    const { schedule, advance } = harness({ indeed: 60 });
    schedule.begin('indeed');
    schedule.end('indeed');

    advance(MIN);
    assert.equal(schedule.isClaimable('indeed'), false, 'indeed is sleeping');
    assert.equal(schedule.isClaimable('dice'), true, 'dice is unaffected');
    assert.equal(schedule.isClaimable('techfetch'), true);
});

test('changing the interval takes effect without a restart', () => {
    const intervals = { indeed: 60 };
    let t = 1_000_000;
    const schedule = new SweepSchedule({
        intervalMinutes: (p) => intervals[p] ?? null,
        now: () => t,
    });
    schedule.begin('indeed');
    schedule.end('indeed');
    t += 10 * MIN;
    assert.equal(schedule.isDue('indeed'), false);

    intervals.indeed = 5;                    // operator edits it in the panel
    assert.equal(schedule.isDue('indeed'), true, 'read live, no restart needed');

    delete intervals.indeed;                 // cleared entirely
    assert.equal(schedule.isScheduled('indeed'), false);
    assert.equal(schedule.isClaimable('indeed'), true);
});

test('snapshot exposes cadence state for the panel', () => {
    const { schedule, advance } = harness({ indeed: 60 });
    schedule.begin('indeed');
    advance(MIN);
    const inFlight = schedule.snapshot();
    assert.equal(inFlight.indeed.intervalMinutes, 60);
    assert.equal(inFlight.indeed.inFlight, true);

    schedule.end('indeed');
    const idle = schedule.snapshot();
    assert.equal(idle.indeed.inFlight, false);
    assert.equal(idle.indeed.dueNow, false);
    assert.equal(typeof idle.indeed.nextDueAt, 'string');
});
