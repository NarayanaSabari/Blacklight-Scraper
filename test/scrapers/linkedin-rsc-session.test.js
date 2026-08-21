// Session supply for the RSC transport: template loading, the cookie cache, and
// the credential lease lifecycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    LinkedInRscSession,
    cookieTtlMs,
    heartbeatIntervalMs,
    templatePath,
    loadTemplate,
} from '../../src/scrapers/linkedin-rsc/session.js';
import { AuthError, NetworkError } from '../../src/core/errors.js';

function fakeCooldown() {
    return {
        writes: [],
        defaultWriteFile: () => () => {},
        defaultRename: () => () => {},
        // Extend-only marker: the writer reads any existing claim so a quota
        // pause and an auth cooldown cannot truncate each other.
        defaultReadFile: () => () => { const e = new Error('none'); e.code = 'ENOENT'; throw e; },
        cooldownMs: () => 30 * 60 * 1000,
        cooldownPath: () => '/tmp/marker',
        writeCooldownMarker(opts) { this.writes.push(opts); },
    };
}

const JAR = [
    { name: 'li_at', value: 'AQEDAT-token', domain: '.www.linkedin.com' },
    { name: 'JSESSIONID', value: '"ajax:1"', domain: '.www.linkedin.com' },
];

const TEMPLATE = { url: 'https://x', headers: { 'user-agent': 'UA' }, postData: '{}' };

function fakeLease(overrides = {}) {
    return {
        credential: { id: 7, profile_key: null },
        released: 0,
        failures: [],
        async release() { this.released++; },
        async reportFailure(msg, cooldownMin, opts) { this.failures.push({ msg, cooldownMin, opts }); },
        ...overrides,
    };
}

// A scheduler whose interval never fires on its own — the test drives each tick
// so heartbeat behaviour is asserted deterministically, with no real timers.
function fakeScheduler() {
    const state = { fn: null, ms: null, cleared: 0 };
    return {
        state,
        scheduler: {
            setInterval: (fn, ms) => { state.fn = fn; state.ms = ms; return { id: 1 }; },
            clearInterval: () => { state.cleared++; },
        },
        // Fire one tick and let its async body settle.
        tick: async () => { await state.fn?.(); },
    };
}

function makeSession({
    lease = fakeLease(), cookieReader, ttlMs = 60000, now = () => 1000,
    templateLoader, cooldown, heartbeatMs, scheduler, isLocal,
} = {}) {
    const reads = { count: 0 };
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => lease, ...(isLocal === undefined ? {} : { isLocal }) },
        cookieReader: cookieReader ?? (async () => { reads.count++; return JAR; }),
        templateLoader: templateLoader ?? (() => TEMPLATE),
        ttlMs,
        now,
        cooldown,
        ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
        ...(scheduler ? { scheduler } : {}),
    });
    return { session, lease, reads };
}

// --- config helpers ---------------------------------------------------------

test('cookieTtlMs: defaults to 30 minutes and ignores garbage', () => {
    assert.equal(cookieTtlMs({}), 30 * 60 * 1000);
    assert.equal(cookieTtlMs({ LINKEDIN_RSC_COOKIE_TTL_MIN: '5' }), 5 * 60 * 1000);
    assert.equal(cookieTtlMs({ LINKEDIN_RSC_COOKIE_TTL_MIN: '0' }), 30 * 60 * 1000);
    assert.equal(cookieTtlMs({ LINKEDIN_RSC_COOKIE_TTL_MIN: 'abc' }), 30 * 60 * 1000);
});

test('heartbeatIntervalMs: defaults to 2 min and is clamped below the 10-min reaper', () => {
    assert.equal(heartbeatIntervalMs({}), 2 * 60 * 1000);
    assert.equal(heartbeatIntervalMs({ LINKEDIN_LEASE_HEARTBEAT_MIN: '1' }), 60 * 1000);
    assert.equal(heartbeatIntervalMs({ LINKEDIN_LEASE_HEARTBEAT_MIN: 'abc' }), 2 * 60 * 1000);
    assert.equal(heartbeatIntervalMs({ LINKEDIN_LEASE_HEARTBEAT_MIN: '0' }), 2 * 60 * 1000);
    // A misconfigured 15 min would put the lease back inside the reaper's reach,
    // which is exactly SCR-4 — cap it rather than honour it.
    assert.equal(heartbeatIntervalMs({ LINKEDIN_LEASE_HEARTBEAT_MIN: '15' }), 5 * 60 * 1000);
});

test('templatePath: honours the env override', () => {
    assert.equal(templatePath({ LINKEDIN_RSC_TEMPLATE: '/tmp/t.json' }), '/tmp/t.json');
    assert.match(templatePath({}), /config[/\\]linkedin-rsc-template\.json$/);
});

// --- loadTemplate -----------------------------------------------------------

test('loadTemplate: a missing template names the command that captures it', () => {
    // The operator has to run something; a bare ENOENT does not say what.
    try {
        loadTemplate(path.join(os.tmpdir(), 'definitely-absent-template.json'));
        assert.fail('expected a throw');
    } catch (err) {
        assert.ok(err instanceof AuthError);
        assert.equal(err.code, 'NEEDS_TEMPLATE');
        assert.match(err.message, /linkedin:rsc-template/);
    }
});

test('loadTemplate: rejects a template missing required fields', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rsc-')), 't.json');
    fs.writeFileSync(file, JSON.stringify({ url: 'https://x' }));   // no headers/postData
    assert.throws(() => loadTemplate(file), (err) => err.code === 'NEEDS_TEMPLATE');
});

test('loadTemplate: returns a complete template', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rsc-')), 't.json');
    fs.writeFileSync(file, JSON.stringify(TEMPLATE));
    assert.deepEqual(loadTemplate(file), TEMPLATE);
});

// --- withCookies: lease lifecycle ------------------------------------------

test('withCookies: hands the callback the cookie jar and the lease', async () => {
    const { session, lease } = makeSession();
    const seen = await session.withCookies('sess-1', async (cookies, held) => ({ cookies, held }));
    assert.deepEqual(seen.cookies, JAR);
    assert.equal(seen.held, lease);
});

test('withCookies: releases the lease on success', async () => {
    const { session, lease } = makeSession();
    await session.withCookies('s', async () => 'done');
    assert.equal(lease.released, 1);
});

test('withCookies: releases the lease when the scrape throws', async () => {
    const { session, lease } = makeSession();
    await assert.rejects(() => session.withCookies('s', async () => { throw new Error('boom'); }));
    assert.equal(lease.released, 1);
});

// --- withCookies: lease heartbeat (SCR-4) ----------------------------------
// A paginated RSC scrape can outlive the backend's 10-min stale-assignment
// reaper. Without these ticks the pool reclaims the credential mid-scrape and
// hands it to another worker.

test('withCookies: keeps the lease alive while the scrape runs', async () => {
    const beats = { count: 0 };
    const lease = fakeLease({ heartbeat: async () => { beats.count++; return { ok: true }; } });
    const { state, scheduler, tick } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });

    await session.withCookies('s', async () => {
        assert.equal(state.ms, 2 * 60 * 1000, 'ticker armed at the configured interval');
        await tick();
        await tick();
        return 'ok';
    });
    assert.equal(beats.count, 2, 'the held lease was pinged on every tick');
});

test('withCookies: stops the heartbeat once the scrape finishes', async () => {
    const lease = fakeLease({ heartbeat: async () => ({ ok: true }) });
    const { state, scheduler } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });
    await session.withCookies('s', async () => 'ok');
    assert.equal(state.cleared, 1, 'no ticker leaks past the scrape');
});

test('withCookies: stops the heartbeat when the scrape throws', async () => {
    const lease = fakeLease({ heartbeat: async () => ({ ok: true }) });
    const { state, scheduler } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });
    await assert.rejects(() => session.withCookies('s', async () => { throw new Error('boom'); }));
    assert.equal(state.cleared, 1);
});

test('withCookies: a superseded lease stops the ticker instead of pinging forever', async () => {
    // 409 from the backend means another worker owns this credential now. There
    // is nothing left to keep alive, so the ticker must give up.
    const beats = { count: 0 };
    const lease = fakeLease({
        heartbeat: async () => {
            beats.count++;
            return { ok: false, reason: 'superseded' };
        },
    });
    const { state, scheduler, tick } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });

    await session.withCookies('s', async () => {
        await tick();
        assert.equal(state.cleared, 1, 'ticker cleared on the superseded reply');
        await tick();   // a tick already queued must be a no-op
        return 'ok';
    });
    assert.equal(beats.count, 1, 'stopped after the terminal reply, did not keep pinging');
});

test('withCookies: an already-released lease stops the ticker (per-role reportSuccess)', async () => {
    // scraper.js calls reportSuccess() inside the callback, which releases the
    // lease; heartbeat() then answers 'no_lease'. That is terminal, not an error.
    const beats = { count: 0 };
    const lease = fakeLease({
        heartbeat: async () => { beats.count++; return { ok: false, reason: 'no_lease' }; },
    });
    const { state, scheduler, tick } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });

    await session.withCookies('s', async () => { await tick(); await tick(); return 'ok'; });
    assert.equal(beats.count, 1);
    assert.equal(state.cleared, 1);
});

test('withCookies: a transient heartbeat failure keeps ticking and never fails the scrape', async () => {
    const beats = { count: 0 };
    const lease = fakeLease({
        heartbeat: async () => {
            beats.count++;
            return { ok: false, reason: 'error', error: new Error('ETIMEDOUT') };
        },
    });
    const { state, scheduler, tick } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });

    const out = await session.withCookies('s', async () => { await tick(); await tick(); return 'ok'; });
    assert.equal(out, 'ok', 'a failed tick is invisible to the scrape');
    assert.equal(beats.count, 2, 'a network blip is retried on the next tick, not fatal');
    assert.equal(state.cleared, 1);
});

test('withCookies: a throwing heartbeat does not break the scrape', async () => {
    const lease = fakeLease({ heartbeat: async () => { throw new Error('unexpected'); } });
    const { scheduler, tick } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });
    const out = await session.withCookies('s', async () => { await tick(); return 'ok'; });
    assert.equal(out, 'ok');
});

test('withCookies: a lease with no heartbeat() support is handled, not crashed', async () => {
    // Local (single-account) mode issues leases without the pool's methods.
    const { state, scheduler } = fakeScheduler();
    const { session } = makeSession({ lease: fakeLease(), scheduler, isLocal: true });
    const out = await session.withCookies('s', async () => 'ok');
    assert.equal(out, 'ok');
    assert.equal(state.fn, null, 'no ticker armed when there is nothing to ping');
});

test('withCookies: a local session does not arm a heartbeat ticker', async () => {
    const beats = { count: 0 };
    const lease = fakeLease({ heartbeat: async () => { beats.count++; return { ok: true, local: true }; } });
    const { state, scheduler } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: true });

    const out = await session.withCookies('s', async () => 'ok');
    assert.equal(out, 'ok');
    assert.equal(state.fn, null);
    assert.equal(beats.count, 0);
});

test('withCookies: a local heartbeat reply stops a remote ticker', async () => {
    const beats = { count: 0 };
    const lease = fakeLease({
        heartbeat: async () => { beats.count++; return { ok: true, local: true }; },
    });
    const { state, scheduler, tick } = fakeScheduler();
    const { session } = makeSession({ lease, scheduler, isLocal: false });

    await session.withCookies('s', async () => {
        await tick();
        await tick();
        return 'ok';
    });
    assert.equal(beats.count, 1);
    assert.equal(state.cleared, 1);
});

test('withCookies: a sync release() does not crash the finally block', async () => {
    // Guard against masking the real error with a TypeError from the cleanup path.
    let released = false;
    const lease = fakeLease({ release() { released = true; } });   // sync, returns undefined
    const { session } = makeSession({ lease });
    const out = await session.withCookies('s', async () => 'ok');
    assert.equal(out, 'ok');
    assert.equal(released, true);
});

test('withCookies: no credential available surfaces as a skip, not a platform failure', async () => {
    // The orchestrator distinguishes this from a real scrape failure so dashboards
    // do not conflate "pool busy" with "platform broken".
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => null },
        cookieReader: async () => JAR,
        templateLoader: () => TEMPLATE,
    });
    await assert.rejects(
        () => session.withCookies('s', async () => 'unused'),
        (err) => err.skipNoCreds === true,
    );
});

test('withCookies: an unreachable pool surfaces as NetworkError', async () => {
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => { throw new Error('ECONNREFUSED'); } },
        cookieReader: async () => JAR,
        templateLoader: () => TEMPLATE,
    });
    await assert.rejects(() => session.withCookies('s', async () => 'unused'), NetworkError);
});

// --- withCookies: dead-credential reporting --------------------------------

test('withCookies: an AuthError reports the credential auth-dead so the pool stops serving it', async () => {
    // Without this the backend keeps the credential "available" and the queue
    // hands out LinkedIn roles that all instantly 403 — the fast-fail storm.
    const { session, lease } = makeSession();
    await assert.rejects(
        () => session.withCookies('s', async () => {
            throw new AuthError('403 — session dead', { platform: 'linkedin', code: 'NEEDS_RELOGIN' });
        }),
        AuthError,
    );
    assert.equal(lease.failures.length, 1);
    assert.equal(lease.failures[0].opts?.authDead, true);
});

test('withCookies: a non-auth failure does NOT mark the credential dead', async () => {
    // A parse bug or a 503 is not the account's fault; burning it would be wrong.
    const { session, lease } = makeSession();
    await assert.rejects(() => session.withCookies('s', async () => { throw new Error('parse blew up'); }));
    assert.equal(lease.failures.length, 0);
});

test('withCookies: an AuthError drops the cached jar so the next role re-reads it', async () => {
    const { session, reads } = makeSession();
    await assert.rejects(() => session.withCookies('s', async () => {
        throw new AuthError('dead', { platform: 'linkedin' });
    }), AuthError);
    await session.withCookies('s', async () => 'ok');
    assert.equal(reads.count, 2, 'expected the jar to be re-read after an auth failure');
});

test('withCookies: cookie caches are isolated by profile key', async () => {
    const jars = {
        alpha: [{ name: 'li_at', value: 'alpha' }],
        beta: [{ name: 'li_at', value: 'beta' }],
    };
    const leases = [
        fakeLease({ credential: { id: 1, profile_key: 'alpha' } }),
        fakeLease({ credential: { id: 2, profile_key: 'beta' } }),
    ];
    const reads = [];
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => leases.shift() },
        cookieReader: async ({ profileKey }) => {
            reads.push(profileKey);
            return jars[profileKey];
        },
        templateLoader: () => TEMPLATE,
    });

    const seen = [];
    await session.withCookies('a', async (cookies) => { seen.push(cookies[0].value); });
    await session.withCookies('b', async (cookies) => { seen.push(cookies[0].value); });

    assert.deepEqual(seen, ['alpha', 'beta']);
    assert.deepEqual(reads, ['alpha', 'beta']);
});

test('withCookies: a fresh cache for one profile does not satisfy another profile', async () => {
    const leases = [
        fakeLease({ credential: { id: 1, profile_key: 'alpha' } }),
        fakeLease({ credential: { id: 2, profile_key: 'beta' } }),
    ];
    const reads = [];
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => leases.shift() },
        cookieReader: async ({ profileKey }) => {
            reads.push(profileKey);
            return [{ name: 'li_at', value: profileKey }];
        },
        templateLoader: () => TEMPLATE,
        ttlMs: 60000,
        now: () => 1000,
    });

    await session.withCookies('a', async () => 'alpha');
    await session.withCookies('b', async () => 'beta');

    assert.deepEqual(reads, ['alpha', 'beta']);
});

test('withCookies: auth failure invalidates only the affected profile cache', async () => {
    const leases = [
        fakeLease({ credential: { id: 1, profile_key: 'alpha' } }),
        fakeLease({ credential: { id: 2, profile_key: 'beta' } }),
        fakeLease({ credential: { id: 3, profile_key: 'alpha' } }),
        fakeLease({ credential: { id: 4, profile_key: 'beta' } }),
        fakeLease({ credential: { id: 5, profile_key: 'alpha' } }),
    ];
    const reads = [];
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => leases.shift() },
        cookieReader: async ({ profileKey }) => {
            reads.push(profileKey);
            return [{ name: 'li_at', value: profileKey }];
        },
        templateLoader: () => TEMPLATE,
    });

    await session.withCookies('alpha-1', async () => 'ok');
    await session.withCookies('beta-1', async () => 'ok');
    await assert.rejects(() => session.withCookies('alpha-2', async () => {
        throw new AuthError('dead', { platform: 'linkedin', code: 'NEEDS_RELOGIN' });
    }), AuthError);

    await session.withCookies('beta-2', async () => 'ok');
    await session.withCookies('alpha-3', async () => 'ok');
    assert.deepEqual(reads, ['alpha', 'beta', 'alpha']);
});

// --- withCookies: cookie caching -------------------------------------------

test('withCookies: reuses the cached jar within the TTL, launching no second browser', async () => {
    // Each read launches a browser, and CloakBrowser seats are capped per licence
    // key — a queue of roles must not launch one apiece.
    const { session, reads } = makeSession({ ttlMs: 60000, now: () => 1000 });
    await session.withCookies('s1', async () => 'a');
    await session.withCookies('s2', async () => 'b');
    assert.equal(reads.count, 1);
});

test('withCookies: re-reads the jar once the TTL has elapsed', async () => {
    let clock = 1000;
    const { session, reads } = makeSession({ ttlMs: 5000, now: () => clock });
    await session.withCookies('s1', async () => 'a');
    clock += 6000;
    await session.withCookies('s2', async () => 'b');
    assert.equal(reads.count, 2);
});

test('withCookies: concurrent roles share ONE cookie read', async () => {
    let started = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { session } = makeSession({
        cookieReader: async () => { started++; await gate; return JAR; },
    });
    const both = Promise.all([
        session.withCookies('s1', async () => 'a'),
        session.withCookies('s2', async () => 'b'),
    ]);
    release();
    assert.deepEqual(await both, ['a', 'b']);
    assert.equal(started, 1, 'single-flight refresh should read cookies once');
});

test('withCookies: concurrent roles with different profiles do not share a cookie read', async () => {
    let started = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const leases = [
        fakeLease({ credential: { id: 1, profile_key: 'alpha' } }),
        fakeLease({ credential: { id: 2, profile_key: 'beta' } }),
    ];
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => leases.shift() },
        cookieReader: async ({ profileKey }) => {
            started++;
            await gate;
            return [{ name: 'li_at', value: profileKey }];
        },
        templateLoader: () => TEMPLATE,
    });

    const both = Promise.all([
        session.withCookies('a', async () => 'alpha'),
        session.withCookies('b', async () => 'beta'),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, 2);
    release();
    assert.deepEqual(await both, ['alpha', 'beta']);
});

test('withCookies: a profile with no li_at asks for a re-login', async () => {
    const { session } = makeSession({ cookieReader: async () => [{ name: 'lang', value: 'en' }] });
    await assert.rejects(
        () => session.withCookies('s', async () => 'unused'),
        (err) => err instanceof AuthError && err.code === 'NEEDS_RELOGIN',
    );
});

test('withCookies: NEEDS_TEMPLATE does not report the credential or pause locally', async () => {
    const cooldown = fakeCooldown();
    const { session, lease } = makeSession({
        cooldown,
        templateLoader: () => {
            throw new AuthError('template missing', { platform: 'linkedin', code: 'NEEDS_TEMPLATE' });
        },
    });

    await assert.rejects(() => session.withCookies('s', async () => session.template()), AuthError);

    assert.equal(lease.failures.length, 0);
    assert.equal(cooldown.writes.length, 0);
});

// --- storm protection -------------------------------------------------------

test('withCookies: a needs-relogin account pauses the platform locally', async () => {
    // Single-account host: with no other account to rotate to, a dead session must
    // pause LinkedIn or the orchestrator fires a role per cycle that instantly
    // 403s. This is the protection the DOM path provided via authFailCooldownPlan.
    const cooldown = fakeCooldown();
    const lease = fakeLease();
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => lease, isLocal: true },
        cookieReader: async () => JAR,
        templateLoader: () => TEMPLATE,
        cooldown,
    });
    await assert.rejects(() => session.withCookies('s', async () => {
        throw new AuthError('dead', { platform: 'linkedin', code: 'NEEDS_RELOGIN' });
    }), AuthError);
    assert.equal(cooldown.writes.length, 1);
});

test('withCookies: a REMOTE pool cools only the account, not the whole platform', async () => {
    // With a pool, the next lease rotates to a healthy account; pausing all of
    // LinkedIn over one dead account would be self-inflicted downtime.
    const cooldown = fakeCooldown();
    const lease = fakeLease();
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => lease, isLocal: false },
        cookieReader: async () => JAR,
        templateLoader: () => TEMPLATE,
        cooldown,
    });
    await assert.rejects(() => session.withCookies('s', async () => {
        throw new AuthError('dead', { platform: 'linkedin', code: 'NEEDS_RELOGIN' });
    }), AuthError);
    assert.equal(cooldown.writes.length, 0);
    assert.equal(lease.failures[0].opts?.authDead, true);
});

// --- server/health interface ------------------------------------------------

test('isAlive: false before any cookie read, true once a jar is cached', async () => {
    const { session } = makeSession();
    assert.equal(session.isAlive(), false);
    await session.withCookies('s', async () => 'ok');
    assert.equal(session.isAlive(), true);
});

test('shutdown: drops the cached jar (there is no browser to close)', async () => {
    const { session } = makeSession();
    await session.withCookies('s', async () => 'ok');
    await session.shutdown();
    assert.equal(session.isAlive(), false);
});
