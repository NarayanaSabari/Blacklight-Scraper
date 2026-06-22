// Phase 3b — Task A: pause-on-pool-unreachable (REMOTE-only).
//
// When the credentials pool is UNREACHABLE (acquire() throws NetworkError),
// in REMOTE mode the session writes a SHORT local platform cooldown marker so
// the orchestrator pauses LinkedIn next cycle (no uncoordinated local
// fallback), then propagates the failure. The "no account available" path
// (acquire() returns null → HTTP 204) keeps today's behavior: retry, then
// "No LinkedIn credential available" — and writes NO marker.
//
// LOCAL mode (isLocal === true) must be byte-identical to today: no marker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInSession } from '../../src/scrapers/linkedin-session.js';
import { NetworkError } from '../../src/core/errors.js';

// Records every writeCooldownMarker call so a test can assert "marker written"
// (pause) vs "no marker" without touching the real filesystem.
function markerSpy() {
    const writes = [];
    return {
        writes,
        cooldown: {
            writeCooldownMarker: (opts) => { writes.push(opts); },
            cooldownPath: () => '/tmp/test-linkedin-cooldown',
            cooldownMs: () => 30 * 60 * 1000,
            defaultWriteFile: () => () => {},
            defaultRename: () => () => {},
        },
    };
}

// A launcher that must never be called when no usable lease was acquired.
const noLaunch = async () => { throw new Error('should not launch'); };

test('Task A: REMOTE + acquire throws NetworkError ⇒ writes cooldown marker (pause) AND surfaces the error', async () => {
    const spy = markerSpy();
    const apiClient = {
        isLocal: false,
        acquire: async () => { throw new NetworkError('pool unreachable', { statusCode: 503 }); },
    };
    const s = new LinkedInSession({
        apiClient, launcher: noLaunch,
        leaseRetryDelayMs: 0, maxLeaseRetries: 2,
        cooldown: spy.cooldown,
    });
    await assert.rejects(() => s.ensureReady('sess-1'), NetworkError);
    assert.equal(spy.writes.length, 1, 'exactly one cooldown marker written on pool-unreachable');
    assert.equal(spy.writes[0].path, '/tmp/test-linkedin-cooldown');
    assert.ok(spy.writes[0].cooldownMs > 0, 'a positive cooldown window');
});

test('Task A: REMOTE + acquire returns null (204, no account) ⇒ NO new marker, "No LinkedIn credential" surfaces', async () => {
    const spy = markerSpy();
    const apiClient = { isLocal: false, acquire: async () => null };
    const s = new LinkedInSession({
        apiClient, launcher: noLaunch,
        leaseRetryDelayMs: 0, maxLeaseRetries: 2,
        cooldown: spy.cooldown,
    });
    await assert.rejects(() => s.ensureReady('sess-1'), /No LinkedIn credential/);
    assert.equal(spy.writes.length, 0, '204/null path writes NO cooldown marker');
});

test('Task A: LOCAL + acquire throws NetworkError ⇒ NO marker (byte-identical to today: error propagates)', async () => {
    const spy = markerSpy();
    const apiClient = {
        isLocal: true,
        acquire: async () => { throw new NetworkError('pool unreachable', { statusCode: 503 }); },
    };
    const s = new LinkedInSession({
        apiClient, launcher: noLaunch,
        leaseRetryDelayMs: 0, maxLeaseRetries: 2,
        cooldown: spy.cooldown,
    });
    await assert.rejects(() => s.ensureReady('sess-1'), NetworkError);
    assert.equal(spy.writes.length, 0, 'LOCAL mode writes NO marker on pool-unreachable');
});

test('Task A: REMOTE NetworkError is retried across attempts before pausing', async () => {
    const spy = markerSpy();
    let attempts = 0;
    const apiClient = {
        isLocal: false,
        acquire: async () => { attempts++; throw new NetworkError('pool unreachable'); },
    };
    const s = new LinkedInSession({
        apiClient, launcher: noLaunch,
        leaseRetryDelayMs: 0, maxLeaseRetries: 3,
        cooldown: spy.cooldown,
    });
    await assert.rejects(() => s.ensureReady('sess-1'), NetworkError);
    assert.equal(attempts, 3, 'all retries exhausted before giving up');
    assert.equal(spy.writes.length, 1, 'marker written once after retries exhausted');
});

test('Task A: getter exposes mode from the apiClient (isLocal / isRemote)', () => {
    const local = new LinkedInSession({ apiClient: { isLocal: true, acquire: async () => null } });
    const remote = new LinkedInSession({ apiClient: { isLocal: false, acquire: async () => null } });
    assert.equal(local.isLocal, true);
    assert.equal(local.isRemote, false);
    assert.equal(remote.isLocal, false);
    assert.equal(remote.isRemote, true);
});

test('Task A: REMOTE eventual success (NetworkError then a lease) ⇒ no marker, lease returned', async () => {
    const spy = markerSpy();
    let calls = 0;
    const lease = { credential: { id: 7 }, release: async () => {} };
    const apiClient = {
        isLocal: false,
        acquire: async () => {
            calls++;
            if (calls === 1) throw new NetworkError('blip');
            return lease;
        },
    };
    const launcher = async () => ({ newPage: async () => ({ close: async () => {} }), close: async () => {}, browser: () => null });
    const s = new LinkedInSession({
        apiClient, launcher,
        leaseRetryDelayMs: 0, maxLeaseRetries: 3,
        cooldown: spy.cooldown,
    });
    await s.ensureReady('sess-1');
    assert.equal(spy.writes.length, 0, 'transient blip that then succeeds writes no marker');
    assert.equal(s.lease, lease);
});
