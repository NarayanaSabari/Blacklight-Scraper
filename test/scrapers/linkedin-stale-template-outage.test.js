// End-to-end guard for the 2026-08-18 LinkedIn outage.
//
// WHAT HAPPENED
// The captured RSC template's client version (0.2.6546, captured 07-31) fell
// ~269 builds behind LinkedIn's live version (0.2.6815). LinkedIn stopped
// honouring the request and began answering EVERY search with HTTP 200 and a
// well-formed "No results found" — including the positive no-results flag the
// transport treats as authoritative. A real browser on the same profile, at the
// same moment, saw live posts, proving the accounts were healthy.
//
// The consequence was not just lost scraping. Those confirmed empties are the
// exact evidence the shadow-ban canary is built to act on, so it convicted both
// production credentials and cooled them for four hours each. The pipeline sat
// at zero for five hours and the recorded cause was wrong, which sent every
// obvious remedy (wait it out, re-login, rotate accounts) in a direction that
// could not possibly help.
//
// These tests drive the real session and canary objects — not reimplementations
// — through that exact scenario, and assert the two properties that make the
// failure non-recurring:
//
//   1. a stale template is DETECTED and RE-CAPTURED automatically;
//   2. a canary that would otherwise report a ban does NOT, when the request
//      itself is what LinkedIn is refusing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LinkedInRscSession } from '../../src/scrapers/linkedin-rsc/session.js';
import { CanaryTracker, runCanary } from '../../src/scrapers/linkedin-rsc/canary.js';
import * as realTemplateHealth from '../../src/scrapers/linkedin-rsc/template-health.js';

// The production values, so the scenario is the real one rather than a
// convenient stand-in.
const STALE_VERSION = '0.2.6546';
const LIVE_VERSION = '0.2.6815';

function templateWith(version, capturedAt = '2026-07-31T01:13:03.000Z') {
    return {
        url: 'https://www.linkedin.com/flagship-web/rsc-action/actions/pagination',
        headers: {
            'x-li-application-version': version,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
        postData: '{"clientArguments":{"payload":{}}}',
        capturedAt,
    };
}

// A template-health module wired to a fixed live version, using the REAL
// assessment logic so thresholds are exercised rather than mocked away.
function healthReporting(liveVersion) {
    return {
        assessTemplate: realTemplateHealth.assessTemplate,
        fetchLiveClientVersion: async () => liveVersion,
    };
}

function makeSession({ template, liveVersion, onRecapture, now = () => Date.now() }) {
    let captured = 0;
    const session = new LinkedInRscSession({
        apiClient: { isLocal: false },
        templateLoader: () => template,
        cookieReader: async () => [{ name: 'li_at', value: 'x' }],
        templateHealth: healthReporting(liveVersion),
        recaptureTemplate: async () => {
            captured += 1;
            const fresh = templateWith(liveVersion, new Date().toISOString());
            onRecapture?.(fresh);
            return fresh;
        },
        now,
        scheduler: { setInterval: () => null, clearInterval: () => {} },
    });
    return { session, captures: () => captured };
}

describe('stale template is detected and healed', () => {
    it('re-captures when the captured version has fallen behind', async () => {
        const { session, captures } = makeSession({
            template: templateWith(STALE_VERSION),
            liveVersion: LIVE_VERSION,
        });

        const used = await session.template();

        assert.equal(captures(), 1, 'should have re-captured exactly once');
        assert.equal(
            used.headers['x-li-application-version'],
            LIVE_VERSION,
            'the scrape must receive the FRESH template, not the stale one',
        );
    });

    it('does not re-capture a current template', async () => {
        const { session, captures } = makeSession({
            template: templateWith(LIVE_VERSION, new Date().toISOString()),
            liveVersion: LIVE_VERSION,
        });

        await session.template();

        assert.equal(captures(), 0, 're-capture drives a browser; it must not fire needlessly');
    });

    it('checks at most once per interval, however many scrapes run', async () => {
        // 135 roles/hour share one process. A per-scrape check would mean a
        // fetch per scrape, which is its own traffic pattern.
        let clock = 1_000_000;
        const { session, captures } = makeSession({
            template: templateWith(LIVE_VERSION, new Date().toISOString()),
            liveVersion: LIVE_VERSION,
            now: () => clock,
        });

        let fetches = 0;
        session._templateHealth = {
            assessTemplate: realTemplateHealth.assessTemplate,
            fetchLiveClientVersion: async () => { fetches += 1; return LIVE_VERSION; },
        };

        for (let i = 0; i < 25; i++) {
            clock += 60_000;               // a minute between scrapes
            await session.template();
        }

        assert.equal(fetches, 1, 'the interval gate must collapse 25 scrapes into one check');
        assert.equal(captures(), 0);
    });

    it('keeps scraping when the freshness check itself fails', async () => {
        // A version endpoint that is down must not stop the scraper: a possibly
        // stale template still works far more often than not.
        const template = templateWith(LIVE_VERSION, new Date().toISOString());
        const session = new LinkedInRscSession({
            apiClient: { isLocal: false },
            templateLoader: () => template,
            templateHealth: {
                assessTemplate: realTemplateHealth.assessTemplate,
                fetchLiveClientVersion: async () => { throw new Error('network down'); },
            },
            recaptureTemplate: async () => { throw new Error('should not be reached'); },
            scheduler: { setInterval: () => null, clearInterval: () => {} },
        });

        const used = await session.template();
        assert.equal(used, template, 'the existing template must still be served');
    });

    it('keeps scraping when the re-capture itself fails', async () => {
        // Losing the browser must degrade, not stop. The scrape proceeds on the
        // old template and the operator gets a loud alert.
        const stale = templateWith(STALE_VERSION);
        const session = new LinkedInRscSession({
            apiClient: { isLocal: false },
            templateLoader: () => stale,
            templateHealth: healthReporting(LIVE_VERSION),
            recaptureTemplate: async () => { throw new Error('browser unavailable'); },
            scheduler: { setInterval: () => null, clearInterval: () => {} },
        });

        const used = await session.template();
        assert.equal(used, stale, 'falls back to the stale template rather than throwing');
    });
});

describe('the canary must not blame the account for a refused request', () => {
    // A lease that records whether it was reported as failed. This is the
    // assertion that matters: reportFailure is what cools a credential for
    // hours, and on 08-18 it fired against two healthy accounts.
    function makeLease(id = 15) {
        const calls = [];
        return {
            lease: {
                credential: { id, name: `Link${id}` },
                reportFailure: async (message, minutes) => { calls.push({ message, minutes }); },
                reportSuccess: async () => {},
            },
            failures: () => calls,
        };
    }

    // Reproduces the wire behaviour of the outage: LinkedIn returns zero posts
    // with its positive no-results flag, for every query including the canary's
    // broad control phrases.
    const alwaysEmpty = async () => ({ posts: [], emptyConfirmed: true, pages: [] });

    it('does NOT report a ban when the template is stale', async () => {
        const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
        const { lease, failures } = makeLease();

        // Two strikes, as production requires. Neither may convict.
        let verdict;
        for (let i = 0; i < 2; i++) {
            tracker.recordEmpty(lease);
            verdict = await runCanary({
                tracker,
                lease,
                template: templateWith(STALE_VERSION),
                cookies: [],
                paginateImpl: alwaysEmpty,
                verifyRequestHealth: async () => false,   // template is stale
            });
        }

        assert.equal(verdict, 'request_refused');
        assert.deepEqual(failures(), [], 'a healthy credential must NOT be cooled');
    });

    it('STILL reports a genuine ban when the request is known-good', async () => {
        // The other half of the guarantee: the gate must not defang the canary.
        // A real shadow-ban still has to be caught.
        const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
        const { lease, failures } = makeLease(17);

        let verdict;
        for (let i = 0; i < 2; i++) {
            tracker.recordEmpty(lease);
            verdict = await runCanary({
                tracker,
                lease,
                template: templateWith(LIVE_VERSION),
                cookies: [],
                paginateImpl: alwaysEmpty,
                verifyRequestHealth: async () => true,    // request is fine
            });
        }

        assert.equal(verdict, 'shadow_banned');
        assert.equal(failures().length, 1, 'a genuinely banned account must still be cooled');
        assert.match(failures()[0].message, /Shadow-ban canary/);
    });

    it('defers rather than bans when request health cannot be determined', async () => {
        // Unknown must fail toward "do not ban": a wrongly-cooled account costs
        // hours, while a deferred verdict costs one more probe cycle.
        const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
        const { lease, failures } = makeLease();

        let verdict;
        for (let i = 0; i < 2; i++) {
            tracker.recordEmpty(lease);
            verdict = await runCanary({
                tracker,
                lease,
                template: templateWith(LIVE_VERSION),
                cookies: [],
                paginateImpl: alwaysEmpty,
                verifyRequestHealth: async () => { throw new Error('cannot reach linkedin'); },
            });
        }

        assert.equal(verdict, 'request_refused');
        assert.deepEqual(failures(), []);
    });

    it('clears the streak so a fixed template does not convict on old evidence', async () => {
        // The evidence was gathered through a refused request, so it says
        // nothing about the credential. Left in place, it would convict the
        // account as soon as the template was fixed and a thin query landed.
        const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
        const { lease } = makeLease();

        for (let i = 0; i < 2; i++) {
            tracker.recordEmpty(lease);
            await runCanary({
                tracker,
                lease,
                template: templateWith(STALE_VERSION),
                cookies: [],
                paginateImpl: alwaysEmpty,
                verifyRequestHealth: async () => false,
            });
        }

        assert.equal(tracker.streak(lease), 0, 'streak must be cleared');
        assert.equal(tracker.suspicion(lease), 0, 'strikes must be cleared');
    });

    it('preserves the old behaviour when no verifier is supplied', async () => {
        // Back-compat: callers that pass no verifier (and existing tests) must
        // see exactly the previous semantics.
        const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
        const { lease, failures } = makeLease();

        let verdict;
        for (let i = 0; i < 2; i++) {
            tracker.recordEmpty(lease);
            verdict = await runCanary({
                tracker,
                lease,
                template: templateWith(LIVE_VERSION),
                cookies: [],
                paginateImpl: alwaysEmpty,
            });
        }

        assert.equal(verdict, 'shadow_banned');
        assert.equal(failures().length, 1);
    });

    it('a session that cannot answer means NO OPINION, not "request refused"', async () => {
        // Caught by an existing end-to-end test during development: wiring the
        // verifier as an always-present closure over an absent method made every
        // ban verdict throw, get caught as "cannot verify", and downgrade to
        // request_refused — silently disabling shadow-ban detection entirely.
        //
        // The scraper now passes `undefined` when the session lacks the
        // capability. This asserts the resulting behaviour directly.
        const tracker = new CanaryTracker({ threshold: 1, probeIntervalMs: 0 });
        const { lease, failures } = makeLease();
        const sessionWithoutCapability = {};

        let verdict;
        for (let i = 0; i < 2; i++) {
            tracker.recordEmpty(lease);
            verdict = await runCanary({
                tracker,
                lease,
                template: templateWith(LIVE_VERSION),
                cookies: [],
                paginateImpl: alwaysEmpty,
                verifyRequestHealth: typeof sessionWithoutCapability.isRequestHealthy === 'function'
                    ? () => sessionWithoutCapability.isRequestHealthy()
                    : undefined,
            });
        }

        assert.equal(verdict, 'shadow_banned', 'detection must not be disabled by a missing capability');
        assert.equal(failures().length, 1);
    });
});

describe('session.isRequestHealthy', () => {
    it('reports false and heals when the template is stale', async () => {
        const { session, captures } = makeSession({
            template: templateWith(STALE_VERSION),
            liveVersion: LIVE_VERSION,
        });

        assert.equal(await session.isRequestHealthy(), false);
        assert.equal(captures(), 1, 'detecting the problem must also fix it');
    });

    it('reports true for a current template', async () => {
        const { session } = makeSession({
            template: templateWith(LIVE_VERSION, new Date().toISOString()),
            liveVersion: LIVE_VERSION,
        });

        assert.equal(await session.isRequestHealthy(), true);
    });

    it('reports true (no opinion) when LinkedIn version is unreadable', async () => {
        // Must not block a genuine ban verdict just because this check is blind.
        const session = new LinkedInRscSession({
            apiClient: { isLocal: false },
            templateLoader: () => templateWith(STALE_VERSION),
            templateHealth: {
                assessTemplate: realTemplateHealth.assessTemplate,
                fetchLiveClientVersion: async () => null,
            },
            scheduler: { setInterval: () => null, clearInterval: () => {} },
        });

        assert.equal(await session.isRequestHealthy(), true);
    });
});
