// Tests for the LinkedIn platform-wide search-quota back-off.
//
// THE BEHAVIOUR UNDER TEST
// LinkedIn meters content search separately from the rest of the site. Past
// some volume it stops serving search entirely - platform-wide, both accounts
// at once - while the profiles stay logged in and otherwise functional, then
// restores it after a few hours. Verified in production 2026-08-19 by driving a
// real browser on both profiles: the feed and notifications rendered, and
// search returned "No results found" for deliberately broad queries on both.
//
// The failure this prevents is not the quota itself, it is our reaction to it:
// production kept issuing ~285 scrapes/hour into the block for hours, which
// gains nothing and plausibly extends the window.
//
// See src/scrapers/linkedin-rsc/search-quota.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    SearchQuotaTracker,
    applyQuotaPause,
    DEFAULT_EMPTY_THRESHOLD,
    DEFAULT_BASE_PAUSE_MS,
    DEFAULT_MAX_PAUSE_MS,
} from '../../src/scrapers/linkedin-rsc/search-quota.js';

const MIN = 60 * 1000;

// A clock the test drives by hand, so escalation and decay windows are exercised
// at their real durations without the suite waiting hours.
function fakeClock(start = 1_000_000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => { t += ms; },
    };
}

function trackerAt(clock, opts = {}) {
    return new SearchQuotaTracker({ now: clock.now, ...opts });
}

// Feed n empty scrapes, returning every trip that fired.
function feedEmpty(tracker, n) {
    const trips = [];
    for (let i = 0; i < n; i++) {
        const r = tracker.recordEmpty();
        if (r.tripped) trips.push(r);
    }
    return trips;
}

describe('detecting a platform-wide refusal', () => {
    it('does not trip on ordinary thin-query noise', () => {
        // Healthy production hours show runs of 10-15 consecutive empties from
        // narrow boolean queries. Tripping on those would pause a working
        // scraper, which is worse than the problem being solved.
        const clock = fakeClock();
        const tracker = trackerAt(clock);
        const trips = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD - 1);
        assert.deepEqual(trips, []);
    });

    it('trips exactly once when the threshold is crossed', () => {
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        // Well past the threshold: the marker must be written once, not on
        // every subsequent empty scrape.
        const trips = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD + 40);

        assert.equal(trips.length, 1, 'exactly one trip per crossing');
        assert.equal(trips[0].streak, DEFAULT_EMPTY_THRESHOLD);
        assert.equal(trips[0].pauseMs, DEFAULT_BASE_PAUSE_MS);
    });

    it('counts across credentials, because the quota is platform-wide', () => {
        // The tracker takes no credential argument at all - that IS the design.
        // Production lost search on both accounts within the same minute, and a
        // per-account counter would need each one to independently reach the
        // threshold before anything happened.
        const clock = fakeClock();
        const tracker = trackerAt(clock);
        const trips = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD);
        assert.equal(trips.length, 1);
    });

    it('a served scrape resets the empty run', () => {
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD - 1);
        tracker.recordServed();
        const trips = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD - 1);

        assert.deepEqual(trips, [], 'the run must restart from zero after a success');
    });
});

describe('escalation', () => {
    it('doubles the pause when the quota is hit again', () => {
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        const first = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];

        // Pause expires, scraping resumes, still refused.
        clock.advance(first.pauseMs + MIN);
        const second = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];

        assert.equal(first.pauseMs, DEFAULT_BASE_PAUSE_MS);
        assert.equal(second.pauseMs, DEFAULT_BASE_PAUSE_MS * 2,
            'a repeat trip means the first back-off was too short');
    });

    it('caps the pause rather than escalating without limit', () => {
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        let last = 0;
        for (let i = 0; i < 10; i++) {
            const trip = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
            last = trip.pauseMs;
            clock.advance(trip.pauseMs + MIN);
        }

        assert.equal(last, DEFAULT_MAX_PAUSE_MS,
            'past the ceiling we are offline, not backing off - an operator should look');
    });

    it('decays escalation after a sustained clean period', () => {
        // One bad night must not leave a host permanently on a 4h pause.
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        const first = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        assert.equal(first.pauseMs, DEFAULT_BASE_PAUSE_MS);

        // A long healthy stretch.
        clock.advance(7 * 60 * MIN);
        tracker.recordServed();

        const later = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        assert.equal(later.pauseMs, DEFAULT_BASE_PAUSE_MS,
            'escalation should have retired, starting again from the base pause');
    });

    it('DOES decay on a success, because the alternative never decays at all', () => {
        // This assertion is the REVERSE of what it originally required, and the
        // reversal is deliberate.
        //
        // The original intent was sound in the abstract: one lucky result after
        // a pause does not prove the quota window has closed, so hold the
        // escalation. In practice it made escalation permanent, because the
        // decay it deferred to is unreachable — a 4h ceiling pause sits inside
        // a 6h decay window measured from the last trip, and every trip
        // restarts that clock.
        //
        // Production 2026-08-21 is the counter-example: 7 consecutive trips and
        // a standing 4h pause on a host that had scraped 6,242 posts overnight
        // and was served at 05:16, ten minutes before a fresh 4h pause landed.
        // The tracker was describing a quota window that had long since closed.
        //
        // Being wrong in this direction is bounded and self-correcting: if the
        // window really is still open, the next 25 empties trip again from the
        // 30-minute base. Being wrong in the old direction was unbounded.
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        const first = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        clock.advance(first.pauseMs + MIN);
        tracker.recordServed();

        const second = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        assert.equal(second.pauseMs, DEFAULT_BASE_PAUSE_MS,
            'a served scrape retires the escalation, so the next trip starts from base');
    });
});

describe('re-arming (the bounded-pause guarantee)', () => {
    it('a bounded pause never becomes a permanent stop', () => {
        // THE failure mode of a naive implementation: after the pause expires,
        // the counter is still sitting at the threshold, so the very first
        // scrape re-trips, pauses again, escalates, and the platform is never
        // scraped again. This asserts the counter is cleared on resume.
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        const first = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        clock.advance(first.pauseMs + MIN);

        // A single empty scrape after the pause expires must NOT re-trip.
        const next = tracker.recordEmpty();
        assert.equal(next.tripped, false);
        assert.equal(next.streak, 1, 'the run restarts from one, not from the threshold');
    });

    it('re-trips only after a fresh full run of empties', () => {
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        const first = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        clock.advance(first.pauseMs + MIN);

        // One short of a fresh run: still quiet.
        assert.deepEqual(feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD - 1), []);
        // The one that completes it trips.
        assert.equal(tracker.recordEmpty().tripped, true);
    });

    it('rearm() clears the pause for the operator path', () => {
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD);
        assert.equal(tracker.snapshot().paused, true);

        tracker.rearm();
        const snap = tracker.snapshot();
        assert.equal(snap.paused, false);
        assert.equal(snap.consecutiveEmpty, 0);
    });

    it('a served scrape ends the pause state', () => {
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD);
        tracker.recordServed();

        assert.equal(tracker.snapshot().paused, false,
            'search is demonstrably flowing, so the back-off is over');
    });
});

describe('applyQuotaPause', () => {
    it('writes the platform cooldown marker the orchestrator already honours', () => {
        // Reuses the existing stop mechanism rather than inventing a second
        // one: two things that can disagree about whether LinkedIn is running
        // is strictly worse than one.
        const calls = [];
        const cooldown = {
            writeCooldownMarker: (args) => calls.push(args),
            defaultWriteFile: () => 'writeFile',
            defaultRename: () => 'rename',
            // The marker is extend-only now (two writers share the file), so
            // the writer needs to be able to read the existing claim.
            defaultReadFile: () => 'readFile',
            cooldownPath: () => '/tmp/marker',
        };

        const ok = applyQuotaPause({ cooldown, pauseMs: 30 * MIN, now: new Date(0) });

        assert.equal(ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cooldownMs, 30 * MIN);
        assert.equal(calls[0].path, '/tmp/marker');
    });

    it('a marker-write failure does not throw into the scrape', () => {
        // The scrape that detected the problem has already done useful work.
        // Failing it over a bookkeeping write would discard that for nothing.
        const cooldown = {
            writeCooldownMarker: () => { throw new Error('disk full'); },
            defaultWriteFile: () => null,
            defaultRename: () => null,
            cooldownPath: () => '/tmp/marker',
        };

        assert.doesNotThrow(() => {
            const ok = applyQuotaPause({ cooldown, pauseMs: MIN, now: new Date(0) });
            assert.equal(ok, false, 'reports failure rather than pretending it paused');
        });
    });
});

describe('the production incident', () => {
    it('a mark-carrying refusal must NOT count as served (the bug that made this inert)', () => {
        // THE DEFECT THIS GUARDS.
        //
        // The first version of this feature reused the canary's health test,
        // which counts `refusedRepeat` - a confirmed empty for a search
        // carrying a high-water mark - as proof of health. For a ban verdict
        // that is correct. For a quota it is fatal, because a refused search
        // and an up-to-date search are byte-identical on the wire.
        //
        // Measured on the live host during the 2026-08-19 window: of 60
        // consecutive zero-yield scrapes, exactly 30 carried a mark. Roughly
        // alternating, so the counter reset every other scrape and the longest
        // streak reachable was 5 against a threshold of 25. The back-off could
        // never fire, and in production it did not.
        //
        // This replays that alternating pattern and asserts the tracker still
        // trips. It is fed ONLY empties, because during a refusal window every
        // scrape is a refusal regardless of whether it carried a mark.
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        let tripped = false;
        for (let i = 0; i < DEFAULT_EMPTY_THRESHOLD * 2; i++) {
            // Alternating mark / no-mark, exactly as production showed. Both
            // are refusals, so both must feed the streak.
            if (tracker.recordEmpty().tripped) { tripped = true; break; }
        }

        assert.ok(tripped, 'alternating mark/no-mark refusals must still reach the threshold');
    });

    it('would have paused instead of issuing hours of futile scrapes', () => {
        // Replays 2026-08-19: search stops serving and stays refused for three
        // hours at ~285 scrapes/hour. Old behaviour was ~855 scrapes, all empty.
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        let scrapesIssued = 0;
        let paused = false;
        let pausedUntil = 0;

        // Three hours of wall clock, one scrape every ~12.6s (285/hour).
        for (let t = 0; t < 3 * 60 * MIN; t += 12_600) {
            clock.advance(12_600);
            if (paused && clock.now() < pausedUntil) continue;   // orchestrator skips the claim
            paused = false;

            scrapesIssued += 1;
            const r = tracker.recordEmpty();
            if (r.tripped) {
                paused = true;
                pausedUntil = clock.now() + r.pauseMs;
            }
        }

        // Old behaviour: 857 scrapes into a wall. New: the threshold run, then
        // one short run per pause expiry.
        assert.ok(scrapesIssued < 120,
            `expected far fewer than the ~857 unpaced scrapes, got ${scrapesIssued}`);
        assert.ok(scrapesIssued >= DEFAULT_EMPTY_THRESHOLD,
            'but it must still probe enough to notice when search returns');
    });

    it('resumes promptly once LinkedIn starts serving again', () => {
        // The window closes on its own. The back-off must not outlast it by
        // much, or we trade a LinkedIn-imposed outage for a self-imposed one.
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        const trip = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        clock.advance(trip.pauseMs + MIN);

        // LinkedIn is serving again.
        tracker.recordServed();

        const snap = tracker.snapshot();
        assert.equal(snap.paused, false);
        assert.equal(snap.consecutiveEmpty, 0);
    });
});

describe('request-rate ceiling', () => {
    it('the pacer, not the sweep interval, is what bounds the request rate', async () => {
        // The trap this documents cost a full extra iteration to find.
        //
        // The obvious lever for "we are asking LinkedIn too often" is the sweep
        // interval, so that is what got raised first (0 -> 30 min). It barely
        // helped: 154 queue rows coming due every 30 minutes still demands
        // ~308 scrapes/hour, which is ABOVE what the pacer already allowed, so
        // the pacer stayed the binding constraint and the real rate did not
        // move.
        //
        // Measured ceiling with the shipped defaults: 20s floor + 10s jitter
        // averaged, across max_inflight=2 credentials, is 288/hour - exactly
        // the rate observed in the hours LinkedIn cut content search off.
        //
        // This asserts the relationship rather than a magic number, so it stays
        // true if either knob moves.
        const {
            DEFAULT_MIN_SPACING_MS, DEFAULT_JITTER_MS,
        } = await import('../../src/scrapers/linkedin-rsc/pacer.js');

        const MAX_INFLIGHT = 2;              // scraper_platforms.max_inflight for linkedin
        const avgSpacingMs = DEFAULT_MIN_SPACING_MS + (DEFAULT_JITTER_MS / 2);
        const ceilingPerHour = (3600_000 / avgSpacingMs) * MAX_INFLIGHT;

        // The rate LinkedIn demonstrably tolerated (208/hour returned 5,689
        // posts) versus the rate at which it cut us off (285-288/hour returned
        // zero). A default that sits at or above the refusal rate means the
        // host ships pre-loaded to trip the quota.
        const OBSERVED_REFUSAL_RATE = 285;

        assert.ok(
            ceilingPerHour >= OBSERVED_REFUSAL_RATE,
            'sanity: the shipped default really is at the rate that got refused '
            + `(${Math.round(ceilingPerHour)}/hour) - if this ever fails, the default was `
            + 'lowered and this test should be updated to assert the new relationship',
        );

        // The knob that actually moves the rate. Documented here because the
        // sweep interval does NOT, and that is genuinely counter-intuitive.
        const pacedCeiling = (spacing, jitter) => (3600_000 / (spacing + jitter / 2)) * MAX_INFLIGHT;
        assert.ok(
            pacedCeiling(45_000, 15_000) < 150,
            'the production override (45s/15s) must bring the ceiling well under '
            + 'the refusal rate',
        );
    });

    it('the production pacing override stays inside the orphan-window margin', async () => {
        // The ceiling cannot simply be lowered without limit: the pacer's wait
        // is spent INSIDE the credential lease but OUTSIDE the scrape budget,
        // so raising spacing eats the margin under the backend's 600s orphan
        // window. Past that, the backend hands the live session to a second
        // scraper, which double-scrapes - doubling the very load this is
        // trying to reduce.
        const { ORPHAN_WINDOW_MS, CANDIDATE_BUDGET_MS } = await import('../../src/scrapers/linkedin-rsc/scraper.js');

        const PROD_SPACING_MS = 45_000;   // deploy/run-scraper.cmd
        const PROD_JITTER_MS = 15_000;

        const worstCase = PROD_SPACING_MS + PROD_JITTER_MS + CANDIDATE_BUDGET_MS;
        assert.ok(
            ORPHAN_WINDOW_MS - worstCase >= 120_000,
            `the production pacing override leaves only ${(ORPHAN_WINDOW_MS - worstCase) / 1000}s `
            + 'of margin; raising it further requires raising INFLIGHT_GRACE_SECONDS first',
        );
    });
});

// ── Production 2026-08-21: escalation that cannot decay ────────────────────
//
// Reproduces the exact observed sequence. See the tracker for the fix.
describe('escalation decay vs the pause it is gated behind', () => {
    it('retires escalation after a served scrape, even mid-quota-window', () => {
        let now = 0;
        const tracker = new SearchQuotaTracker({ now: () => now });

        // Walk the escalation up the way production did, overnight.
        for (let trip = 1; trip <= 7; trip++) {
            for (let i = 0; i < DEFAULT_EMPTY_THRESHOLD; i++) tracker.recordEmpty();
            const snap = tracker.snapshot();
            assert.equal(snap.paused, true, `trip ${trip} should pause`);
            // Sit out the pause that was just applied.
            now = Date.parse(snap.pausedUntil) + 1;
        }

        // Production reading at 05:26 UTC: seven trips, pinned at the ceiling.
        assert.equal(tracker.snapshot().consecutiveTrips, 7);
        assert.equal(tracker.snapshot().nextPauseMs, DEFAULT_MAX_PAUSE_MS);

        // Now LinkedIn serves. Production did this at 05:16 - 6242 posts had
        // been scraped overnight, so this is not hypothetical.
        tracker.recordServed();

        // THE BUG: escalation only decays after DEFAULT_ESCALATION_DECAY_MS
        // (6h) measured from the last trip, but the pause that precedes it is
        // capped at 4h. A host that is being served again therefore carries its
        // full escalation into the next thin patch, and the very next streak
        // re-applies a 4h pause - which is what put production at 7 trips.
        assert.equal(
            tracker.snapshot().consecutiveTrips, 0,
            'a served scrape proves the quota window is over and must retire escalation',
        );
    });
});
