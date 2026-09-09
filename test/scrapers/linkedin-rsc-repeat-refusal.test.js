// Regression: LinkedIn's "refusal of a repeated query" must not be read as a
// shadow ban.
//
// PRODUCTION INCIDENT (2026-08-18, prod DB)
//   Link2  last_success_at  06:29:29.374+00
//          banned_at        06:29:33.541+00   ← 4.2 SECONDS after a success
//   Both LinkedIn credentials ended in a 4h cooldown, `linkedin_available` hit
//   0, and the pipeline went to a hard zero with 550 queue rows pending.
//
// WHY IT HAPPENED
//   #492 gave each search a high-water mark, so a steady-state sweep asks for
//   "posts newer than X" and legitimately finds nothing new. LinkedIn answers a
//   repeated identical search with a positive "no results" flag, which arrives
//   as `emptyConfirmed: true` with ZERO rows on the page. With no rows,
//   paginate() cannot set `upToDate` (it needs to have seen a known post), so
//   the scrape looks identical to a shadow-banned account's polite empty and
//   feeds the ban counter. Ten of those in a row — which on a 15-minute cadence
//   over 154 queue rows takes seconds, not hours — trips the canary.
//
// THE INVARIANT
//   A confirmed-empty response for a search that HAS a high-water mark is
//   evidence the account is being served normally: LinkedIn positively answered
//   "nothing newer than the mark you already hold". That is a health signal, not
//   a ban signal, and it must never contribute to a ban verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';
import { CanaryTracker } from '../../src/scrapers/linkedin-rsc/canary.js';

const TEMPLATE = { url: 'https://x', headers: {}, postData: '{}' };

function fakeSession(lease) {
    return {
        async withCookies(_sessionId, fn) {
            return fn(
                [{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }],
                lease,
            );
        },
    };
}

// A store that reports a mark for every query, i.e. the steady state after
// #492 has run each search at least once.
const markedStore = {
    get: () => '7487914656553025536',
    advance: () => {},
};

test('a confirmed-empty sweep WITH a high-water mark is health, not a ban signal', async () => {
    // The exact production shape: LinkedIn positively says "no results" for a
    // repeated search, and the page carries no rows so `upToDate` is false.
    const lease = { credential: { profile_key: 'acct-a', name: 'Link2' }, reportSuccess: async () => {} };
    const tracker = new CanaryTracker({ threshold: 10 });

    for (let i = 0; i < 30; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('Business Analyst', 'United States', null, {
            session: fakeSession(lease),
            template: TEMPLATE,
            highWater: markedStore,
            canaryTracker: tracker,
            paginateImpl: async () => ({
                posts: [], emptyConfirmed: true, upToDate: false, pages: [], newestActivityId: null,
            }),
            runCanaryImpl: async () => {
                throw new Error('canary must never fire for a repeated-query refusal');
            },
        });
    }

    assert.equal(
        tracker.streak(lease), 0,
        'repeated-query refusals must not accumulate toward a ban verdict',
    );
});

test('a confirmed-empty sweep with NO mark still counts toward the ban verdict', async () => {
    // Without a mark we asked for the full 24h window and LinkedIn said there
    // is nothing at all. That IS the shadow-ban signature and must still count,
    // or the detector the canary exists to provide would be defeated entirely.
    const lease = { credential: { profile_key: 'acct-b', name: 'B' }, reportSuccess: async () => {} };
    const tracker = new CanaryTracker({ threshold: 10 });
    const unmarkedStore = { get: () => null, advance: () => {} };

    for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('Business Analyst', 'United States', null, {
            session: fakeSession(lease),
            template: TEMPLATE,
            highWater: unmarkedStore,
            canaryTracker: tracker,
            paginateImpl: async () => ({
                posts: [], emptyConfirmed: true, upToDate: false, pages: [], newestActivityId: null,
            }),
            runCanaryImpl: async () => 'healthy',
        });
    }

    assert.equal(tracker.streak(lease), 5, 'a true zero-result window is still evidence');
});

test('a success ping is never followed by a ban verdict in the same scrape', async () => {
    // Guards the literal production signature: last_success_at 06:29:29 and a
    // ban 4.2s later. Whatever the verdict logic decides, a scrape that reports
    // the credential healthy must not also report it failed.
    const calls = [];
    const lease = {
        credential: { profile_key: 'acct-a', name: 'Link2' },
        reportSuccess: async () => calls.push('success'),
        reportFailure: async () => calls.push('failure'),
    };

    await scrapeLinkedInRsc('Business Analyst', 'United States', null, {
        session: fakeSession(lease),
        template: TEMPLATE,
        highWater: markedStore,
        canaryTracker: new CanaryTracker({ threshold: 1 }),
        paginateImpl: async () => ({
            posts: [], emptyConfirmed: true, upToDate: false, pages: [], newestActivityId: null,
        }),
        runCanaryImpl: async ({ lease: l }) => { await l.reportFailure(); return 'shadow_banned'; },
    });

    assert.ok(
        !(calls.includes('success') && calls.includes('failure')),
        `a scrape reported both success and failure: ${calls.join(' then ')}`,
    );
});

// ─── against the REAL transport, not a stub ─────────────────────────────

test('a real captured no-results payload produces the production shape', async () => {
    // Everything above injects a fake paginateImpl, so it proves the DECISION
    // logic and not the INPUT to it. This fix is gated on
    // `emptyConfirmed && sinceActivityId !== null`, so if LinkedIn's
    // steady-state refusal did not actually carry the no-results marker, the
    // whole fix would be inert and the accounts would keep getting banned.
    //
    // Real paginate(), real extractPosts(), real NO_RESULTS_RE, real captured
    // flight payload. Only the socket is faked.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { paginate } = await import('../../src/scrapers/linkedin-rsc/client.js');

    const body = fs.readFileSync(
        path.join(import.meta.dirname, '../fixtures/linkedin-rsc-no-results.txt'), 'utf8',
    );
    const result = await paginate({
        template: { url: 'https://x', headers: { 'user-agent': 'x' }, postData: '{}' },
        cookies: [{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"ajax:1"' }],
        keywords: 'Business Analyst',
        sinceActivityId: '7487914656553025536',   // steady state: a mark exists
        fetchImpl: async () => ({ status: 200, text: async () => body }),
        delay: async () => {},
    });

    assert.equal(result.posts.length, 0);
    assert.equal(result.emptyConfirmed, true, 'the marker must be detected on a real payload');
    assert.equal(result.upToDate, false, 'no rows means upToDate cannot be set — the whole bug');

    // Which is precisely the combination the scraper now reads as health.
    const refusedRepeat = result.emptyConfirmed && true;
    assert.ok(refusedRepeat, 'the production shape must satisfy the health gate');
});

test('a real payload WITH posts is not mistaken for a refusal', async () => {
    // The other side: a populated response must not accidentally trip the
    // health gate, or a genuinely banned account would look fine forever.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { paginate } = await import('../../src/scrapers/linkedin-rsc/client.js');

    const body = fs.readFileSync(
        path.join(import.meta.dirname, '../fixtures/linkedin-rsc-search.txt'), 'utf8',
    );
    const result = await paginate({
        template: { url: 'https://x', headers: { 'user-agent': 'x' }, postData: '{}' },
        cookies: [{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"ajax:1"' }],
        keywords: 'Business Analyst',
        maxPosts: 100,
        fetchImpl: async () => ({ status: 200, text: async () => body }),
        delay: async () => {},
    });

    assert.ok(result.posts.length > 0, 'real search payload must yield posts');
    assert.equal(result.emptyConfirmed, false, 'a populated page is never a confirmed empty');
});

// ─── end-to-end: real transport, both verdicts ──────────────────────────

async function realPaginate(args, body) {
    const { paginate } = await import('../../src/scrapers/linkedin-rsc/client.js');
    return paginate({
        ...args,
        fetchImpl: async () => ({ status: 200, text: async () => body }),
        delay: async () => {},
    });
}

function noResultsBody() {
    // eslint-disable-next-line global-require
    return import('node:fs').then(async (fs) => {
        const path = await import('node:path');
        return fs.readFileSync(
            path.join(import.meta.dirname, '../fixtures/linkedin-rsc-no-results.txt'), 'utf8',
        );
    });
}

test('60 real steady-state sweeps never ban a healthy account', async () => {
    // The end-to-end claim, through real paginate() and real extract(): the
    // production condition (marked query + LinkedIn no-results payload) must be
    // survivable indefinitely. On main this banned within 10 sweeps.
    const body = await noResultsBody();
    const tracker = new CanaryTracker({ threshold: 10 });
    let bans = 0;
    const lease = {
        credential: { profile_key: 'steady', name: 'Link1' },
        reportSuccess: async () => {},
        reportFailure: async () => { bans += 1; },
    };
    const marked = { get: () => '7487914656553025536', advance: () => {} };

    for (let i = 0; i < 60; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('Business Analyst', 'United States', null, {
            session: fakeSession(lease),
            template: { url: 'https://x', headers: { 'user-agent': 'x' }, postData: '{}' },
            highWater: marked,
            canaryTracker: tracker,
            pacer: null,
            paginateImpl: (args) => realPaginate(args, body),
        });
    }

    assert.equal(bans, 0, 'a healthy up-to-date account must never be banned');
    assert.equal(tracker.streak(lease), 0);
});

test('a genuine ban signature is still caught end to end', async () => {
    // The other half of the contract. No high-water mark means we asked for the
    // whole 24h window and LinkedIn returned nothing — that IS a ban, and
    // loosening the false-positive path must not blind the detector.
    const body = await noResultsBody();
    const tracker = new CanaryTracker({ threshold: 10, probeIntervalMs: 0 });
    const messages = [];
    const lease = {
        credential: { profile_key: 'banned', name: 'Banned' },
        reportSuccess: async () => {},
        reportFailure: async (msg) => { messages.push(msg); },
    };
    const unmarked = { get: () => null, advance: () => {} };

    for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('Business Analyst', 'United States', null, {
            session: fakeSession(lease),
            template: { url: 'https://x', headers: { 'user-agent': 'x' }, postData: '{}' },
            highWater: unmarked,
            canaryTracker: tracker,
            pacer: null,
            paginateImpl: (args) => realPaginate(args, body),
        });
    }

    assert.ok(messages.length > 0, 'a genuinely dark account must still be reported');
    assert.match(messages[0], /corroborating probes/, 'and only on corroborated evidence');
});

// ─── scraped work must survive bookkeeping failures ─────────────────────

test('a failed liveness ping must not discard already-scraped jobs', async () => {
    // reportSuccess() is bookkeeping: it tells the pool the credential is
    // alive. The jobs are ALREADY scraped when it runs, and the orchestrator
    // submits them after this function returns — so letting it throw binned
    // completed work over a status call.
    //
    // Verified pre-fix: with reportSuccess throwing "backend down", a scrape
    // carrying a real post threw and the post never reached the backend. That
    // is the same class of loss the HTTP client already guards against by
    // exempting submitJobs from the circuit breaker.
    const POST = {
        activity_id: '7487914656553025999',
        post_url: 'https://www.linkedin.com/posts/x_y-7487914656553025999-Ab',
        text: 'Hiring a Java developer, W2, remote',
        author_handle: 'x',
        posted_at: null,
    };
    const lease = {
        credential: { id: 1 },
        reportSuccess: async () => { throw new Error('backend down'); },
    };

    const result = await scrapeLinkedInRsc('Business Analyst', 'US', null, {
        session: fakeSession(lease),
        template: TEMPLATE,
        highWater: { get: () => null, advance: () => {} },
        canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
        pacer: null,
        paginateImpl: async () => ({
            posts: [POST], emptyConfirmed: false, pages: [], newestActivityId: POST.activity_id,
        }),
    });

    assert.equal(result.jobs.length, 1, 'scraped work must survive a bookkeeping failure');
});

test('a lease with no reportSuccess at all is tolerated', async () => {
    // Local mode and hand-built leases have no reportSuccess. The optional
    // chain already covered this; pinning it so the new try/catch cannot
    // regress it.
    const result = await scrapeLinkedInRsc('Business Analyst', 'US', null, {
        session: fakeSession({ credential: { id: 2 } }),
        template: TEMPLATE,
        highWater: { get: () => '123', advance: () => {} },
        canaryTracker: new CanaryTracker({ threshold: Number.MAX_SAFE_INTEGER }),
        pacer: null,
        paginateImpl: async () => ({ posts: [], emptyConfirmed: true, pages: [] }),
    });
    assert.deepEqual(result.jobs, []);
});

// ─── platform-wide search quota ─────────────────────────────────────────

// The quota back-off and the ban canary read the SAME observation and must
// reach OPPOSITE conclusions from it. A confirmed-empty on a marked query means
// "this account is fine" (no ban) but also "search returned nothing" (feeds the
// quota streak). Getting that backwards is not theoretical: the first version
// of the quota feature shipped to production reusing the canary's health test,
// and was completely inert as a result.
test('a marked-query refusal feeds the quota streak while still NOT banning the account', async () => {
    const body = await noResultsBody();
    const { SearchQuotaTracker } = await import('../../src/scrapers/linkedin-rsc/search-quota.js');

    // Threshold of 5 keeps the test quick; the real value is 25.
    const quotaTracker = new SearchQuotaTracker({ threshold: 5 });
    const canaryTracker = new CanaryTracker({ threshold: 10, probeIntervalMs: 0 });

    const bans = [];
    const lease = {
        credential: { id: 15, name: 'Link1' },
        reportSuccess: async () => {},
        reportFailure: async (msg) => { bans.push(msg); },
    };

    const pauses = [];

    // Every sweep carries a mark - the exact production steady state, and the
    // shape that made the first implementation inert.
    for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scrapeLinkedInRsc('Business Analyst', 'United States', null, {
            session: fakeSession(lease),
            template: TEMPLATE,
            highWater: markedStore,
            canaryTracker,
            quotaTracker,
            pacer: null,
            applyQuotaPauseImpl: ({ pauseMs }) => { pauses.push(pauseMs); return true; },
            paginateImpl: (args) => realPaginate(args, body),
        });
    }

    // The quota side must have noticed. On the broken version this array was
    // empty because the streak reset on every single scrape.
    assert.equal(pauses.length, 1, 'the quota back-off must fire exactly once');
    assert.ok(pauses[0] > 0, 'and request a real pause');

    // The ban side must NOT have. This is the 2026-08-18 invariant, still held.
    assert.deepEqual(bans, [], 'a marked-query refusal must never ban the account');
});
