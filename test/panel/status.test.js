import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus } from '../../src/panel/status.js';

const BOOT_INFO = {
    instance: 'test-host', gitSha: 'abc1234', pkgVersion: '2.0.0',
    nodeVersion: 'v24.5.0', pid: 111, bootedAt: '2026-08-01T00:00:00.000Z',
    profileDir: '/does/not/exist-panel-test', headless: false, strict: false,
};

function baseDeps(overrides = {}) {
    return {
        bootInfo: BOOT_INFO,
        getLinkedInSession: () => ({ isAlive: () => true, lease: null }),
        orchestrator: {
            snapshot: () => ({
                running: true, mutexLocked: false, lastPollAt: null,
                lastPollOutcome: null, secondsUntilNextTick: 10, activeSessions: [],
            }),
        },
        licensePool: { snapshot: () => ({ total: 2, leased: 1, free: 1, waiting: 0, leasedKeys: ['k1'] }) },
        proxyPool: { snapshot: () => ({ total: 3, leased: 1, cooling: [] }) },
        cooldownSnapshot: () => ({}),
        spoolStats: async () => ({ count: 0, recent: 0, oldest: null, newest: null, deliveryFailingNow: false, backlog: false }),
        overrides: { pausedList: () => [] },
        recent: { list: () => [] },
        now: () => new Date('2026-08-01T00:10:00.000Z'),
        ...overrides,
    };
}

test('buildStatus: clean state produces no alerts', async () => {
    const status = await buildStatus(baseDeps());
    assert.deepEqual(status.alerts, []);
    assert.equal(status.identity.gitSha, 'abc1234');
    assert.equal(status.linkedin.needsRelogin, false);
});

test('buildStatus: needsRelogin fires when the profile exists but the session is dead', async () => {
    const status = await buildStatus(baseDeps({
        bootInfo: { ...BOOT_INFO, profileDir: import.meta.filename }, // a real file — existsSync() true
        getLinkedInSession: () => ({ isAlive: () => false, lease: null }),
    }));
    assert.equal(status.linkedin.profileDirExists, true);
    assert.equal(status.linkedin.needsRelogin, true);
    assert.ok(status.alerts.some((a) => a.level === 'error' && /re-login/.test(a.message)));
});

test('buildStatus: zero free license seats → warn alert', async () => {
    const status = await buildStatus(baseDeps({
        licensePool: { snapshot: () => ({ total: 2, leased: 2, free: 0, waiting: 1, leasedKeys: ['k1', 'k2'] }) },
    }));
    assert.ok(status.alerts.some((a) => a.level === 'warn' && /CloakBrowser seats/.test(a.message)));
});

// A non-empty spool is NOT by itself evidence that delivery is broken. Alerting
// on count alone is what made the panel warn "backend delivery is failing" for
// 34 hours (2026-08-01 → 08-03) while Indeed submissions were being accepted.
test('buildStatus: stale spool backlog → warn about replay, NOT "delivery is failing"', async () => {
    const status = await buildStatus(baseDeps({
        spoolStats: async () => ({
            count: 3554, recent: 0,
            oldest: '2026-08-01T22:40:25.965Z', newest: '2026-08-03T08:50:47.687Z',
            deliveryFailingNow: false, backlog: true,
        }),
    }));
    assert.ok(
        status.alerts.some((a) => a.level === 'warn' && /awaiting replay/.test(a.message)),
        'operator is told there is undrained work',
    );
    assert.ok(
        !status.alerts.some((a) => /delivery is failing NOW/.test(a.message)),
        'must NOT claim a live outage when nothing recent failed',
    );
});

test('buildStatus: a recent delivery failure → error alert', async () => {
    const status = await buildStatus(baseDeps({
        spoolStats: async () => ({
            count: 5, recent: 5,
            oldest: '2026-08-03T09:00:00.000Z', newest: '2026-08-03T09:05:00.000Z',
            deliveryFailingNow: true, backlog: false,
        }),
    }));
    assert.ok(status.alerts.some((a) => a.level === 'error' && /failing NOW/.test(a.message)));
});

// free === 0 is normal when both seats are doing real work; the deadlock
// signature was zero free seats WITH callers queued.
test('buildStatus: all seats busy but nothing queued → no seat alert', async () => {
    const status = await buildStatus(baseDeps({
        licensePool: { snapshot: () => ({ total: 2, leased: 2, free: 0, waiting: 0, leasedKeys: ['a', 'b'] }) },
    }));
    assert.ok(!status.alerts.some((a) => /CloakBrowser seats/.test(a.message)));
});

test('buildStatus: all seats busy AND launches queued → seat-leak warning', async () => {
    const status = await buildStatus(baseDeps({
        licensePool: { snapshot: () => ({ total: 2, leased: 2, free: 0, waiting: 576, leasedKeys: ['a', 'b'] }) },
    }));
    assert.ok(status.alerts.some((a) => a.level === 'warn' && /576 launch\(es\) queued/.test(a.message)));
});

test('buildStatus: auto-checker not running → error alert (only when a queue is configured)', async () => {
    const status = await buildStatus(baseDeps({
        orchestrator: { snapshot: () => ({ running: false, mutexLocked: false, lastPollAt: null, lastPollOutcome: null, secondsUntilNextTick: null, activeSessions: [] }) },
    }));
    assert.ok(status.alerts.some((a) => a.level === 'error' && /not running/.test(a.message)));
});

test('buildStatus: orchestrator absent (no Blacklight config) does not fire the "not running" alert', async () => {
    const status = await buildStatus(baseDeps({ orchestrator: null }));
    assert.equal(status.poll.enabled, false);
    assert.ok(!status.alerts.some((a) => /not running/.test(a.message)));
});

test('buildStatus: a long-remaining cooldown fires a warn alert; a short one does not', async () => {
    const status = await buildStatus(baseDeps({
        cooldownSnapshot: () => ({
            monster: { onCooldown: true, until: '2026-08-01T00:45:00.000Z' }, // 35 min out
            glassdoor: { onCooldown: true, until: '2026-08-01T00:12:00.000Z' }, // 2 min out
            dice: { onCooldown: false, until: null },
        }),
    }));
    assert.ok(status.alerts.some((a) => /monster/.test(a.message)));
    assert.ok(!status.alerts.some((a) => /glassdoor/.test(a.message)));
});

test('buildStatus: picks the most recently started active session', async () => {
    const status = await buildStatus(baseDeps({
        orchestrator: {
            snapshot: () => ({
                running: true, mutexLocked: true, lastPollAt: '2026-08-01T00:09:00.000Z',
                lastPollOutcome: 'batched:2', secondsUntilNextTick: 5,
                activeSessions: [
                    { sessionId: 's1', role: 'DevOps', startedAt: 1000, platforms: { dice: 'success' } },
                    { sessionId: 's2', role: 'SRE', startedAt: 5000, platforms: { indeed: 'pending' } },
                ],
            }),
        },
    }));
    assert.equal(status.session.sessionId, 's2');
    assert.equal(status.poll.mutexLocked, true);
});
