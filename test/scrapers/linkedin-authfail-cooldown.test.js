// Phase 3b — Task B: local↔pool cooldown reconciliation at the auth-fail site.
//
// On a single account's AuthError (cookies expired / auth-wall):
//  • LOCAL mode (isLocal === true, the live single-account box): UNCHANGED —
//    write the platform-wide local cooldown marker (PR #310 storm-protection).
//  • REMOTE mode (isLocal === false): do NOT write the platform-wide marker;
//    only the pool cools the single ACCOUNT (lease.reportFailure) so the next
//    lease rotates to a healthy account. The platform-wide marker is reserved
//    for pool-exhausted / pool-unreachable (Task A) — i.e. genuinely no account
//    to rotate to.
//
// The decision is a pure helper so it's unit-testable without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authFailCooldownPlan } from '../../scrapers/linkedin.js';

test('Task B: LOCAL mode auth-fail ⇒ write platform marker (byte-identical to today)', () => {
    const plan = authFailCooldownPlan({ isLocal: true });
    assert.equal(plan.writePlatformMarker, true);
});

test('Task B: REMOTE mode single auth-fail ⇒ do NOT write platform marker (only reportFailure)', () => {
    const plan = authFailCooldownPlan({ isLocal: false });
    assert.equal(plan.writePlatformMarker, false);
});

test('Task B: missing/undefined mode is treated as LOCAL (fail-safe: preserve storm-protection)', () => {
    // If we cannot positively tell we are remote, default to the live local
    // behavior so we never silently drop PR #310 storm-protection.
    assert.equal(authFailCooldownPlan({ isLocal: undefined }).writePlatformMarker, true);
    assert.equal(authFailCooldownPlan({}).writePlatformMarker, true);
});
