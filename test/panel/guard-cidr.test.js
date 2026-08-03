// CIDR allowlist behaviour for the panel guard.
//
// A bug here silently WIDENS access to endpoints that restart the process and
// spawn browsers, so the negative cases matter more than the positive one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAllowlist, isAllowedAddress, isLoopbackAddress } from '../../src/panel/guard.js';

const tailnet = parseAllowlist('100.64.0.0/10').matchers;

test('loopback is always allowed, even with an empty allowlist', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        assert.ok(isLoopbackAddress(address), `${address} must be loopback`);
        assert.ok(isAllowedAddress(address, []), `${address} must be allowed with no allowlist`);
    }
});

test('an empty allowlist rejects everything else', () => {
    for (const address of ['100.111.192.88', '192.168.1.10', '8.8.8.8']) {
        assert.equal(isAllowedAddress(address, []), false, `${address} must be rejected`);
    }
});

test('the Tailscale CGNAT range admits tailnet peers', () => {
    // m1's own tailnet address, plus the range boundaries.
    for (const address of ['100.111.192.88', '100.64.0.0', '100.127.255.255']) {
        assert.ok(isAllowedAddress(address, tailnet), `${address} should be admitted`);
    }
});

test('the Tailscale range does NOT admit the LAN, RFC1918, or public addresses', () => {
    const rejected = [
        '192.168.1.10',   // typical home LAN
        '10.0.0.5',       // RFC1918
        '172.16.0.5',     // RFC1918
        '100.63.255.255', // one below the CGNAT range
        '100.128.0.0',    // one above the CGNAT range
        '8.8.8.8',        // public
    ];
    for (const address of rejected) {
        assert.equal(isAllowedAddress(address, tailnet), false, `${address} must be rejected`);
    }
});

test('IPv4-mapped IPv6 peers are normalised before matching', () => {
    // Express reports IPv4 peers on a dual-stack listener in this form.
    assert.ok(isAllowedAddress('::ffff:100.111.192.88', tailnet));
    assert.equal(isAllowedAddress('::ffff:192.168.1.10', tailnet), false);
});

test('malformed addresses are rejected rather than coerced', () => {
    for (const address of [null, undefined, '', 'not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5']) {
        assert.equal(isAllowedAddress(address, tailnet), false, `${String(address)} must be rejected`);
    }
});

test('unparseable allowlist entries are dropped, not treated as wildcards', () => {
    const { matchers, invalid } = parseAllowlist('garbage, 100.64.0.0/10, 1.2.3.4/99, /8');
    assert.deepEqual(invalid, ['garbage', '1.2.3.4/99', '/8']);
    assert.equal(matchers.length, 1);
    // The one good entry still works; the bad ones did not widen anything.
    assert.ok(isAllowedAddress('100.111.192.88', matchers));
    assert.equal(isAllowedAddress('8.8.8.8', matchers), false);
});

test('a bare address is treated as /32, not as a wider network', () => {
    const single = parseAllowlist('100.111.192.88').matchers;
    assert.ok(isAllowedAddress('100.111.192.88', single));
    assert.equal(isAllowedAddress('100.111.192.89', single), false);
});

test('/0 is honoured explicitly rather than silently mis-masking', () => {
    // Not a recommended config, but it must behave predictably if someone sets it.
    const everything = parseAllowlist('0.0.0.0/0').matchers;
    assert.ok(isAllowedAddress('8.8.8.8', everything));
});
