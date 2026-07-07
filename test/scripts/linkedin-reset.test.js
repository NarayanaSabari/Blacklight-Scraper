import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileBaseDir, findProfiles, selectProfiles, runReset } from '../../scripts/linkedin-reset.js';

// Build a scripted, injectable ask (answers consumed in order).
function scriptedAsk(answers) {
    let i = 0;
    const fn = async () => answers[i++];
    fn.close = () => {};
    return fn;
}

// Fresh temp home with the given profile dirs pre-created; returns { base }.
function makeProfiles(keys) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lireset-'));
    const base = path.join(home, '.blacklight-linkedin-profile');
    for (const k of keys) {
        const dir = k === '(default)' ? base : `${base}-${k}`;
        fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    }
    fs.mkdirSync(path.join(home, '.blacklight-indeed-profile'), { recursive: true }); // must survive
    return { home, base };
}

test('profileBaseDir honours LINKEDIN_PROFILE_DIR, else homedir default', () => {
    assert.equal(profileBaseDir({ LINKEDIN_PROFILE_DIR: '/custom/dir' }, '/home/x'), '/custom/dir');
    assert.equal(profileBaseDir({}, '/home/x'), path.join('/home/x', '.blacklight-linkedin-profile'));
});

test('findProfiles discovers base + per-account dirs, ignores unrelated entries', () => {
    const base = '/home/x/.blacklight-linkedin-profile';
    const siblings = [
        '.blacklight-linkedin-profile',
        '.blacklight-linkedin-profile-li-acct-1',
        '.blacklight-linkedin-profile-li-acct-2',
        '.blacklight-indeed-profile',        // different platform — ignore
        '.blacklight-linkedin-cooldown',     // marker file, not a profile — ignore
        'somethingelse',
    ];
    const found = findProfiles(base, siblings);
    assert.deepEqual(found.map((p) => p.key).sort(), ['(default)', 'li-acct-1', 'li-acct-2']);
    assert.equal(found.find((p) => p.key === 'li-acct-1').dir,
        path.join('/home/x', '.blacklight-linkedin-profile-li-acct-1'));
});

test('selectProfiles: blank cancels, all matches everything', () => {
    const profiles = [
        { key: '(default)', dir: 'd0' },
        { key: 'li-acct-1', dir: 'd1' },
        { key: 'li-acct-2', dir: 'd2' },
    ];
    assert.deepEqual(selectProfiles(profiles, ''), []);
    assert.deepEqual(selectProfiles(profiles, '   '), []);
    assert.equal(selectProfiles(profiles, 'all').length, 3);
});

test('selectProfiles: "default" targets only the base profile', () => {
    const profiles = [{ key: '(default)', dir: 'd0' }, { key: 'li-acct-1', dir: 'd1' }];
    assert.deepEqual(selectProfiles(profiles, 'default'), [{ key: '(default)', dir: 'd0' }]);
});

test('selectProfiles: a key targets exactly that profile (case-insensitive, sanitized)', () => {
    const profiles = [{ key: 'li-acct-1', dir: 'd1' }, { key: 'li-acct-2', dir: 'd2' }];
    assert.deepEqual(selectProfiles(profiles, 'li-acct-1'), [{ key: 'li-acct-1', dir: 'd1' }]);
    assert.deepEqual(selectProfiles(profiles, 'LI-ACCT-2'), [{ key: 'li-acct-2', dir: 'd2' }]);
    // a key that maps to no dir → no accidental deletes
    assert.deepEqual(selectProfiles(profiles, 'li-acct-9'), []);
});

test('runReset deletes ONLY the selected profile, leaves the rest', async () => {
    const { home, base } = makeProfiles(['(default)', 'li-acct-1', 'li-acct-2']);
    const code = await runReset({
        env: { LINKEDIN_PROFILE_DIR: base },
        ask: scriptedAsk(['li-acct-1', 'y']),
        checkRunning: async () => false,
        out() {}, err() {},
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(`${base}-li-acct-1`), false, 'selected profile deleted');
    assert.equal(fs.existsSync(`${base}-li-acct-2`), true, 'other account untouched');
    assert.equal(fs.existsSync(base), true, 'default profile untouched');
    assert.equal(fs.existsSync(path.join(home, '.blacklight-indeed-profile')), true, 'indeed untouched');
});

test('runReset "all" wipes every linkedin profile but not indeed', async () => {
    const { home, base } = makeProfiles(['(default)', 'li-acct-1', 'li-acct-2']);
    const code = await runReset({
        env: { LINKEDIN_PROFILE_DIR: base }, ask: scriptedAsk(['all', 'y']),
        checkRunning: async () => false, out() {}, err() {},
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(base), false);
    assert.equal(fs.existsSync(`${base}-li-acct-1`), false);
    assert.equal(fs.existsSync(`${base}-li-acct-2`), false);
    assert.equal(fs.existsSync(path.join(home, '.blacklight-indeed-profile')), true);
});

test('runReset refuses (exit 2) while the scraper is running — deletes nothing', async () => {
    const { base } = makeProfiles(['li-acct-1']);
    const code = await runReset({
        env: { LINKEDIN_PROFILE_DIR: base }, ask: scriptedAsk(['li-acct-1', 'y']),
        checkRunning: async () => true, out() {}, err() {},
    });
    assert.equal(code, 2);
    assert.equal(fs.existsSync(`${base}-li-acct-1`), true, 'nothing deleted while scraper up');
});

test('runReset: declining confirmation deletes nothing', async () => {
    const { base } = makeProfiles(['li-acct-1']);
    const code = await runReset({
        env: { LINKEDIN_PROFILE_DIR: base }, ask: scriptedAsk(['li-acct-1', 'n']),
        checkRunning: async () => false, out() {}, err() {},
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(`${base}-li-acct-1`), true);
});
