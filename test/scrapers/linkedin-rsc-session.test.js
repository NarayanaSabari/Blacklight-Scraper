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
    templatePath,
    loadTemplate,
} from '../../src/scrapers/linkedin-rsc/session.js';
import { AuthError, NetworkError } from '../../src/core/errors.js';

function fakeCooldown() {
    return {
        writes: [],
        defaultWriteFile: () => () => {},
        defaultRename: () => () => {},
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

function makeSession({ lease = fakeLease(), cookieReader, ttlMs = 60000, now = () => 1000 } = {}) {
    const reads = { count: 0 };
    const session = new LinkedInRscSession({
        apiClient: { acquire: async () => lease },
        cookieReader: cookieReader ?? (async () => { reads.count++; return JAR; }),
        templateLoader: () => TEMPLATE,
        ttlMs,
        now,
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

test('withCookies: a profile with no li_at asks for a re-login', async () => {
    const { session } = makeSession({ cookieReader: async () => [{ name: 'lang', value: 'en' }] });
    await assert.rejects(
        () => session.withCookies('s', async () => 'unused'),
        (err) => err instanceof AuthError && err.code === 'NEEDS_RELOGIN',
    );
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
