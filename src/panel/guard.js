// Access guard for the /panel routes.
//
// server.js calls `app.listen(config.port)` with no host argument, so Express
// binds 0.0.0.0 — every existing route (/, /healthz, /metrics, /scrape,
// /scrape-queue) is reachable from any interface on the host's network. The
// control panel adds POST endpoints that pause platforms, restart the process,
// and spawn a headed LinkedIn login, so it is gated to an explicit address
// allowlist applied to every `/panel*` route (and only those routes).
//
// The default is loopback only. A host may widen it via PANEL_ALLOWED_CIDRS,
// a comma-separated CIDR list, so that e.g. a Tailscale tailnet can reach the
// panel directly without an SSH tunnel:
//
//     set PANEL_ALLOWED_CIDRS=100.64.0.0/10
//
// 100.64.0.0/10 is the CGNAT range Tailscale assigns, so that value admits
// tailnet peers while still rejecting the local LAN (192.168.x / 10.x) and
// anything else that can route to the port. Loopback is ALWAYS allowed and
// cannot be configured away — the panel must keep working over an SSH tunnel
// regardless of what the allowlist says.
//
// This is an address allowlist, not authentication. Widening it trusts every
// device on the admitted range, and these endpoints restart the process. Keep
// it as narrow as the access you actually need.

import { createLogger } from '../logger/index.js';

const log = createLogger('panel:guard');

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address) {
    return LOOPBACK_ADDRESSES.has(String(address ?? ''));
}

// Express reports IPv4 peers on a dual-stack listener as IPv4-mapped IPv6
// (`::ffff:100.111.192.88`). Normalise so CIDR matching sees a bare IPv4.
function normalizeAddress(address) {
    const raw = String(address ?? '').trim();
    return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

function ipv4ToInt(ip) {
    const octets = ip.split('.');
    if (octets.length !== 4) return null;
    let value = 0;
    for (const octet of octets) {
        if (!/^\d{1,3}$/.test(octet)) return null;
        const n = Number(octet);
        if (n > 255) return null;
        value = (value * 256) + n;
    }
    return value;
}

// Returns a predicate, or null when the entry is unparseable — an unparseable
// entry must NOT silently widen access, so callers drop it and log.
function parseCidr(entry) {
    const trimmed = String(entry ?? '').trim();
    if (!trimmed) return null;

    const [network, prefixPart] = trimmed.split('/');
    const base = ipv4ToInt(network);
    if (base === null) return null;

    const prefix = prefixPart === undefined ? 32 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

    // `>>> 0` keeps the mask unsigned; a /0 shift by 32 is undefined in JS.
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const networkAddress = (base & mask) >>> 0;

    return (candidate) => ((candidate & mask) >>> 0) === networkAddress;
}

export function parseAllowlist(raw) {
    const matchers = [];
    const invalid = [];
    for (const entry of String(raw ?? '').split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const matcher = parseCidr(trimmed);
        if (matcher) matchers.push({ cidr: trimmed, matches: matcher });
        else invalid.push(trimmed);
    }
    return { matchers, invalid };
}

export function isAllowedAddress(address, matchers = []) {
    if (isLoopbackAddress(address)) return true;
    const asInt = ipv4ToInt(normalizeAddress(address));
    if (asInt === null) return false;
    return matchers.some((m) => m.matches(asInt));
}

const { matchers: ALLOWED, invalid: INVALID } = parseAllowlist(process.env.PANEL_ALLOWED_CIDRS);

if (INVALID.length > 0) {
    log.error('Ignoring unparseable PANEL_ALLOWED_CIDRS entries', { invalid: INVALID });
}
if (ALLOWED.length > 0) {
    // Logged at boot so a widened panel is auditable from the logs alone.
    log.warn('Panel reachable beyond loopback', { allowedCidrs: ALLOWED.map((m) => m.cidr) });
}

export function panelAccessGuard(req, res, next) {
    const remoteAddress = req.socket?.remoteAddress;
    if (isAllowedAddress(remoteAddress, ALLOWED)) {
        next();
        return;
    }
    log.warn('Rejected panel request from a non-allowlisted address', {
        remoteAddress: remoteAddress ?? 'unknown',
        path: req.originalUrl ?? req.url,
    });
    res.status(403).json({
        success: false,
        error: 'The control panel is not reachable from this address. '
            + 'Use localhost on the host, an SSH tunnel, or add this network to PANEL_ALLOWED_CIDRS.',
    });
}
