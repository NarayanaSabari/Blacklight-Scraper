import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerHealthRoute } from '../../src/routes/health.js';

function inject(deps) {
    const app = express();
    registerHealthRoute(app, 3001, deps);
    return app;
}

function callHandler(app, method, urlPath) {
    return new Promise((resolve) => {
        const req = { method, url: urlPath, query: {}, headers: {} };
        const url = new URL(urlPath, 'http://localhost');
        req.path = url.pathname;
        req.query = Object.fromEntries(url.searchParams);
        const chunks = [];
        const res = {
            statusCode: 200,
            _headers: {},
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(o) { chunks.push(JSON.stringify(o)); resolve({ status: this.statusCode, body: JSON.parse(chunks[0]) }); return this; },
            end() { resolve({ status: this.statusCode, body: null }); },
        };
        app.handle(req, res, () => resolve({ status: 404, body: null }));
    });
}

const bootInfo = {
    pid: 4242, gitSha: 'abc1234', bootedAt: '2026-06-03T00:00:00.000Z',
    nodeVersion: 'v24.5.0', pkgVersion: '2.0.0',
    profileDir: '/tmp/li-profile', headless: false, strict: false,
};

test('GET /healthz: returns bootInfo + session state + uptime', async () => {
    const session = { isAlive: () => true, lease: { credential: { id: 'cred-7' } } };
    const app = inject({ bootInfo, getLinkedInSession: () => session });
    const { status, body } = await callHandler(app, 'GET', '/healthz');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.gitSha, 'abc1234');
    assert.equal(body.profileDir, '/tmp/li-profile');
    assert.equal(body.sessionAlive, true);
    assert.equal(body.leaseCredentialId, 'cred-7');
    assert.equal(body.headless, false);
    assert.equal(typeof body.uptimeSec, 'number');
});

test('GET /healthz: handles dead session + no lease', async () => {
    const session = { isAlive: () => false, lease: null };
    const app = inject({ bootInfo, getLinkedInSession: () => session });
    const { body } = await callHandler(app, 'GET', '/healthz');
    assert.equal(body.sessionAlive, false);
    assert.equal(body.leaseCredentialId, null);
});

test('GET /: legacy welcome route still works + surfaces gitSha', async () => {
    const app = inject({ bootInfo, getLinkedInSession: () => ({ isAlive: () => true, lease: null }) });
    const { status, body } = await callHandler(app, 'GET', '/');
    assert.equal(status, 200);
    assert.equal(body.status, 'Unified Job Scraper API is running');
    assert.equal(body.gitSha, 'abc1234');
});
