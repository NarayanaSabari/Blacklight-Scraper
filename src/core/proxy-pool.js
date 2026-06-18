// Proxy pool for the 5 anti-bot-gated scrapers (dice/monster/indeed/glassdoor/
// techfetch). LinkedIn does NOT use this — it runs on a logged-in profile,
// direct.
//
// Goal: spread scrape traffic across a handful of static residential / ISP IPs
// so no single IP trips per-site velocity limits, and route AROUND an IP that
// gets a Cloudflare/DataDome block instead of stalling the whole pipeline.
//
// Model:
//   • One IP per scrape (round-robin). All of a scrape's pages go through it.
//   • On a `blocked` outcome the IP is put on a short cooldown and skipped.
//   • Correlation is per-platform: scrapers run 1-in-flight per platform, so
//     "the proxy last handed to platform X" is unambiguously X's current scrape.
//
// Config (creds NEVER committed): a git-ignored file `config/proxies.txt`, one
//   host:port:user:pass
// per line (the format ISP providers like Decodo hand out; password may contain
// ':'). Or env PROXY_LIST (newline/comma separated). No config → acquire()
// returns null and scrapers run direct, exactly as before.

import fs from 'node:fs';
import { createLogger } from '../logger/index.js';

const log = createLogger('proxy-pool');

const DEFAULT_FILE = 'config/proxies.txt';
function defaultCooldownMs(env = process.env) {
    const n = Number.parseInt(env.PROXY_BLOCK_COOLDOWN_MS, 10);
    return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000; // 10 min
}

// "host:port:user:pass" → Playwright-ready record. `pass` keeps any trailing
// ':' (some passwords contain them). user/pass optional (IP-whitelisted pools).
export function parseProxyLine(line) {
    const s = String(line ?? '').trim();
    if (!s || s.startsWith('#')) return null;
    const parts = s.split(':');
    if (parts.length < 2) return null;
    const [host, port, user] = parts;
    const password = parts.slice(3).join(':');
    if (!host || !port || !/^\d+$/.test(port)) return null;
    const rec = { id: `${host}:${port}`, server: `http://${host}:${port}` };
    if (user) rec.username = user;
    if (password) rec.password = password;
    return rec;
}

export function loadProxies(env = process.env, deps = {}) {
    const readFileSync = deps.readFileSync ?? ((p) => fs.readFileSync(p, 'utf8'));
    const existsSync = deps.existsSync ?? ((p) => fs.existsSync(p));
    let raw = '';
    if (env.PROXY_LIST && String(env.PROXY_LIST).trim()) {
        raw = String(env.PROXY_LIST).replace(/,/g, '\n');
    } else {
        const file = env.PROXY_LIST_FILE || DEFAULT_FILE;
        if (existsSync(file)) {
            try { raw = readFileSync(file); } catch { raw = ''; }
        }
    }
    const seen = new Set();
    const out = [];
    for (const rec of raw.split('\n').map(parseProxyLine)) {
        if (rec && !seen.has(rec.id)) { seen.add(rec.id); out.push(rec); }
    }
    return out;
}

export class ProxyPool {
    constructor(proxies = [], { cooldownMs, now = () => Date.now() } = {}) {
        this._proxies = proxies;
        this._cooldownMs = cooldownMs ?? defaultCooldownMs();
        this._now = now;
        this._rr = 0;
        this._cooledUntil = new Map();      // id -> timestamp
        this._lastByPlatform = new Map();   // platform -> id
    }

    get size() { return this._proxies.length; }
    _healthy(p) { const u = this._cooledUntil.get(p.id); return !u || u <= this._now(); }
    _playwright(p) {
        const o = { server: p.server };
        if (p.username) o.username = p.username;
        if (p.password) o.password = p.password;
        return o;
    }

    // A FIXED proxy (no rotation), defaulting to the first configured IP.
    // For warmed-profile flows where a manually-solved datadome cookie is bound
    // to one specific IP — the warm-up and the scrape MUST use the same exit IP.
    sticky(index = 0) {
        if (this._proxies.length === 0) return null;
        return this._playwright(this._proxies[index % this._proxies.length]);
    }

    // Returns a Playwright proxy object {server,username?,password?} or null
    // (empty pool). Round-robin, skipping cooled-down IPs; if every IP is
    // cooled, returns the one recovering soonest so we keep trying rather than
    // falling back to the (blocked) datacenter IP.
    acquire(platform = null) {
        const n = this._proxies.length;
        if (n === 0) return null;
        let chosen = null;
        for (let i = 0; i < n; i++) {
            const p = this._proxies[(this._rr + i) % n];
            if (this._healthy(p)) { chosen = p; this._rr = (this._rr + i + 1) % n; break; }
        }
        if (!chosen) {
            chosen = [...this._proxies].sort(
                (a, b) => (this._cooledUntil.get(a.id) ?? 0) - (this._cooledUntil.get(b.id) ?? 0),
            )[0];
            this._rr = (this._rr + 1) % n;
            log.warn('All proxies cooled down — reusing soonest-recovering', { proxy: chosen.id });
        }
        if (platform) this._lastByPlatform.set(platform, chosen.id);
        return this._playwright(chosen);
    }

    reportBlocked(platform) {
        const id = this._lastByPlatform.get(platform);
        if (!id) return;
        this._cooledUntil.set(id, this._now() + this._cooldownMs);
        log.warn('Proxy cooled down after block', { proxy: id, platform, cooldownMinutes: Math.round(this._cooldownMs / 60000) });
    }

    reportOk(platform) {
        const id = this._lastByPlatform.get(platform);
        if (id && this._cooledUntil.delete(id)) {
            log.info('Proxy recovered', { proxy: id, platform });
        }
    }

    stats() {
        const cooled = [...this._cooledUntil.values()].filter((u) => u > this._now()).length;
        return { total: this.size, cooled, healthy: this.size - cooled };
    }
}

let _singleton = null;
export function getProxyPool() {
    if (!_singleton) {
        _singleton = new ProxyPool(loadProxies());
        if (_singleton.size > 0) {
            log.info('Proxy pool loaded', { count: _singleton.size });
        }
    }
    return _singleton;
}
export function __resetProxyPoolForTest() { _singleton = null; }
