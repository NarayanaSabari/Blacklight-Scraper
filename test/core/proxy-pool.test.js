import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyLine, loadProxies, ProxyPool } from '../../src/core/proxy-pool.js';

test('parseProxyLine: host:port:user:pass → Playwright record', () => {
    const r = parseProxyLine('isp.decodo.com:10001:user-abc-country-us:p@ss~F');
    assert.deepEqual(r, {
        id: 'isp.decodo.com:10001',
        server: 'http://isp.decodo.com:10001',
        username: 'user-abc-country-us',
        password: 'p@ss~F',
    });
});

test('parseProxyLine: password may contain colons; blanks/comments → null', () => {
    assert.equal(parseProxyLine('h:8000:u:a:b:c').password, 'a:b:c');
    // host:port with no creds is valid (IP-whitelisted pools)
    assert.deepEqual(parseProxyLine('host:9999'), { id: 'host:9999', server: 'http://host:9999' });
    assert.equal(parseProxyLine(''), null);
    assert.equal(parseProxyLine('   '), null);
    assert.equal(parseProxyLine('# comment'), null);
    assert.equal(parseProxyLine('not-a-proxy'), null);
    assert.equal(parseProxyLine('host:notaport:u:p'), null);
});

test('loadProxies: from PROXY_LIST env (comma/newline), de-duped', () => {
    const env = { PROXY_LIST: 'h:1:u:p, h:2:u:p\nh:1:u:p' };
    const list = loadProxies(env, { existsSync: () => false });
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((p) => p.id), ['h:1', 'h:2']);
});

test('loadProxies: from file when no env; empty when neither', () => {
    const file = 'h:10:u:p\n# note\n\nh:11:u:p\n';
    const fromFile = loadProxies({ PROXY_LIST_FILE: 'x' }, { existsSync: () => true, readFileSync: () => file });
    assert.deepEqual(fromFile.map((p) => p.id), ['h:10', 'h:11']);
    assert.deepEqual(loadProxies({}, { existsSync: () => false }), []);
});

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: `ip${i}`, server: `http://ip${i}:80` }));

test('acquire: empty pool → null (scraper runs direct)', () => {
    assert.equal(new ProxyPool([]).acquire('dice'), null);
});

test('acquire: round-robin cycles through all IPs', () => {
    const pool = new ProxyPool(P(3));
    const seen = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()].map((p) => p.server);
    assert.deepEqual(seen, ['http://ip0:80', 'http://ip1:80', 'http://ip2:80', 'http://ip0:80']);
});

test('reportBlocked: cooled IP is skipped until cooldown expires', () => {
    let t = 1000;
    const pool = new ProxyPool(P(2), { cooldownMs: 500, now: () => t });
    assert.equal(pool.acquire('dice').server, 'http://ip0:80');   // last for dice = ip0
    pool.reportBlocked('dice');                                    // cool ip0
    // next acquires skip ip0 while cooled
    assert.equal(pool.acquire('dice').server, 'http://ip1:80');
    assert.equal(pool.acquire('dice').server, 'http://ip1:80');
    t += 600;                                                      // cooldown expired
    const servers = new Set([pool.acquire().server, pool.acquire().server]);
    assert.ok(servers.has('http://ip0:80'), 'ip0 back in rotation after cooldown');
});

test('reportOk: clears an IP cooldown early', () => {
    let t = 0;
    const pool = new ProxyPool(P(2), { cooldownMs: 10000, now: () => t });
    pool.acquire('monster');                 // ip0
    pool.reportBlocked('monster');           // cool ip0
    assert.equal(pool.stats().cooled, 1);
    pool.reportOk('monster');
    assert.equal(pool.stats().cooled, 0);
});

test('all cooled → reuses soonest-recovering rather than returning null', () => {
    let t = 0;
    const pool = new ProxyPool(P(2), { cooldownMs: 1000, now: () => t });
    pool.acquire('a'); pool.reportBlocked('a');   // ip0 cooled
    pool.acquire('b'); pool.reportBlocked('b');   // ip1 cooled
    const got = pool.acquire('c');
    assert.ok(got && got.server, 'still returns a proxy when all cooled');
});
