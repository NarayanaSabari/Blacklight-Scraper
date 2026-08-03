import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelAccessGuard, isLoopbackAddress } from '../../src/panel/guard.js';

function fakeReqRes(remoteAddress) {
    const req = { socket: { remoteAddress }, originalUrl: '/panel/api/status' };
    const res = {
        statusCode: 200,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
    };
    return { req, res };
}

test('isLoopbackAddress: recognizes IPv4, IPv6, and IPv4-mapped IPv6 loopback', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('10.0.1.5'), false);
    assert.equal(isLoopbackAddress(undefined), false);
});

test('panelAccessGuard: calls next() for a loopback connection', () => {
    const { req, res } = fakeReqRes('127.0.0.1');
    let nextCalled = false;
    panelAccessGuard(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
});

test('panelAccessGuard: rejects a non-loopback connection with 403 JSON', () => {
    const { req, res } = fakeReqRes('10.0.1.5');
    let nextCalled = false;
    panelAccessGuard(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
});

test('panelAccessGuard: rejects when remoteAddress is missing entirely', () => {
    const { req, res } = fakeReqRes(undefined);
    let nextCalled = false;
    panelAccessGuard(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
});
