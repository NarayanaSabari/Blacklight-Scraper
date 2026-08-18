// ACCEPTANCE: the path the orchestrator actually calls.
//
// Everything else on this branch tests scrapeLinkedInRsc directly. Production
// does not call it that way. `src/queue/orchestrator.js` resolves a scraper
// from the registry and calls `BaseScraper.executeWithMeta(...)`, and the
// LinkedIn entry is registered with `strictEmpty: true` — which adds a second
// failure mode the unit tests cannot see: a zero-job scrape with no
// confirmed-empty signal throws BlockedError and marks the PLATFORM failed,
// independently of anything the canary decides about the credential.
//
// So this file drives the real registry entry, the real BaseScraper wrapper,
// the real scraper, the real paginate() and the real flight parser over a real
// captured LinkedIn no-results payload. Only the socket is faked.
//
// Measured both sides of the fix with this exact harness:
//   untouched main -> credential banned at sweep #10
//   this branch    -> 40 sweeps, 0 bans, 0 BlockedErrors

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getScraper } from '../../src/scrapers/registry.js';
import { CanaryTracker, CANARY_QUERIES } from '../../src/scrapers/linkedin-rsc/canary.js';
import { paginate } from '../../src/scrapers/linkedin-rsc/client.js';

const NO_RESULTS = fs.readFileSync(
    path.join(import.meta.dirname, '../fixtures/linkedin-rsc-no-results.txt'), 'utf8',
);
const TEMPLATE = { url: 'https://x', headers: { 'user-agent': 'x' }, postData: '{}' };

function harness({ mark }) {
    const state = { bans: 0, thrown: 0, results: [] };
    const lease = {
        credential: { profile_key: 'acct', name: 'Link1' },
        reportSuccess: async () => {},
        reportFailure: async () => { state.bans += 1; },
    };
    const session = {
        async withCookies(_id, fn) {
            return fn(
                [{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"ajax:1"' }],
                lease,
            );
        },
    };
    const options = {
        session,
        template: TEMPLATE,
        highWater: { get: () => mark, advance: () => {} },
        canaryTracker: new CanaryTracker({ threshold: 10 }),
        pacer: null,   // real pacing is covered in linkedin-rsc-pacer.test.js
        paginateImpl: (args) => paginate({
            ...args,
            fetchImpl: async () => ({ status: 200, text: async () => NO_RESULTS }),
            delay: async () => {},
        }),
    };
    return { state, options };
}

test('ACCEPTANCE: 40 steady-state sweeps through the orchestrator path ban nobody', async () => {
    const scraper = getScraper('linkedin');
    assert.ok(scraper, 'the registry must expose a linkedin scraper');

    const { state, options } = harness({ mark: '7487914656553025536' });
    for (let i = 0; i < 40; i += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            state.results.push(await scraper.executeWithMeta('Business Analyst', 'US', `s${i}`, options));
        } catch {
            state.thrown += 1;
        }
    }

    assert.equal(state.bans, 0, 'a healthy up-to-date account must never be banned (main: banned at #10)');
    assert.equal(state.thrown, 0, 'strictEmpty must not mark the platform failed on a known-ground sweep');
    assert.equal(state.results.length, 40);
    // What the backend actually receives on the wire.
    assert.equal(state.results[0].emptyConfirmed, true, 'the zero must be reported as trustworthy');
    assert.deepEqual(state.results[0].jobs, []);
});

test('ACCEPTANCE: an unconfirmed zero still fails the platform through the real wrapper', async () => {
    // The guard strictEmpty exists for: a zero with NO no-results signal is a
    // suspected block or DOM change and must still surface, or a broken parser
    // would look like a quiet, healthy day forever.
    const scraper = getScraper('linkedin');
    const { options } = harness({ mark: null });
    await assert.rejects(
        () => scraper.executeWithMeta('Business Analyst', 'US', 'sx', {
            ...options,
            paginateImpl: async () => ({ posts: [], emptyConfirmed: false, pages: [] }),
        }),
        /suspected block|0 jobs/i,
        'an unexplained zero must still raise',
    );
});

// ─── the scraper→backend integration boundary ───────────────────────────

test('ACCEPTANCE: the HTTP body the backend receives marks the zero trustworthy', async () => {
    // The boundary that decides whether this fix is visible to the product.
    // A steady-state sweep now yields zero jobs, and the ONLY thing telling
    // the backend that zero is healthy rather than a silent block is the
    // `empty_confirmed` field on POST /api/scraper/queue/jobs.
    //
    // server/app/routes/scraper_routes.py:453 branches on `is True`:
    //   true  -> "Platform submitted a CONFIRMED-empty result"
    //   false -> warning + scraper_alert: zero_jobs_unconfirmed
    //   None  -> same warning (older build)
    //
    // If the wire flag were wrong, every healthy sweep would page the on-call
    // channel with a block alert. This asserts the real body produced by the
    // real scraper through the real API client, with only global fetch faked.
    const captured = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        captured.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
        return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => '{}' };
    };

    try {
        const { BlacklightApiClient } = await import('../../src/api/blacklight.js');
        const scraper = getScraper('linkedin');
        const { state, options } = harness({ mark: '7487914656553025536' });

        const { jobs, emptyConfirmed } = await scraper.executeWithMeta(
            'Business Analyst', 'US', '3729f13e-8670-41f9-9e9d-e965dba55510', options,
        );
        const api = new BlacklightApiClient('http://backend', 'key');
        await api.submitJobs(
            '3729f13e-8670-41f9-9e9d-e965dba55510', 'linkedin', jobs, 'success', null,
            { emptyConfirmed },
        );

        const post = captured.find((c) => c.url.includes('/queue/jobs'));
        assert.ok(post, 'the submission must reach the backend endpoint');
        assert.equal(post.body.jobs.length, 0);
        assert.equal(
            post.body.empty_confirmed, true,
            'a known-ground sweep must be reported as a CONFIRMED empty, or every '
            + 'healthy sweep raises a zero_jobs_unconfirmed block alert',
        );
        assert.equal(state.bans, 0);
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ─── the timing budget against the backend's orphan window ──────────────

test('ACCEPTANCE: pacing + scrape budget stays inside the backend orphan window', async () => {
    // Three-way coupling that no single file owns, and which my own pacer
    // change tightened:
    //
    //   RolePlatformQueueService.INFLIGHT_GRACE_SECONDS = 600s
    //     after which the backend treats the claim as orphaned and lets a
    //     SECOND scraper take the same platform -> double-scrape, double the
    //     request load on the exact account this work exists to protect.
    //
    //   CANDIDATE_TIME_BUDGET_MS = 420s   (scrape's own valve)
    //   pacer                    = 20s floor + up to 10s jitter
    //
    // The pacer's wait is spent inside the lease but OUTSIDE the scrape budget,
    // because the budget clock only starts when pagination does. Worst case is
    // therefore 450s, not 420s. Nothing enforced that until now.
    const { ORPHAN_WINDOW_MS, CANDIDATE_BUDGET_MS } = await import('../../src/scrapers/linkedin-rsc/scraper.js');
    const {
        DEFAULT_MIN_SPACING_MS, DEFAULT_JITTER_MS,
    } = await import('../../src/scrapers/linkedin-rsc/pacer.js');

    const worstCase = DEFAULT_MIN_SPACING_MS + DEFAULT_JITTER_MS + CANDIDATE_BUDGET_MS;
    assert.ok(
        worstCase < ORPHAN_WINDOW_MS,
        `worst-case lease hold ${worstCase}ms must stay under the backend's `
        + `${ORPHAN_WINDOW_MS}ms orphan window`,
    );
    // Keep a real cushion, not a one-second squeak.
    assert.ok(
        ORPHAN_WINDOW_MS - worstCase >= 120_000,
        `only ${(ORPHAN_WINDOW_MS - worstCase) / 1000}s of margin left — raising the `
        + 'pacing floor further needs the backend grace window raised first',
    );
});

test('ACCEPTANCE: the pacer is genuinely live on the production call path', async () => {
    // orchestrator.js:512 passes ONLY {searchQueries, candidateQuery}: no
    // paginateImpl and no pacer. So production takes every default in
    // scrapeLinkedInRsc, and the pacer must engage there or the burst fix is
    // shipped-but-inert. The seam that keeps tests fast is exactly what could
    // silently disable it.
    const { getRequestPacer, __resetRequestPacerForTest } = await import('../../src/scrapers/linkedin-rsc/pacer.js');
    __resetRequestPacerForTest();
    const pacer = getRequestPacer();
    const lease = { credential: { profile_key: 'prod-acct' } };

    assert.equal(await pacer.pace(lease), 0, 'the first scrape must not be delayed');
    const next = pacer.waitFor(lease);
    assert.ok(
        next >= 20_000 && next <= 30_000,
        `a second scrape on the same credential must be held 20-30s, got ${next}ms`,
    );
    __resetRequestPacerForTest();
});

test('ACCEPTANCE: pacing leaves real headroom over observed production demand', async () => {
    // Pacing is only a safety win if it does not become the new bottleneck.
    // Measured against production rather than guessed:
    //
    //   peak observed  81 sessions/hour  (2026-08-17 15:00-16:00 UTC, the
    //                                     healthiest hour on record)
    //   paced capacity 3600 / (20s floor + ~5s mean jitter) = 144/hour
    //
    // ~78% headroom on a single credential, and the pacer is per credential so
    // a second account doubles it. If someone later raises the floor far enough
    // that capacity drops under observed demand, this fails and says so.
    const {
        DEFAULT_MIN_SPACING_MS, DEFAULT_JITTER_MS,
    } = await import('../../src/scrapers/linkedin-rsc/pacer.js');

    const meanGapMs = DEFAULT_MIN_SPACING_MS + (DEFAULT_JITTER_MS / 2);
    const capacityPerHour = Math.floor(3_600_000 / meanGapMs);
    const PEAK_OBSERVED_PER_HOUR = 81;

    assert.ok(
        capacityPerHour > PEAK_OBSERVED_PER_HOUR,
        `paced capacity ${capacityPerHour}/h must exceed observed peak demand `
        + `${PEAK_OBSERVED_PER_HOUR}/h, or pacing becomes the bottleneck`,
    );
    assert.ok(
        capacityPerHour >= PEAK_OBSERVED_PER_HOUR * 1.5,
        `only ${capacityPerHour}/h against a ${PEAK_OBSERVED_PER_HOUR}/h peak — too tight `
        + 'to absorb a backlog after an outage',
    );
});

// ─── process restart / lost host state ──────────────────────────────────

const SEARCH_BODY = fs.readFileSync(
    path.join(import.meta.dirname, '../fixtures/linkedin-rsc-search.txt'), 'utf8',
);

test('ACCEPTANCE: repeated process restarts do not resurrect the false ban', async () => {
    // deploy/run-scraper.cmd runs the scraper under a supervise loop that
    // restarts it on ANY exit, and the control panel's restart button exits 0
    // on purpose. So restarts are routine, not exceptional.
    //
    // CanaryTracker state is per-process and dies with it; high-water marks are
    // on disk (config/linkedin-highwater.json) and survive. The fix keys on the
    // mark, so it must keep holding across restarts.
    const scraper = getScraper('linkedin');
    let bans = 0;
    const lease = {
        credential: { profile_key: 'restart' },
        reportSuccess: async () => {},
        reportFailure: async () => { bans += 1; },
    };
    const session = {
        async withCookies(_id, fn) {
            return fn([{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"ajax:1"' }], lease);
        },
    };

    for (let restart = 0; restart < 3; restart += 1) {
        const tracker = new CanaryTracker({ threshold: 10 });   // fresh process
        for (let i = 0; i < 15; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await scraper.executeWithMeta('Business Analyst', 'US', 's', {
                session,
                template: TEMPLATE,
                highWater: { get: () => '7487914656553025536', advance: () => {} },
                canaryTracker: tracker,
                pacer: null,
                paginateImpl: (args) => paginate({
                    ...args,
                    fetchImpl: async () => ({ status: 200, text: async () => NO_RESULTS }),
                    delay: async () => {},
                }),
            });
        }
    }
    assert.equal(bans, 0, '45 sweeps across 3 restarts must not ban a healthy account');
});

test('ACCEPTANCE: a LOST high-water file still cannot false-ban a healthy account', async () => {
    // The mark file is host-local and explicitly disposable ("losing the file is
    // harmless" — high-water.js). A fresh host, a wiped config/, or a first run
    // means every query is UNMARKED, so `refusedRepeat` is false and the primary
    // fix does not apply at all.
    //
    // The canary is the second line of defence for exactly this: thin niche
    // queries return nothing, but the broad control query still returns posts,
    // so the account is proven healthy and the ban is vetoed.
    const scraper = getScraper('linkedin');
    let bans = 0;
    const lease = {
        credential: { profile_key: 'nomark' },
        reportSuccess: async () => {},
        reportFailure: async () => { bans += 1; },
    };
    const session = {
        async withCookies(_id, fn) {
            return fn([{ name: 'li_at', value: 'a' }, { name: 'JSESSIONID', value: '"ajax:1"' }], lease);
        },
    };
    const tracker = new CanaryTracker({ threshold: 10, probeIntervalMs: 0 });

    for (let i = 0; i < 30; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await scraper.executeWithMeta('Very Niche Role', 'US', 's', {
            session,
            template: TEMPLATE,
            highWater: { get: () => null, advance: () => {} },   // mark lost
            canaryTracker: tracker,
            pacer: null,
            paginateImpl: (args) => paginate({
                ...args,
                // Niche role searches are empty; the broad canary query is not.
                fetchImpl: async () => ({
                    status: 200,
                    text: async () => (CANARY_QUERIES.includes(args.keywords) ? SEARCH_BODY : NO_RESULTS),
                }),
                delay: async () => {},
            }),
        });
    }
    assert.equal(bans, 0, 'a healthy account with thin queries must survive a lost mark file');
});
