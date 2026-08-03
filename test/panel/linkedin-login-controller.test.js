import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInLoginController, STATES } from '../../src/panel/linkedin-login-controller.js';

function fakeOrchestrator(sessions = []) {
    return { snapshot: () => ({ activeSessions: sessions }) };
}

function fakeLicensePool(snapshot) {
    return { snapshot: () => snapshot };
}

function fakeFlow(overrides = {}) {
    const handle = { context: {}, page: {} };
    let closed = 0;
    return {
        closedCount: () => closed,
        resolveLoginProfileDir: ({ profileKey }) => `/profiles/${profileKey ?? 'default'}`,
        openLoginBrowser: async () => handle,
        captureSession: async () => ({ cookies: [{ name: 'li_at' }], error: null }),
        validateSession: async () => ({ ok: true, reason: null, error: null, finalUrl: 'https://www.linkedin.com/feed/' }),
        closeLoginBrowser: async () => { closed += 1; },
        ...overrides,
    };
}

function freeSeats() {
    return { total: 2, free: 1 };
}

test('start(): idle -> opening -> awaiting_operator on the happy path', async () => {
    const flow = fakeFlow();
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow });
    assert.equal(c.status().state, STATES.IDLE);
    const result = await c.start({ profileKey: 'li-acct-1' });
    assert.equal(result.state, STATES.AWAITING_OPERATOR);
    assert.equal(result.profileDir, '/profiles/li-acct-1');
    assert.equal(c.status().state, STATES.AWAITING_OPERATOR);
});

test('start(): refuses with SESSION_IN_FLIGHT when a scrape session is active', async () => {
    const c = new LinkedInLoginController({
        orchestrator: fakeOrchestrator([{ sessionId: 's1' }]),
        licensePool: fakeLicensePool(freeSeats()),
        flow: fakeFlow(),
    });
    await assert.rejects(c.start({}), (err) => err.code === 'SESSION_IN_FLIGHT');
    assert.equal(c.status().state, STATES.IDLE);
});

test('start(): refuses with NO_FREE_SEAT when the license pool is fully leased', async () => {
    const c = new LinkedInLoginController({
        orchestrator: fakeOrchestrator(),
        licensePool: fakeLicensePool({ total: 1, free: 0 }),
        flow: fakeFlow(),
    });
    await assert.rejects(c.start({}), (err) => err.code === 'NO_FREE_SEAT');
});

test('start(): refuses with LOGIN_IN_PROGRESS while a login is already busy', async () => {
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow: fakeFlow() });
    await c.start({});
    await assert.rejects(c.start({}), (err) => err.code === 'LOGIN_IN_PROGRESS');
});

test('start(): a browser-open failure lands in failed and releases nothing (no seat was ever held)', async () => {
    const flow = fakeFlow({ openLoginBrowser: async () => { throw new Error('launch failed'); } });
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow });
    await assert.rejects(c.start({}), /launch failed/);
    assert.equal(c.status().state, STATES.FAILED);
    assert.equal(c.status().lastError, 'launch failed');
});

test('complete(): refuses with NOT_AWAITING when nothing was started', async () => {
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow: fakeFlow() });
    await assert.rejects(c.complete(), (err) => err.code === 'NOT_AWAITING');
});

test('complete(): a passing verdict lands in done and releases the browser (seat)', async () => {
    const flow = fakeFlow();
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow });
    await c.start({});
    const result = await c.complete();
    assert.equal(result.state, STATES.DONE);
    assert.equal(result.verdict.ok, true);
    assert.equal(result.cookiesCaptured, 1);
    assert.equal(c.status().state, STATES.DONE);
    assert.equal(flow.closedCount(), 1, 'the browser (and its seat) must be released on success');
});

test('complete(): a failing verdict lands in failed and STILL releases the browser (seat)', async () => {
    const flow = fakeFlow({ validateSession: async () => ({ ok: false, reason: 'redirected_to_login', error: null, finalUrl: 'https://www.linkedin.com/login' }) });
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow });
    await c.start({});
    const result = await c.complete();
    assert.equal(result.state, STATES.FAILED);
    assert.equal(result.verdict.ok, false);
    assert.equal(c.status().state, STATES.FAILED);
    assert.equal(flow.closedCount(), 1, 'a failed validation must still release the seat');
});

test('complete(): captureSession throwing is caught, still releases the browser, and lands in failed', async () => {
    const flow = fakeFlow({ captureSession: async () => { throw new Error('cookies() failed'); } });
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow });
    await c.start({});
    const result = await c.complete();
    assert.equal(result.state, STATES.FAILED);
    assert.equal(result.verdict.ok, false);
    assert.equal(flow.closedCount(), 1);
});

test('after done/failed, start() is allowed again immediately (terminal states are not "busy")', async () => {
    const flow = fakeFlow();
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow });
    await c.start({});
    await c.complete();
    assert.equal(c.status().state, STATES.DONE);
    await assert.doesNotReject(c.start({}));
    assert.equal(c.status().state, STATES.AWAITING_OPERATOR);
});

test('cancel(): closes the browser and releases the seat when busy', async () => {
    const flow = fakeFlow();
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow });
    await c.start({});
    const result = await c.cancel();
    assert.equal(result.state, STATES.CANCELLED);
    assert.equal(flow.closedCount(), 1);
});

test('cancel(): idempotent no-op when idle', async () => {
    const c = new LinkedInLoginController({ orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow: fakeFlow() });
    const result = await c.cancel();
    assert.equal(result.state, STATES.IDLE);
});

test('timeout: auto-cancels awaiting_operator after the configured timeout, releasing the seat', async () => {
    const flow = fakeFlow();
    const c = new LinkedInLoginController({
        orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow, timeoutMs: 10,
    });
    await c.start({});
    assert.equal(c.status().state, STATES.AWAITING_OPERATOR);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(c.status().state, STATES.CANCELLED);
    assert.equal(flow.closedCount(), 1);
});

test('timeout: is cleared by complete() — a finished login never gets auto-cancelled later', async () => {
    const flow = fakeFlow();
    const c = new LinkedInLoginController({
        orchestrator: fakeOrchestrator(), licensePool: fakeLicensePool(freeSeats()), flow, timeoutMs: 15,
    });
    await c.start({});
    await c.complete();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(c.status().state, STATES.DONE, 'timeout must not fire after complete() already resolved the login');
    assert.equal(flow.closedCount(), 1, 'only complete()\'s own close, not a second one from a stray timeout');
});
