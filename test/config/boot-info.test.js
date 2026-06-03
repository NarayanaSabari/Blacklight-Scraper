import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBootInfo } from '../../src/config/boot-info.js';

const fixedDeps = (overrides = {}) => ({
    env: { LINKEDIN_HEADLESS: 'false', SCRAPER_STRICT_EMPTY: 'false' },
    execSync: () => Buffer.from('abc1234\n'),
    readPkg: () => ({ version: '2.0.0' }),
    profileDir: () => '/tmp/linkedin-profile',
    now: () => new Date('2026-06-03T12:34:56.000Z'),
    nodeVersion: 'v24.5.0',
    pid: 4242,
    ...overrides,
});

test('resolveBootInfo: returns the boot identity fields', () => {
    const info = resolveBootInfo(fixedDeps());
    assert.equal(info.pid, 4242);
    assert.equal(info.gitSha, 'abc1234');
    assert.equal(info.bootedAt, '2026-06-03T12:34:56.000Z');
    assert.equal(info.nodeVersion, 'v24.5.0');
    assert.equal(info.pkgVersion, '2.0.0');
    assert.equal(info.profileDir, '/tmp/linkedin-profile');
    assert.equal(info.headless, false);
    assert.equal(info.strict, false);
});

test('resolveBootInfo: GIT_SHA env wins over `git rev-parse`', () => {
    const info = resolveBootInfo(fixedDeps({
        env: { GIT_SHA: 'deadbeef', LINKEDIN_HEADLESS: 'true', SCRAPER_STRICT_EMPTY: 'true' },
        execSync: () => { throw new Error('must not be called'); },
    }));
    assert.equal(info.gitSha, 'deadbeef');
    assert.equal(info.headless, true);
    assert.equal(info.strict, true);
});

test('resolveBootInfo: missing git falls back to "unknown"', () => {
    const info = resolveBootInfo(fixedDeps({
        env: {},
        execSync: () => { throw new Error('git not found'); },
    }));
    assert.equal(info.gitSha, 'unknown');
});

test('resolveBootInfo: trims trailing whitespace from git output', () => {
    const info = resolveBootInfo(fixedDeps({ execSync: () => Buffer.from('   ff00aa1\n\n') }));
    assert.equal(info.gitSha, 'ff00aa1');
});

test('resolveBootInfo: headless/strict default false when env unset', () => {
    const info = resolveBootInfo(fixedDeps({ env: {} }));
    assert.equal(info.headless, false);
    assert.equal(info.strict, false);
});
