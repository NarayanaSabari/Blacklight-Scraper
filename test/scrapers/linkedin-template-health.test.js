// Tests for LinkedIn RSC template freshness detection.
//
// The bug being guarded against is subtle and cost five hours of production
// downtime plus two falsely-banned credentials: a stale template makes LinkedIn
// answer every search with a well-formed "No results found", which is
// indistinguishable from a shadow-ban unless something is watching the client
// version. See src/scrapers/linkedin-rsc/template-health.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseClientVersion,
    templateClientVersion,
    extractLiveClientVersion,
    fetchLiveClientVersion,
    assessTemplate,
    looksLikeRefusedRequest,
    DEFAULT_MAX_VERSION_LAG,
} from '../../src/scrapers/linkedin-rsc/template-health.js';

const templateAt = (version, capturedAt) => ({
    url: 'https://www.linkedin.com/flagship-web/rsc-action/actions/pagination',
    headers: { 'x-li-application-version': version },
    postData: '{}',
    ...(capturedAt ? { capturedAt } : {}),
});

describe('parseClientVersion', () => {
    it('orders builds within the same major.minor', () => {
        assert.ok(parseClientVersion('0.2.6815') < parseClientVersion('0.2.6832'));
    });

    it('does not let a build number outrank a minor bump', () => {
        // A naive "compare the last component" implementation would call
        // 0.2.9999 newer than 0.3.0001 and never re-capture across a minor bump.
        assert.ok(parseClientVersion('0.2.9999') < parseClientVersion('0.3.0001'));
    });

    it('returns null for unrecognised shapes rather than guessing', () => {
        for (const bad of [null, undefined, '', 'unknown', '2.1', 'v0.2.6815-rc']) {
            assert.equal(parseClientVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
        }
    });

    it('accepts a version with trailing detail', () => {
        assert.equal(parseClientVersion('0.2.6815.1'), parseClientVersion('0.2.6815'));
    });
});

describe('templateClientVersion', () => {
    it('reads the captured client version', () => {
        assert.equal(templateClientVersion(templateAt('0.2.6815')), '0.2.6815');
    });

    it('is null-safe for a malformed template', () => {
        assert.equal(templateClientVersion(null), null);
        assert.equal(templateClientVersion({}), null);
        assert.equal(templateClientVersion({ headers: {} }), null);
    });
});

describe('extractLiveClientVersion', () => {
    // These four strings are copied verbatim from a live www.linkedin.com/feed/
    // fetch on 2026-08-18. They are the regression guard: if LinkedIn changes
    // its markup, this is what should fail first and loudest.
    it('reads the HTML-entity encoded serviceVersion', () => {
        const body = '...&quot;:&quot;flagship-web&quot;,&quot;serviceVersion&quot;:&quot;0.2.6832&quot;...';
        assert.equal(extractLiveClientVersion(body), '0.2.6832');
    });

    it('reads the backslash-escaped appVersion', () => {
        const body = '...\\"appId\\":\\"com.linkedin.flagship3.d_web\\",\\"appVersion\\":\\"0.2.6832\\"...';
        assert.equal(extractLiveClientVersion(body), '0.2.6832');
    });

    it('reads the plain-JSON applicationVersion', () => {
        assert.equal(extractLiveClientVersion('{"applicationVersion":"0.2.6832"}'), '0.2.6832');
    });

    it('reads the version that follows the flagship-web application URN', () => {
        const body = '\\"n\\":\\"urn:li:application:(web,flagship-web)\\",\\"version\\":\\"0.2.6832\\"';
        assert.equal(extractLiveClientVersion(body), '0.2.6832');
    });

    it('does NOT pick up the unrelated component version on the same page', () => {
        // 0.1.49623 ships alongside the flagship version in the same payload.
        // Matching it would compare our client version against a different
        // component and produce a nonsense lag.
        const body = '{"somethingElse":"0.1.49623","serviceVersion":"0.2.6832"}';
        assert.equal(extractLiveClientVersion(body), '0.2.6832');
    });

    it('ignores a bare version-like string with no recognised key', () => {
        assert.equal(extractLiveClientVersion('build 0.2.6832 shipped today'), null);
    });

    it('returns null for an empty or missing body', () => {
        assert.equal(extractLiveClientVersion(''), null);
        assert.equal(extractLiveClientVersion(null), null);
    });
});

describe('fetchLiveClientVersion', () => {
    it('returns the version from a successful fetch', async () => {
        const fetchImpl = async () => ({
            ok: true,
            text: async () => '{"serviceVersion":"0.2.6832"}',
        });
        assert.equal(await fetchLiveClientVersion({ fetchImpl }), '0.2.6832');
    });

    it('returns null (no opinion) when the request fails', async () => {
        const fetchImpl = async () => { throw new Error('socket hang up'); };
        assert.equal(await fetchLiveClientVersion({ fetchImpl }), null);
    });

    it('returns null on a non-ok response rather than parsing an error page', async () => {
        const fetchImpl = async () => ({ ok: false, status: 999, text: async () => 'nope' });
        assert.equal(await fetchLiveClientVersion({ fetchImpl }), null);
    });
});

describe('assessTemplate', () => {
    it('flags the exact production failure (0.2.6546 vs 0.2.6815)', () => {
        const verdict = assessTemplate({
            template: templateAt('0.2.6546', '2026-07-31T01:13:03.000Z'),
            liveVersion: '0.2.6815',
            now: Date.parse('2026-08-18T19:00:00.000Z'),
        });
        assert.equal(verdict.stale, true);
        assert.equal(verdict.reason, 'version_lag');
        assert.equal(verdict.lag, 269);
    });

    it('leaves a current template alone', () => {
        const verdict = assessTemplate({
            template: templateAt('0.2.6832', '2026-08-18T19:33:24.847Z'),
            liveVersion: '0.2.6832',
            now: Date.parse('2026-08-18T19:40:00.000Z'),
        });
        assert.equal(verdict.stale, false);
        assert.equal(verdict.lag, 0);
    });

    it('tolerates ordinary build churn below the threshold', () => {
        const verdict = assessTemplate({
            template: templateAt('0.2.6800'),
            liveVersion: '0.2.6832',
            now: Date.now(),
        });
        assert.equal(verdict.stale, false, 'a 32-build lag is normal churn');
        assert.equal(verdict.lag, 32);
    });

    it('flags exactly above the threshold and not at it', () => {
        const base = 6000;
        const at = assessTemplate({
            template: templateAt(`0.2.${base}`),
            liveVersion: `0.2.${base + DEFAULT_MAX_VERSION_LAG}`,
            now: Date.now(),
        });
        const over = assessTemplate({
            template: templateAt(`0.2.${base}`),
            liveVersion: `0.2.${base + DEFAULT_MAX_VERSION_LAG + 1}`,
            now: Date.now(),
        });
        assert.equal(at.stale, false, 'exactly at the threshold is still fine');
        assert.equal(over.stale, true, 'one past the threshold is stale');
    });

    it('does NOT re-capture an old template that is provably current', () => {
        // Age alone must not condemn a template: re-capture costs a real
        // browser navigation against LinkedIn, which is itself traffic.
        const verdict = assessTemplate({
            template: templateAt('0.2.6832', '2026-07-01T00:00:00.000Z'),
            liveVersion: '0.2.6832',
            now: Date.parse('2026-08-18T00:00:00.000Z'),
        });
        assert.equal(verdict.stale, false);
    });

    it('falls back to age when the version cannot be compared at all', () => {
        // The safety net for LinkedIn changing its version format: without it,
        // an unparseable version would silently disable staleness detection.
        const verdict = assessTemplate({
            template: templateAt('weird-format', '2026-08-01T00:00:00.000Z'),
            liveVersion: null,
            now: Date.parse('2026-08-18T00:00:00.000Z'),
        });
        assert.equal(verdict.stale, true);
        assert.equal(verdict.reason, 'age_unverifiable_version');
    });

    it('holds no opinion when the live version is unknown and the template is young', () => {
        const verdict = assessTemplate({
            template: templateAt('0.2.6832', '2026-08-18T12:00:00.000Z'),
            liveVersion: null,
            now: Date.parse('2026-08-18T19:00:00.000Z'),
        });
        assert.equal(verdict.stale, false);
    });

    it('never reports stale for a NEWER captured version', () => {
        // Negative lag means our capture is ahead of what we read, which is a
        // measurement artifact (A/B bucket, CDN skew), never a reason to churn.
        const verdict = assessTemplate({
            template: templateAt('0.2.6832'),
            liveVersion: '0.2.6800',
            now: Date.now(),
        });
        assert.equal(verdict.stale, false);
        assert.equal(verdict.lag, -32);
    });
});

describe('looksLikeRefusedRequest', () => {
    it('flags a confirmed-empty on a broad control query', () => {
        // The signature of the outage: "hiring" over 24h cannot legitimately
        // be empty, so this is evidence about the REQUEST, not the account.
        assert.equal(
            looksLikeRefusedRequest({ emptyConfirmed: true, posts: 0, broadQuery: true }),
            true,
        );
    });

    it('does not flag a confirmed-empty on a narrow query', () => {
        // A narrow boolean query returning nothing is ordinary and must never
        // trigger a template re-capture.
        assert.equal(
            looksLikeRefusedRequest({ emptyConfirmed: true, posts: 0, broadQuery: false }),
            false,
        );
    });

    it('does not flag when posts came back', () => {
        assert.equal(
            looksLikeRefusedRequest({ emptyConfirmed: false, posts: 10, broadQuery: true }),
            false,
        );
    });
});
