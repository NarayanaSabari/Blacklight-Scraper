// LinkedIn egress binding: the credential's cookie and its requests must
// leave from the same IP.
//
// Regression cover for the split-IP configuration found in production on
// 2026-08-18: Link1 carried a Decodo proxy (used at LOGIN, via Playwright) but
// the RSC transport called global fetch, so every search egressed on the host
// IP. Link1 was the hardest-hit account; Link2, whose login and scrape agreed,
// was visibly healthier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    proxyUrlFor, agentFor, fetchForCredential, redactProxy, __resetEgressAgentsForTest,
} from '../../src/scrapers/linkedin-rsc/egress.js';

test('a stored host:port:user:pass proxy becomes a usable proxy URL', () => {
    // The exact shape held in scraper_credentials.proxy in production.
    assert.equal(
        proxyUrlFor('isp.decodo.com:10001:spuser:secret'),
        'http://spuser:secret@isp.decodo.com:10001',
    );
});

test('proxy credentials are URL-encoded', () => {
    // ISP passwords routinely contain ':' and '@'; unencoded they would corrupt
    // the userinfo section and silently send requests somewhere else.
    const url = proxyUrlFor('host:8080:user@name:p@ss:word');
    assert.equal(url, 'http://user%40name:p%40ss%3Aword@host:8080');
    assert.equal(new URL(url).hostname, 'host', 'host must survive intact');
});

test('a full proxy URL passes through unchanged', () => {
    assert.equal(
        proxyUrlFor('http://u:p@proxy.example:3128'),
        'http://u:p@proxy.example:3128',
    );
});

test('an IP-whitelisted proxy with no credentials works', () => {
    assert.equal(proxyUrlFor('host:8080'), 'http://host:8080');
});

test('no proxy means direct egress', () => {
    for (const empty of [null, undefined, '', '   ']) {
        assert.equal(proxyUrlFor(empty), null);
        assert.equal(agentFor(empty), null);
    }
});

test('agents are cached per proxy, not rebuilt per request', () => {
    // A fresh connection pool per request would defeat keep-alive and make TLS
    // churn a signal in itself.
    __resetEgressAgentsForTest();
    let built = 0;
    const factory = (url) => ({ url, id: ++built });
    const a = agentFor('host:1:u:p', { factory });
    const b = agentFor('host:1:u:p', { factory });
    assert.equal(a, b);
    assert.equal(built, 1);
    const c = agentFor('other:2:u:p', { factory });
    assert.notEqual(a, c);
    assert.equal(built, 2);
});

test('a credential WITH a proxy AND a profile_key uses that proxy', async () => {
    __resetEgressAgentsForTest();
    const seen = [];
    const agent = { marker: 'decodo' };
    const boundFetch = fetchForCredential(
        { proxy: 'isp.decodo.com:10001:u:p', profile_key: 'li-acct-1' },
        { baseFetch: async (url, init) => { seen.push({ url, init }); return { ok: true }; },
            factory: () => agent },
    );
    await boundFetch('https://www.linkedin.com/x', { method: 'POST', body: '{}' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.dispatcher, agent, 'request must be bound to the proxy agent');
    assert.equal(seen[0].init.method, 'POST', 'existing init options must survive');
    assert.equal(seen[0].init.body, '{}');
});

test('a credential with NO proxy uses the base fetch untouched', async () => {
    __resetEgressAgentsForTest();
    const baseFetch = async () => ({ ok: true });
    // Identity, not just behaviour: the direct path must be byte-identical to
    // what it was before this module existed.
    assert.equal(fetchForCredential({ proxy: null }, { baseFetch }), baseFetch);
    assert.equal(fetchForCredential(null, { baseFetch }), baseFetch);
    assert.equal(fetchForCredential(undefined, { baseFetch }), baseFetch);
});

test('a proxy WITHOUT a profile_key is ignored — that account logged in direct', () => {
    // This is production's Link1, and getting it wrong is worse than doing
    // nothing. openLoginBrowser() routes an UNKEYED credential to the legacy
    // launcher, which takes no proxy argument, so Link1's cookie was minted on
    // the host IP no matter what its proxy column says. Replaying that cookie
    // through Decodo would manufacture the exact login-IP != scrape-IP split
    // this module exists to remove.
    __resetEgressAgentsForTest();
    const baseFetch = async () => ({ ok: true });
    const built = [];
    const bound = fetchForCredential(
        { proxy: 'isp.decodo.com:10001:u:p', profile_key: null },
        { baseFetch, factory: (u) => { built.push(u); return { u }; } },
    );
    assert.equal(bound, baseFetch, 'must stay on the IP the cookie was minted on');
    assert.deepEqual(built, [], 'no proxy agent should even be constructed');
});

test('the two production credential shapes resolve as expected', () => {
    // Link1: proxy, no profile_key  -> direct (cookie minted direct)
    // Link2: profile_key, no proxy  -> direct (no proxy configured at all)
    __resetEgressAgentsForTest();
    const baseFetch = async () => ({ ok: true });
    const link1 = { name: 'Link1', proxy: 'isp.decodo.com:10001:u:p', profile_key: null };
    const link2 = { name: 'Link2', proxy: null, profile_key: 'li-acct-2' };
    assert.equal(fetchForCredential(link1, { baseFetch }), baseFetch);
    assert.equal(fetchForCredential(link2, { baseFetch }), baseFetch);
});

// ─── wiring into scrapeLinkedInRsc ──────────────────────────────────────

test('the credential proxy reaches paginate, and the canary probe too', async () => {
    // The end the incident actually turns on: a credential carrying a proxy
    // must not have its searches leave on the host IP. Both the scrape and the
    // canary probe are checked, because a probe on a different egress path
    // would judge the account by a request it never would have made.
    const { scrapeLinkedInRsc } = await import('../../src/scrapers/linkedin-rsc/scraper.js');
    const { CanaryTracker } = await import('../../src/scrapers/linkedin-rsc/canary.js');
    __resetEgressAgentsForTest();

    const lease = {
        credential: { profile_key: 'acct-a', proxy: 'isp.decodo.com:10001:u:p' },
        reportSuccess: async () => {},
    };
    const session = {
        async withCookies(_id, fn) {
            return fn([{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }], lease);
        },
    };

    const fetchImpls = [];
    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session,
        template: { url: 'https://x', headers: {}, postData: '{}' },
        highWater: { get: () => null, advance: () => {} },
        canaryTracker: new CanaryTracker({ threshold: 1 }),
        paginateImpl: async ({ fetchImpl }) => {
            fetchImpls.push(fetchImpl);
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
        runCanaryImpl: async ({ fetchImpl, paginateImpl }) => {
            await paginateImpl({ fetchImpl, keywords: 'hiring' });
            return 'suspected';
        },
    });

    assert.equal(fetchImpls.length, 2, 'one scrape call and one canary probe');
    assert.ok(fetchImpls[0], 'the scrape must be given a proxy-bound fetch');
    assert.notEqual(fetchImpls[0], globalThis.fetch, 'must not fall back to host egress');
    assert.equal(fetchImpls[1], fetchImpls[0], 'the probe must share the scrape egress');
});

test('a credential with no proxy still reaches the wire on global fetch', async () => {
    const { scrapeLinkedInRsc } = await import('../../src/scrapers/linkedin-rsc/scraper.js');
    const { CanaryTracker } = await import('../../src/scrapers/linkedin-rsc/canary.js');
    __resetEgressAgentsForTest();

    const lease = { credential: { profile_key: 'acct-b', proxy: null }, reportSuccess: async () => {} };
    let seen;
    await scrapeLinkedInRsc('Data Engineer', 'US', null, {
        session: {
            async withCookies(_id, fn) {
                return fn([{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }], lease);
            },
        },
        template: { url: 'https://x', headers: {}, postData: '{}' },
        canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
        paginateImpl: async ({ fetchImpl }) => {
            seen = fetchImpl;
            return { posts: [], emptyConfirmed: true, pages: [] };
        },
    });
    assert.equal(seen, globalThis.fetch, 'direct egress must be unchanged');
});


// ─── malformed configuration must degrade, not crash ────────────────────

test('an unusable proxy falls back to direct egress instead of killing the scrape', () => {
    // parseProxyLine accepts anything with a numeric port, so a typo like
    // `host:99999:u:p` yields a syntactically fine string that ProxyAgent
    // rejects as an Invalid URL. That throw happens INSIDE the scrape, after
    // the credential is leased: a one-character config typo would become a
    // failed session and, with strictEmpty, a platform marked failed.
    __resetEgressAgentsForTest();
    const baseFetch = async () => ({ ok: true });
    const bound = fetchForCredential(
        { id: 1, profile_key: 'k', proxy: 'host:99999:u:p' },   // port out of range
        { baseFetch },
    );
    assert.equal(bound, baseFetch, 'must degrade to direct egress, not throw');
});

test('agentFor never throws on a malformed proxy', () => {
    __resetEgressAgentsForTest();
    for (const bad of ['host:99999:u:p', 'host:0:u:p', ':::::']) {
        assert.doesNotThrow(() => agentFor(bad), `agentFor threw on ${bad}`);
    }
});

test('the proxy-failure log never leaks credentials', () => {
    // The proxy string carries user and password in the same field, so the
    // failure path must not echo it back.
    const red = redactProxy('isp.decodo.com:10001:secretuser:secretpass');
    assert.equal(red, 'isp.decodo.com:10001');
    assert.ok(!red.includes('secretuser') && !red.includes('secretpass'));
    assert.equal(redactProxy(null), '(none)');
    assert.equal(redactProxy('http://u:p@host:8080'), 'host:8080', 'URL form is redacted too');
});
