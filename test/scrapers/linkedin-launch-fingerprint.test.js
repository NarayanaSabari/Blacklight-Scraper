import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchPersistentProfile, fingerprintSeedFor } from '../../scrapers/linkedin.js';

test('launchPersistentProfile pins per-account fingerprint + windows platform', async () => {
    let opts;
    const fakeLauncher = async (o) => { opts = o; return { close: async () => {} }; };
    await launchPersistentProfile({ profileKey: 'li-acct-1', proxy: null }, fakeLauncher);
    const seed = fingerprintSeedFor('li-acct-1');
    assert.ok(opts.args.includes(`--fingerprint=${seed}`), 'pins the deterministic seed');
    assert.ok(opts.args.includes('--fingerprint-platform=windows'), 'pins windows platform');
});

test('launchPersistentProfile (legacy, no profileKey) does NOT pin fingerprint', async () => {
    let opts;
    const fakeLauncher = async (o) => { opts = o; return { close: async () => {} }; };
    await launchPersistentProfile({}, fakeLauncher);
    assert.ok(!(opts.args || []).some((a) => a.startsWith('--fingerprint=')), 'legacy unchanged');
});
