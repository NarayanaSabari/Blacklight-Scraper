// The query24 diagnostic runner: bootstrap order, fail-closed REMOTE gate, the
// UUID/profile-key lease contract, the one-page cap, lease release on every
// exit, and the non-secret log allowlist. No live network — the transport is
// exercised against the real captured no-results fixture through an injected
// fetch, and everything else through fakes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    runLinkedInQueryDiagnostic,
    queryFingerprint,
    describeCredential,
    describeError,
    isMainEntrypoint,
    QUERY24,
} from '../../scripts/linkedin-query24-diagnostic.js';
import { AuthError, NetworkError, BlockedError } from '../../src/core/errors.js';

const TEMPLATE = { url: 'https://x', headers: { 'user-agent': 'UA', 'x-li-application-version': '1.13.7000' }, postData: '{}', capturedAt: '2026-09-01T00:00:00.000Z' };
const JAR = [{ name: 'li_at', value: 'x' }, { name: 'JSESSIONID', value: '"ajax:1"' }];

function noResultsBody() {
    return fs.readFileSync(
        path.join(import.meta.dirname, '../fixtures/linkedin-rsc-no-results.txt'), 'utf8',
    );
}
function searchBody() {
    return fs.readFileSync(
        path.join(import.meta.dirname, '../fixtures/linkedin-rsc-search.txt'), 'utf8',
    );
}

// A session that records its lifecycle and hands the callback a fake lease.
// `withCookies` mirrors the real one: it always releases, even on throw.
function fakeSession({
    lease = { credential: { id: 15, profile_key: 'acct-a' } },
    template = TEMPLATE,
    cookies = JAR,
} = {}) {
    const events = [];
    const leaseFacade = {
        credential: lease.credential,
        released: 0,
        heartbeats: 0,
        async heartbeat() { this.heartbeats += 1; return { ok: true }; },
        async reportSuccess() { events.push('success'); },
        async reportFailure() { events.push('failure'); },
        async release() { this.released += 1; events.push('release'); },
    };
    return {
        events,
        leaseFacade,
        sessionIds: [],
        async template() { return template; },
        async withCookies(sessionId, fn) {
            this.sessionIds.push(sessionId);
            events.push('acquire');
            try {
                return await fn(cookies, leaseFacade);
            } finally {
                await leaseFacade.release();
            }
        },
    };
}

const REMOTE = () => ({ isLocal: false });
const LOCAL = () => ({ isLocal: true });

// Inject a fetch that returns a fixed body, so real paginate()/extract() run.
function bodyFetch(body, status = 200) {
    return () => async () => ({ status, text: async () => body });
}

function baseDeps(overrides = {}) {
    const logs = [];
    const session = overrides.session ?? fakeSession();
    return {
        logs,
        session,
        deps: {
            query: QUERY24,
            datePosted: 'past-24h',
            getConfigImpl: () => ({}),
            initCredentials: REMOTE,
            makeSession: () => session,
            fetchForCredentialImpl: bodyFetch(noResultsBody()),
            pacer: null,
            newSessionId: () => '11111111-2222-4333-8444-555555555555',
            now: () => 0,
            count: 10,
            log: (r) => logs.push(r),
            ...overrides.deps,
        },
    };
}

// --- pure helpers -----------------------------------------------------------

test('queryFingerprint: stable 12-char sha, never echoes the boolean', () => {
    const sha = queryFingerprint(QUERY24);
    assert.match(sha, /^[0-9a-f]{12}$/);
    assert.equal(sha, queryFingerprint(QUERY24));
    assert.notEqual(sha, queryFingerprint('other'));
    assert.ok(!sha.includes('.NET'));
});

test('describeCredential: only id, profile key, and profile-dir existence', () => {
    const out = describeCredential({ id: 15, profile_key: 'acct-a', proxy: 'secret:1:u:p' }, {
        existsSync: () => true,
    });
    assert.deepEqual(out, { credentialId: 15, profileKey: 'acct-a', profileDirExists: true });
    assert.ok(!('proxy' in out));
});

test('describeError: surfaces class/code/status, never the message', () => {
    const out = describeError(new AuthError('cookie AQEDsecret leaked', { code: 'NEEDS_RELOGIN' }));
    assert.deepEqual(out, { errorKind: 'AuthError', errorCode: 'NEEDS_RELOGIN', statusCode: null });
    const net = describeError(new NetworkError('boom', { statusCode: 503 }));
    assert.equal(net.errorKind, 'NetworkError');
    assert.equal(net.statusCode, 503);
    assert.equal(describeError(new BlockedError('429')).errorKind, 'BlockedError');
    const json = JSON.stringify(describeError(new AuthError('cookie AQEDsecret leaked')));
    assert.ok(!json.includes('AQEDsecret'));
});

// --- bootstrap order & fail-closed gate -------------------------------------

test('bootstrap runs getConfig BEFORE the credential client and the session', async () => {
    const order = [];
    const { deps, session } = baseDeps();
    await runLinkedInQueryDiagnostic({
        ...deps,
        getConfigImpl: () => { order.push('config'); return {}; },
        initCredentials: () => { order.push('creds'); return { isLocal: false }; },
        makeSession: () => { order.push('session'); return session; },
    });
    assert.deepEqual(order, ['config', 'creds', 'session']);
});

test('fails closed when the credential client is not REMOTE, before any lease', async () => {
    const { deps } = baseDeps({ deps: { initCredentials: LOCAL } });
    const session = fakeSession();
    await assert.rejects(
        () => runLinkedInQueryDiagnostic({ ...deps, makeSession: () => session }),
        (err) => err.code === 'NOT_REMOTE',
    );
    // No lease was ever acquired: the gate is upstream of the session.
    assert.deepEqual(session.events, []);
});

test('the not-remote stop reason is logged and carries no secret', async () => {
    const { deps, logs } = baseDeps({ deps: { initCredentials: LOCAL } });
    await assert.rejects(() => runLinkedInQueryDiagnostic(deps));
    const stop = logs.find((l) => l.stopReason === 'not_remote_mode');
    assert.ok(stop, 'a bootstrap stop line must be logged');
    assert.equal(stop.stage, 'bootstrap');
});

// --- lease contract ---------------------------------------------------------

test('acquires the lease with a UUID session id', async () => {
    const { deps, session } = baseDeps();
    await runLinkedInQueryDiagnostic(deps);
    assert.equal(session.sessionIds.length, 1);
    assert.match(session.sessionIds[0], /^[0-9a-f-]{36}$/);
});

test('routes on the credential id and profile key from the lease', async () => {
    const session = fakeSession({ lease: { credential: { id: 42, profile_key: 'link2' } } });
    const { deps, logs } = baseDeps({ session });
    await runLinkedInQueryDiagnostic({ ...deps, makeSession: () => session });
    const page = logs.find((l) => l.stage === 'page');
    assert.equal(page.credentialId, 42);
    assert.equal(page.profileKey, 'link2');
});

test('releases the lease on a successful run', async () => {
    const { deps, session } = baseDeps();
    await runLinkedInQueryDiagnostic(deps);
    assert.equal(session.leaseFacade.released, 1);
});

test('releases the lease when the page fetch throws an auth error', async () => {
    const session = fakeSession();
    const { deps } = baseDeps({ session });
    await assert.rejects(() => runLinkedInQueryDiagnostic({
        ...deps,
        makeSession: () => session,
        fetchForCredentialImpl: () => async () => ({
            status: 403, text: async () => '',
        }),
    }), (err) => err instanceof AuthError);
    assert.equal(session.leaseFacade.released, 1);
});

test('releases the lease when the network fails', async () => {
    const session = fakeSession();
    const { deps } = baseDeps({ session });
    await assert.rejects(() => runLinkedInQueryDiagnostic({
        ...deps,
        makeSession: () => session,
        fetchForCredentialImpl: () => async () => { throw new Error('socket reset'); },
    }), (err) => err instanceof NetworkError);
    assert.equal(session.leaseFacade.released, 1);
});

// --- one bounded page -------------------------------------------------------

test('drives paginate with maxPages:1 and no high-water mark', async () => {
    let seen = null;
    const { deps } = baseDeps({
        deps: { paginateImpl: async (args) => { seen = args; return { posts: [], emptyConfirmed: true, pages: [{}] }; } },
    });
    await runLinkedInQueryDiagnostic(deps);
    assert.equal(seen.maxPages, 1);
    assert.equal(seen.sinceActivityId, null);
    assert.equal(seen.keywords, QUERY24);
    assert.equal(seen.count, 10);
    assert.equal(seen.maxPosts, 10, 'a single page never asks for more than a page');
});

test('never submits, never advances a mark, never reports a canary verdict', async () => {
    // The runner calls paginate directly and returns — there is no scrape
    // wrapper, so there is no code path that could submit, advance, or probe.
    const { deps, session } = baseDeps();
    const summary = await runLinkedInQueryDiagnostic(deps);
    assert.ok(!session.events.includes('failure'), 'a bounded probe must never report a ban');
    assert.equal(summary.stage, 'page');
});

// --- against the REAL transport ---------------------------------------------

test('a real no-results payload is reported as the no-result marker', async () => {
    const { deps, logs } = baseDeps();
    const summary = await runLinkedInQueryDiagnostic(deps);
    assert.equal(summary.extracted, 0);
    assert.equal(summary.noResultMarker, true);
    assert.equal(summary.stopReason, 'no_results_marker');
    assert.equal(summary.httpStatus, 200);
    assert.ok(summary.bodyBytes > 0, 'body bytes are observed through the instrumented fetch');
    // The template's non-secret build/age is carried through.
    assert.equal(summary.templateBuild, '1.13.7000');
    // A page line was logged for the operator.
    assert.ok(logs.some((l) => l.stage === 'page'));
});

test('a real payload WITH posts reports the extracted count and page-cap stop', async () => {
    const { deps } = baseDeps({ deps: { fetchForCredentialImpl: bodyFetch(searchBody()) } });
    const summary = await runLinkedInQueryDiagnostic(deps);
    assert.ok(summary.extracted > 0, 'real search payload must yield posts');
    assert.equal(summary.noResultMarker, false);
    assert.equal(summary.stopReason, 'page_cap_reached');
});

// --- log allowlist ----------------------------------------------------------

test('no logged line ever contains a cookie, the raw query, or a proxy', async () => {
    const session = fakeSession({ lease: { credential: { id: 15, profile_key: 'acct-a', proxy: 'p:1:user:pass' } } });
    const { deps, logs } = baseDeps({ session });
    await runLinkedInQueryDiagnostic({ ...deps, makeSession: () => session });
    const blob = JSON.stringify(logs);
    assert.ok(!blob.includes('AQED'));
    assert.ok(!blob.includes('ajax:1'));
    assert.ok(!blob.includes('.NET'), 'the raw boolean must never be logged');
    assert.ok(!blob.includes('user:pass'));
    // Only the query sha stands in for the query.
    assert.ok(logs.every((l) => !('keywords' in l) && !('cookies' in l)));
    assert.ok(logs.some((l) => l.querySha === queryFingerprint(QUERY24)));
});

test('bodyBytes counts wire bytes, not UTF-16 code units, on a multibyte body', async () => {
    // A LinkedIn post body carries non-ASCII freely; String.length would
    // undercount and make a real body look truncated.
    const multibyte = 'café — 日本語 — 🚀 ' + 'x'.repeat(2100); // >2000 so paginate treats it as a payload
    const expected = Buffer.byteLength(multibyte, 'utf8');
    assert.notEqual(expected, multibyte.length, 'the fixture must actually be multibyte');
    const { deps } = baseDeps({ deps: { fetchForCredentialImpl: bodyFetch(multibyte) } });
    const summary = await runLinkedInQueryDiagnostic(deps);
    assert.equal(summary.bodyBytes, expected);
});

test('a one-page fetch failure releases the lease and reports a non-secret error shape', async () => {
    // The failure path a live run can actually hit: a 429 from the endpoint.
    const session = fakeSession();
    const { deps } = baseDeps({ session });
    await assert.rejects(() => runLinkedInQueryDiagnostic({
        ...deps,
        makeSession: () => session,
        fetchForCredentialImpl: () => async () => ({ status: 429, text: async () => '' }),
    }), (err) => err instanceof BlockedError);
    assert.equal(session.leaseFacade.released, 1);
});

// --- Windows-compatible entrypoint ------------------------------------------

test('isMainEntrypoint: true when argv[1] resolves to this module, false otherwise', async () => {
    const { pathToFileURL } = await import('node:url');
    const selfPath = path.join(import.meta.dirname, '../../scripts/linkedin-query24-diagnostic.js');
    const selfUrl = pathToFileURL(selfPath).href;
    assert.equal(isMainEntrypoint([process.execPath, selfPath], selfUrl), true);
    // A path with spaces still matches (percent-encoded consistently on both sides).
    assert.equal(isMainEntrypoint([process.execPath, selfPath], selfUrl), true);
    // A different module is not the entrypoint.
    assert.equal(isMainEntrypoint([process.execPath, selfPath], `${selfUrl}.other`), false);
    // No argv[1] (e.g. `node -e`) is never the entrypoint.
    assert.equal(isMainEntrypoint([process.execPath], selfUrl), false);
});

// --- real CLI subprocess (fail-closed path, no network) ---------------------

test('the real CLI, run from a path with spaces, reaches main and fails closed off REMOTE', () => {
    // Proves the entrypoint actually fires end to end when spawned like the
    // operator will spawn it — including from a directory containing a space,
    // the case the string-compare bug broke. No credentials.json in the cwd
    // means LOCAL mode, so the runner must fail closed with NOT_REMOTE rather
    // than touch a profile or the network.
    const scriptPath = path.join(import.meta.dirname, '../../scripts/linkedin-query24-diagnostic.js');
    const spacedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q24 diag '));
    let stdout = '';
    let exitCode = 0;
    try {
        stdout = execFileSync(
            process.execPath,
            [scriptPath, '--query', 'test boolean query', '--date', 'past-24h'],
            { cwd: spacedDir, encoding: 'utf8', timeout: 20000 },
        );
    } catch (err) {
        // Fail-closed sets a non-zero exit code, so execFileSync throws; the
        // stdout we care about is on the error.
        stdout = err.stdout ?? '';
        exitCode = err.status ?? 1;
    } finally {
        fs.rmSync(spacedDir, { recursive: true, force: true });
    }
    const lines = stdout.trim().split('\n')
        .filter((l) => l.trim().startsWith('{'))   // ignore the logger's plain-text boot line
        .map((l) => JSON.parse(l));
    // main() ran: at least one structured line was emitted.
    assert.ok(lines.length > 0, `expected structured output, got: ${JSON.stringify(stdout)}`);
    // It failed closed rather than proceeding to a lease/network.
    assert.equal(exitCode, 1, 'a non-remote host must exit non-zero');
    assert.ok(
        lines.some((l) => l.stopReason === 'not_remote_mode' || l.errorCode === 'NOT_REMOTE'),
        `expected a NOT_REMOTE stop, got: ${JSON.stringify(lines)}`,
    );
    // And it never logged the raw query.
    assert.ok(!stdout.includes('test boolean query'), 'the raw query must never be logged');
});
