import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerHealthRoute } from '../../src/routes/health.js';

const bootInfo = {
    pid: 4242, gitSha: 'abc1234', bootedAt: '2026-06-03T00:00:00.000Z',
    nodeVersion: 'v24.5.0', pkgVersion: '2.0.0',
    profileDir: '/tmp/li-profile', headless: false, strict: false,
};

function inject(deps) {
    const app = express();
    registerHealthRoute(app, 3001, { bootInfo, ...deps });
    return app;
}

function callHandler(app, urlPath) {
    return new Promise((resolve) => {
        const url = new URL(urlPath, 'http://localhost');
        const req = { method: 'GET', url: urlPath, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: {} };
        const res = {
            statusCode: 200, _headers: {},
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(o) { resolve({ status: this.statusCode, body: o }); return this; },
            end() { resolve({ status: this.statusCode, body: null }); },
        };
        app.handle(req, res, () => resolve({ status: 404, body: null }));
    });
}

test('GET /health/linkedin (no probe flag): returns hint, no work', async () => {
    let called = false;
    const session = { isAlive: () => true, lease: null, withPage: async () => { called = true; return null; } };
    const app = inject({ getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, '/health/linkedin');
    assert.equal(status, 200);
    assert.equal(body.probe, false);
    assert.match(body.hint, /probe=1/);
    assert.equal(called, false);
});

test('GET /health/linkedin?probe=1: authed feed page → loggedIn:true', async () => {
    const session = {
        isAlive: () => true, lease: null,
        withPage: async (sid, fn) => fn({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }),
    };
    const app = inject({ getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, '/health/linkedin?probe=1');
    assert.equal(status, 200);
    assert.equal(body.probe, true);
    assert.equal(body.loggedIn, true);
    assert.equal(body.urlClass, 'authed');
});

test('GET /health/linkedin?probe=1: login redirect → loggedIn:false', async () => {
    const session = {
        isAlive: () => true, lease: null,
        withPage: async (sid, fn) => fn({ goto: async () => {}, url: () => 'https://www.linkedin.com/login?session_redirect=...' }),
    };
    const app = inject({ getLinkedInSession: () => session });
    const { body } = await callHandler(app, '/health/linkedin?probe=1');
    assert.equal(body.loggedIn, false);
    assert.equal(body.urlClass, 'login');
});

test('GET /health/linkedin?probe=1: withPage throws → 503', async () => {
    const session = {
        isAlive: () => false, lease: null,
        withPage: async () => { throw new Error('browser dead'); },
    };
    const app = inject({ getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, '/health/linkedin?probe=1');
    assert.equal(status, 503);
    assert.equal(body.loggedIn, false);
    assert.match(body.error, /browser dead/);
});
