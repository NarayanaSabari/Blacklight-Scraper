import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileDirFor, linkedInProfileDir } from '../../scrapers/linkedin.js';

test('profileDirFor: null profileKey → legacy fixed dir (byte-identical)', () => {
    assert.equal(profileDirFor(null), linkedInProfileDir());
});

test('profileDirFor: undefined profileKey → legacy fixed dir', () => {
    assert.equal(profileDirFor(undefined), linkedInProfileDir());
});

test('profileDirFor: empty-string profileKey → legacy fixed dir', () => {
    assert.equal(profileDirFor(''), linkedInProfileDir());
});

test('profileDirFor: truthy profileKey → per-account sibling dir derived from base', () => {
    const base = linkedInProfileDir();
    assert.equal(profileDirFor('acct-7'), `${base}-acct-7`);
});

test('profileDirFor: per-account dir is deterministic', () => {
    assert.equal(profileDirFor('foo'), profileDirFor('foo'));
});

test('profileDirFor: filesystem-unsafe chars in key are sanitized', () => {
    const base = linkedInProfileDir();
    // path separators / dots / spaces must not escape the base dir
    const dir = profileDirFor('a/b\\c..d e');
    assert.equal(dir, `${base}-a_b_c__d_e`);
    assert.ok(!dir.includes('/b'), 'no embedded path separator from the key');
    assert.ok(!dir.includes('..'), 'no parent-dir traversal from the key');
});
