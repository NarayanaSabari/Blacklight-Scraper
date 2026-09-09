// Client-version freshness for the captured LinkedIn RSC template.
//
// THE OUTAGE THIS PREVENTS
// The RSC transport replays a request template captured once from a real
// browser session. That template carries LinkedIn's client build number in
// `x-li-application-version`. LinkedIn ships new builds continuously, and once
// the captured version falls far enough behind, the endpoint stops honouring
// the request — but it does NOT return an error. It returns HTTP 200 with a
// perfectly well-formed "No results found" page, including the positive
// `HasNoresultsBindingKey` flag that the transport treats as authoritative
// proof of a genuine empty result.
//
// Measured in production 2026-08-18: the template was captured at client
// version 0.2.6546 on 07-31. By 15:00 UTC on 08-18 LinkedIn was on 0.2.6815 and
// EVERY query — including "hiring" over the past 24h — came back as a confirmed
// empty. A browser on the very same profile, at the same moment, saw live
// posts. So the account was healthy and the request was being refused.
//
// The damage was not just the lost scraping. Every one of those confirmed
// empties looked exactly like a shadow-banned account to the canary, which duly
// cooled both LinkedIn credentials for four hours each and reported them as
// banned. The pipeline went to a hard zero for five hours, and the recorded
// cause was wrong, which is the expensive part: the obvious remedies for a ban
// (wait it out, re-login, rotate accounts) all leave a stale template in place.
//
// WHY A VERSION CHECK IS THE RIGHT SIGNAL
// It is cheap, it is causal, and it is checkable without spending a search
// request: LinkedIn's current build number is served on any ordinary page load.
// Comparing it to the captured one turns an ambiguous, expensive-to-diagnose
// symptom ("everything is empty") into a specific, self-healing condition
// ("our template is N builds behind, re-capture it").

import { createLogger } from '../../logger/index.js';

const log = createLogger('linkedin-rsc:template-health');

// How far the captured build may lag before the template is presumed stale.
//
// Not zero: LinkedIn ships builds continuously. Two measured rates:
//
//   Burst:     0.2.6815 -> 0.2.6832 in 15 minutes on 2026-08-18 (>=1000 builds/day
//              during a deploy window). A template can fall 17 builds behind in an
//              afternoon when a big release lands.
//
//   Sustained: lag grew from 17 to 41 builds over ~24 hours in production on
//              2026-08-19/20 — roughly 24 builds/day at the current cadence.
//
// What broke production was a lag of ~269 builds accumulated over 18 days
// (captured 0.2.6546 on 07-31; broke at 0.2.6815 on 08-18 = ~14.9 builds/day
// average over that period).
//
// THRESHOLD RECONCILIATION (verified 2026-08-20):
// At 24 builds/day this 200-build lag threshold triggers at ~8.3 days.
// DEFAULT_MAX_AGE_MS below is 3 days — the blind-mode fallback when the live
// version cannot be read. 3 days x 24 builds/day = ~72 builds of accumulated
// uncertainty in the worst blind case, well below 200. The age cap is the more
// conservative guard, which is correct: it fires sooner precisely because the
// operator is flying blind. The lag threshold can afford more tolerance because
// the check gives a precise measurement.
//
// 200 also sits below the breaking point (269) across both the historical rate
// (14.9/day -> triggers at ~13.4 days) and the current rate (24/day -> ~8.3
// days), with enough margin that a burst deploy never races past the threshold
// undetected between checks (check interval is 4 hours; the worst-case 4-hour
// burst in the 08-18 data was well under 200 builds).
export const DEFAULT_MAX_VERSION_LAG = 200;

// A template older than this is re-captured regardless of version numbers,
// because version parsing is best-effort: if LinkedIn changes the format of
// `x-li-application-version`, the numeric comparison silently stops working and
// age is the only remaining signal. Belt and braces, deliberately.
export const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function maxVersionLag(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_TEMPLATE_MAX_VERSION_LAG ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_VERSION_LAG;
}

export function maxTemplateAgeMs(env = process.env) {
    const n = Number.parseInt(String(env?.LINKEDIN_TEMPLATE_MAX_AGE_HOURS ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n * 60 * 60 * 1000 : DEFAULT_MAX_AGE_MS;
}

/**
 * Parse a LinkedIn client version ("0.2.6815") into a comparable integer.
 *
 * Only the last component actually moves in practice, but all three are folded
 * in so a major/minor bump is not read as a huge regression.
 *
 * @returns {number|null} null when the shape is unrecognised
 */
export function parseClientVersion(value) {
    const raw = String(value ?? '').trim();
    const m = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    const [, major, minor, build] = m;
    return (Number(major) * 1e10) + (Number(minor) * 1e7) + Number(build);
}

/** The client version recorded in a captured template, or null. */
export function templateClientVersion(template) {
    return template?.headers?.['x-li-application-version'] ?? null;
}

// LinkedIn embeds its build number in every page it serves, but the markup is
// escaped differently depending on where it lands: plain JSON, HTML-entity
// encoded (`&quot;`), and backslash-escaped inside an embedded JSON string.
// Observed on a live /feed/ fetch, 2026-08-18:
//
//   &quot;serviceVersion&quot;:&quot;0.2.6832&quot;
//   \"appVersion\":\"0.2.6832\"
//   \"version\":\"0.2.6832\"          (urn:li:application:(web,flagship-web))
//
// So each pattern is anchored on a version KEY and tolerates any of the three
// quote encodings between the key and the value. Anchoring matters: the same
// page carries `0.1.49623` for a different component, and an unanchored match
// would compare our client version against something unrelated.
//
// `mpVersion` is deliberately excluded — it tracks alongside serviceVersion
// today, but it names the multiproduct rather than the web client, and pinning
// staleness to the wrong identifier is exactly the class of bug this file exists
// to prevent.
const QUOTE = '(?:"|&quot;|\\\\+")';
const VERSION_PATTERNS = [
    new RegExp(`${QUOTE}serviceVersion${QUOTE}\\s*:\\s*${QUOTE}(\\d+\\.\\d+\\.\\d+)`),
    new RegExp(`${QUOTE}appVersion${QUOTE}\\s*:\\s*${QUOTE}(\\d+\\.\\d+\\.\\d+)`),
    new RegExp(`${QUOTE}applicationVersion${QUOTE}\\s*:\\s*${QUOTE}(\\d+\\.\\d+\\.\\d+)`),
    // Last resort, and the most specific of the lot: the flagship-web
    // application URN names the component explicitly, so the `version` that
    // follows it is unambiguous even though the key itself is generic.
    new RegExp(`flagship-web\\)[^]{0,80}?${QUOTE}version${QUOTE}\\s*:\\s*${QUOTE}(\\d+\\.\\d+\\.\\d+)`),
];

/**
 * Scrape LinkedIn's CURRENT client version out of an ordinary page body.
 * @returns {string|null}
 */
export function extractLiveClientVersion(html) {
    const body = String(html ?? '');
    for (const re of VERSION_PATTERNS) {
        const m = body.match(re);
        if (m?.[1]) return m[1];
    }
    return null;
}

/**
 * Fetch LinkedIn's current client version.
 *
 * Deliberately hits an ordinary page rather than a search: this must be usable
 * precisely when we suspect search is being refused, and it must not spend the
 * account's search budget to answer "are we stale?".
 *
 * `/feed/` is used because it carries the version even when fetched WITHOUT
 * cookies (verified 2026-08-18), which keeps this check available even if the
 * session is dead — the case where knowing whether the template is stale
 * matters most. `/jobs/` anonymously serves a different marketing bundle whose
 * `data-app-version` (2.1.x) is NOT the flagship client version, so it must not
 * be used here.
 *
 * Never throws — an unknown version is reported as null and callers treat that
 * as "no opinion", which fails toward leaving a working template alone.
 */
export async function fetchLiveClientVersion({
    fetchImpl = fetch,
    url = 'https://www.linkedin.com/feed/',
    userAgent,
    timeoutMs = 15000,
} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            headers: {
                accept: 'text/html,application/xhtml+xml',
                'accept-language': 'en-US,en;q=0.9',
                ...(userAgent ? { 'user-agent': userAgent } : {}),
            },
            signal: controller.signal,
        });
        if (!res?.ok) return null;
        return extractLiveClientVersion(await res.text());
    } catch (err) {
        log.warn('Could not read LinkedIn client version', { err: err?.message });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Decide whether a captured template should be re-captured.
 *
 * Returns a verdict rather than acting, so the caller owns the (expensive,
 * browser-driving) refresh decision and this stays trivially testable.
 *
 * `liveUnknown` in the return distinguishes two superficially identical states:
 *
 *   checked AND healthy -> stale: false, lag: 0,    live: '0.2.6832', liveUnknown: false
 *   checked but BLIND   -> stale: false, lag: null, live: null,        liveUnknown: true
 *
 * A caller (or the control panel) that only looks at `stale` cannot tell these
 * apart. The 2026-08-20 production panel showed `stale: false, live: null,
 * lag: null` — presented as "template is fine" when the true meaning was "we
 * have no idea". Operators and alerts must treat `liveUnknown: true` as a
 * degraded-observability condition, NOT a confirmation of health.
 *
 * @returns {{stale: boolean, reason: string|null, lag: number|null,
 *            captured: string|null, live: string|null, ageMs: number|null,
 *            liveUnknown: boolean}}
 */
export function assessTemplate({
    template,
    liveVersion = null,
    now = Date.now(),
    maxLag = maxVersionLag(),
    maxAgeMs = maxTemplateAgeMs(),
} = {}) {
    const captured = templateClientVersion(template);
    const capturedAt = template?.capturedAt ? Date.parse(template.capturedAt) : NaN;
    const ageMs = Number.isFinite(capturedAt) ? now - capturedAt : null;

    const capturedNum = parseClientVersion(captured);
    const liveNum = parseClientVersion(liveVersion);
    const lag = (capturedNum !== null && liveNum !== null) ? liveNum - capturedNum : null;

    // True when the live version could not be fetched at all. `live: null` is
    // then an observability gap, not evidence that the template is current.
    const liveUnknown = liveVersion === null;

    // Version lag is the primary, causal signal.
    if (lag !== null && lag > maxLag) {
        return {
            stale: true,
            reason: 'version_lag',
            lag,
            captured,
            live: liveVersion,
            ageMs,
            liveUnknown: false,   // lag is known, so live was read successfully
        };
    }

    // Age is the fallback for when the version could not be compared at all.
    // Applied ONLY in that case: a template that is provably current by version
    // should not be thrown away just for being old, since re-capture costs a
    // browser launch and a real navigation against LinkedIn.
    if (lag === null && ageMs !== null && ageMs > maxAgeMs) {
        return {
            stale: true,
            reason: 'age_unverifiable_version',
            lag: null,
            captured,
            live: liveVersion,
            ageMs,
            liveUnknown,
        };
    }

    return { stale: false, reason: null, lag, captured, live: liveVersion, ageMs, liveUnknown };
}

/**
 * True when a scrape result carries the signature of a refused request rather
 * than a genuinely empty search.
 *
 * The distinction the whole module exists for: LinkedIn answers BOTH with
 * `emptyConfirmed`. What separates them is breadth. A narrow boolean query
 * legitimately returns nothing; a control query like "hiring" over 24 hours
 * does not. So a confirmed-empty on a KNOWN-BROAD query is evidence about the
 * REQUEST, not about the account — and that is the case where re-capturing the
 * template is the correct response and cooling the credential is the wrong one.
 */
export function looksLikeRefusedRequest({ emptyConfirmed, posts = 0, broadQuery = false }) {
    return Boolean(emptyConfirmed) && posts === 0 && broadQuery;
}

export { log as templateHealthLog };
