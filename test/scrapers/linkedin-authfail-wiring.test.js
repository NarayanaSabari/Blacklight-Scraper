// Phase 3b — Task B (integration): prove the auth-fail catch site in
// scrapeLinkedIn is gated on session.isLocal, observing the REAL marker file.
//  • LOCAL session  → the platform cooldown marker file IS written (PR #310
//    storm-protection, byte-identical to today) AND lease.reportFailure called.
//  • REMOTE session → NO marker file written; only lease.reportFailure (the
//    pool cools the single account → next lease rotates).
// In BOTH cases the AuthError is re-thrown (role recorded/classified upstream).
//
// HOME is redirected to a throwaway temp dir so cooldownPath() (homedir-based)
// lands there instead of the operator's real homedir — we assert on the actual
// file the live code writes, not a mock.

import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrapeLinkedIn } from '../../scrapers/linkedin.js';
import { cooldownPath } from '../../src/core/linkedin-cooldown.js';
import {
    __setLinkedInSessionForTest,
    __resetLinkedInSessionForTest,
} from '../../src/scrapers/linkedin-session.js';
import { AuthError } from '../../src/core/errors.js';

const MARKER = '.blacklight-linkedin-cooldown';
let tmpHome;
let savedHome;

beforeEach(() => {
    savedHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-authfail-'));
    process.env.HOME = tmpHome;
});

afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    __resetLinkedInSessionForTest();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// A stub session whose withPage immediately throws an AuthError (cookies
// expired), exposing the mode via isLocal and recording reportFailure so the
// test can assert the credential-vs-platform split.
function stubSession({ isLocal }) {
    const calls = { reportFailure: 0, reestablish: 0 };
    const lease = {
        reportSuccess: async () => {},
        reportFailure: async () => { calls.reportFailure++; },
        release: async () => {},
        credential: { id: 1 },
    };
    return {
        calls,
        get isLocal() { return isLocal; },
        get isRemote() { return isLocal === false; },
        get lease() { return lease; },
        withPage: async () => { throw new AuthError('cookies expired', { platform: 'linkedin' }); },
        reestablish: async () => { calls.reestablish++; },
    };
}

function markerExists() {
    // cooldownPath() resolves under the redirected HOME for the duration of the test.
    return fs.existsSync(cooldownPath()) || fs.existsSync(path.join(tmpHome, MARKER));
}

test('Task B wiring: LOCAL session auth-fail ⇒ marker file written (storm-protection) + reportFailure; error re-thrown', async () => {
    const s = stubSession({ isLocal: true });
    __setLinkedInSessionForTest(s);

    await assert.rejects(() => scrapeLinkedIn('Engineer', 'NYC', 'sess-local'), AuthError);

    assert.equal(markerExists(), true, 'LOCAL writes the platform cooldown marker file');
    assert.equal(s.calls.reportFailure, 1, 'account still cooled via reportFailure');
});

test('Task B wiring: REMOTE session auth-fail ⇒ NO marker file; only reportFailure; error re-thrown', async () => {
    const s = stubSession({ isLocal: false });
    __setLinkedInSessionForTest(s);

    await assert.rejects(() => scrapeLinkedIn('Engineer', 'NYC', 'sess-remote'), AuthError);

    assert.equal(markerExists(), false, 'REMOTE does NOT write the platform marker file');
    assert.equal(s.calls.reportFailure, 1, 'REMOTE cools just the account (pool rotates next lease)');
});
