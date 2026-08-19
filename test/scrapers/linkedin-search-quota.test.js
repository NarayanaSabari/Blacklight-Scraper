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

    it('does NOT decay on a single success straight after a pause', () => {
        // The window may still be in force; one lucky result is not proof it
        // has closed, and collapsing the pause back to base would re-trip.
        const clock = fakeClock();
        const tracker = trackerAt(clock);

        const first = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        clock.advance(first.pauseMs + MIN);
        tracker.recordServed();

        const second = feedEmpty(tracker, DEFAULT_EMPTY_THRESHOLD)[0];
        assert.equal(second.pauseMs, DEFAULT_BASE_PAUSE_MS * 2,
            'escalation must persist until a sustained clean period');
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
