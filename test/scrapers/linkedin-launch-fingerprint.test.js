import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchPersistentProfile, fingerprintSeedFor, fingerprintPlatform } from '../../scrapers/linkedin.js';

test('fingerprintPlatform: macos on a Mac host, windows elsewhere, env override wins', () => {
    assert.equal(fingerprintPlatform({}, 'darwin'), 'macos');
    assert.equal(fingerprintPlatform({}, 'win32'), 'windows');
    assert.equal(fingerprintPlatform({}, 'linux'), 'windows');
    assert.equal(fingerprintPlatform({ LINKEDIN_FINGERPRINT_PLATFORM: 'linux' }, 'darwin'), 'linux');
    assert.equal(fingerprintPlatform({ LINKEDIN_FINGERPRINT_PLATFORM: 'WINDOWS' }, 'darwin'), 'windows');
    assert.equal(fingerprintPlatform({ LINKEDIN_FINGERPRINT_PLATFORM: '' }, 'win32'), 'windows');
});

test('launchPersistentProfile pins per-account fingerprint + HOST-AWARE platform', async () => {
    let opts;
    const fakeLauncher = async (o) => { opts = o; return { close: async () => {} }; };
    await launchPersistentProfile({ profileKey: 'li-acct-1', proxy: null }, fakeLauncher);
    const seed = fingerprintSeedFor('li-acct-1');
    assert.ok(opts.args.includes(`--fingerprint=${seed}`), 'pins the deterministic seed');
    assert.ok(
        opts.args.includes(`--fingerprint-platform=${fingerprintPlatform()}`),
        'pins the host-appropriate fingerprint platform',
    );
});

test('launchPersistentProfile (legacy, no profileKey) does NOT pin fingerprint', async () => {
    let opts;
    const fakeLauncher = async (o) => { opts = o; return { close: async () => {} }; };
    await launchPersistentProfile({}, fakeLauncher);
    assert.ok(!(opts.args || []).some((a) => a.startsWith('--fingerprint=')), 'legacy unchanged');
});
