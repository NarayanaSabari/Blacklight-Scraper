import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerPanelRoutes } from '../../src/panel/router.js';
import { UnknownPlatformError } from '../../src/panel/overrides.js';

// Mirrors the request/response fakes in test/routes/scrape.test.js and
// test/routes/healthz.test.js — no real socket, no real listen().
function call(app, method, urlPath, body) {
    return new Promise((resolve) => {
        const req = {
            method, url: urlPath, query: {}, headers: {}, body,
            socket: { remoteAddress: '127.0.0.1' },
        };
        const url = new URL(urlPath, 'http://localhost');
        req.path = url.pathname;
        const res = {
            statusCode: 200,
            _type: null,
            _headers: {},
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            type(t) { this._type = t; return this; },
            send(body) { resolve({ status: this.statusCode, type: this._type, body }); return this; },
            json(o) { resolve({ status: this.statusCode, body: o }); return this; },
        };
        app.handle(req, res, () => resolve({ status: 404, body: null }));
    });
}

function baseDeps(overrides = {}) {
    return {
        bootInfo: { instance: 'test', gitSha: 'abc', pkgVersion: '2.0.0', nodeVersion: 'v24', pid: 1, bootedAt: null, profileDir: 'unknown', headless: false, strict: false },
        getLinkedInSession: () => ({ isAlive: () => false, lease: null }),
        orchestrator: null,
        licensePool: { snapshot: () => ({ total: 0, leased: 0, free: 0, waiting: 0, leasedKeys: [] }) },
        proxyPool: { snapshot: () => ({ total: 0, leased: 0, cooling: [] }) },
        cooldownSnapshot: () => ({}),
        spoolSnapshot: async () => ({ count: 0, oldest: null }),
        overrides: {
            pause(name) { if (name !== 'dice' && name !== 'indeed') throw new UnknownPlatformError(name); return ['dice']; },
            resume(name) { if (name !== 'dice' && name !== 'indeed') throw new UnknownPlatformError(name); return []; },
            pausedList: () => [],
        },
        recent: { list: () => [] },
        requestRestart: async () => {},
        loginController: {
            status: () => ({ state: 'idle', profileKey: null, profileDir: null, startedAt: null, lastVerdict: null, lastError: null }),
            start: async () => ({ state: 'awaiting_operator', profileDir: '/tmp/li-profile', profileKey: null }),
            complete: async () => ({ state: 'done', verdict: { ok: true, finalUrl: 'https://www.linkedin.com/feed/' }, profileDir: '/tmp/li-profile', cookiesCaptured: 3 }),
            cancel: async () => ({ state: 'idle' }),
        },
        ...overrides,
    };
}

function inject(deps) {
    const app = express();
    registerPanelRoutes(app, deps);
    return app;
}

test('GET /panel: renders HTML, loopback only', async () => {
    const app = inject(baseDeps());
    const res = await call(app, 'GET', '/panel');
    assert.equal(res.status, 200);
    assert.equal(res.type, 'html');
    assert.match(res.body, /Scraper Control Panel/);
});

test('GET /panel: rejected for a non-loopback caller', async () => {
    const app = inject(baseDeps());
    const res = await new Promise((resolve) => {
        const req = { method: 'GET', url: '/panel', path: '/panel', query: {}, headers: {}, socket: { remoteAddress: '10.0.1.5' } };
        const resObj = {
            statusCode: 200,
            setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(o) { resolve({ status: this.statusCode, body: o }); return this; },
        };
        app.handle(req, resObj, () => resolve({ status: 404 }));
    });
    assert.equal(res.status, 403);
});

test('GET /panel/api/status: returns the aggregated JSON', async () => {
    const app = inject(baseDeps());
    const res = await call(app, 'GET', '/panel/api/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.identity.gitSha, 'abc');
});

test('POST /panel/api/poll: 503 when no orchestrator is configured', async () => {
    const app = inject(baseDeps({ orchestrator: null }));
    const res = await call(app, 'POST', '/panel/api/poll', {});
    assert.equal(res.status, 503);
});

test('POST /panel/api/poll: 409 when the mutex is already held', async () => {
    const app = inject(baseDeps({
        orchestrator: { mutex: { isLocked: true }, runOnce: async () => { throw new Error('should not be called'); } },
    }));
    const res = await call(app, 'POST', '/panel/api/poll', {});
    assert.equal(res.status, 409);
});

test('POST /panel/api/poll: 200 + result on success', async () => {
    const app = inject(baseDeps({
        orchestrator: { mutex: { isLocked: false }, runOnce: async () => ({ message: 'Queue is empty for idle platforms' }) },
    }));
    const res = await call(app, 'POST', '/panel/api/poll', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.result.message, 'Queue is empty for idle platforms');
});

test('POST /panel/api/platform/:name/pause: 404 for an unknown platform', async () => {
    const app = inject(baseDeps());
    const res = await call(app, 'POST', '/panel/api/platform/not-a-real-platform/pause', {});
    assert.equal(res.status, 404);
});

test('POST /panel/api/platform/:name/pause: 200 for a known platform', async () => {
    const app = inject(baseDeps());
    const res = await call(app, 'POST', '/panel/api/platform/dice/pause', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
});

test('POST /panel/api/restart: 409 when a session is in flight and force is not set', async () => {
    const app = inject(baseDeps({
        orchestrator: { snapshot: () => ({ activeSessions: [{ sessionId: 's1' }] }) },
    }));
    const res = await call(app, 'POST', '/panel/api/restart', {});
    assert.equal(res.status, 409);
});

test('POST /panel/api/restart: proceeds with force:true even with a session in flight', async () => {
    let restartCalled = false;
    const app = inject(baseDeps({
        orchestrator: { snapshot: () => ({ activeSessions: [{ sessionId: 's1' }] }) },
        requestRestart: async () => { restartCalled = true; },
    }));
    const res = await call(app, 'POST', '/panel/api/restart', { force: true });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget restart call settle
    assert.equal(restartCalled, true);
});

test('POST /panel/api/restart: proceeds immediately with no active sessions', async () => {
    let restartCalled = false;
    const app = inject(baseDeps({
        orchestrator: { snapshot: () => ({ activeSessions: [] }) },
        requestRestart: async () => { restartCalled = true; },
    }));
    const res = await call(app, 'POST', '/panel/api/restart', {});
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(restartCalled, true);
});

test('POST /panel/api/linkedin/login/start: 200, forwards profileKey/proxy, and passes through the resolved profile dir', async () => {
    let received;
    const app = inject(baseDeps({
        loginController: {
            start: async (args) => { received = args; return { state: 'awaiting_operator', profileDir: '/tmp/li-acct-1', profileKey: 'li-acct-1' }; },
        },
    }));
    const res = await call(app, 'POST', '/panel/api/linkedin/login/start', { profileKey: 'li-acct-1', proxy: 'host:1:u:p' });
    assert.equal(res.status, 200);
    assert.equal(res.body.profileDir, '/tmp/li-acct-1');
    assert.deepEqual(received, { profileKey: 'li-acct-1', proxy: 'host:1:u:p' });
});

test('POST /panel/api/linkedin/login/start: maps each controller error code to 409', async () => {
    for (const code of ['LOGIN_IN_PROGRESS', 'SESSION_IN_FLIGHT', 'NO_FREE_SEAT']) {
        const app = inject(baseDeps({
            loginController: { start: async () => { const e = new Error(code); e.code = code; throw e; } },
        }));
        const res = await call(app, 'POST', '/panel/api/linkedin/login/start', {});
        assert.equal(res.status, 409, `expected 409 for ${code}`);
    }
});

test('POST /panel/api/linkedin/login/start: an unrecognized error code falls through to 500', async () => {
    const app = inject(baseDeps({
        loginController: { start: async () => { throw new Error('boom'); } },
    }));
    const res = await call(app, 'POST', '/panel/api/linkedin/login/start', {});
    assert.equal(res.status, 500);
});

test('POST /panel/api/linkedin/login/complete: 200 + verdict on success', async () => {
    const app = inject(baseDeps());
    const res = await call(app, 'POST', '/panel/api/linkedin/login/complete', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict.ok, true);
});

test('POST /panel/api/linkedin/login/complete: 409 (NOT_AWAITING) when nothing is in flight', async () => {
    const app = inject(baseDeps({
        loginController: { complete: async () => { const e = new Error('not awaiting'); e.code = 'NOT_AWAITING'; throw e; } },
    }));
    const res = await call(app, 'POST', '/panel/api/linkedin/login/complete', {});
    assert.equal(res.status, 409);
});

test('POST /panel/api/linkedin/login/cancel: 200, idempotent', async () => {
    const app = inject(baseDeps());
    const res = await call(app, 'POST', '/panel/api/linkedin/login/cancel', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'idle');
});
