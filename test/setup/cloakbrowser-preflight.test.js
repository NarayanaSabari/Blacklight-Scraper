// CloakBrowser preflight for `npm run linkedin:login`.
//
// Context: on 2026-07-30 LinkedIn's login served an unsolvable reCAPTCHA loop on
// the Windows host. Unlicensed CloakBrowser runs Chromium v146 while the current
// build is v150 — a stale browser build is exactly what a CAPTCHA wall exists to
// catch. The licence that unlocks v150 is free, so the preflight asks for one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseVersion, isNewerVersion, looksLikeLicenseKey, npmBin,
    ensureLicenseKey, updateCloakBrowser, cloakbrowserPreflight, KEYS_FILE,
} from '../../src/setup/cloakbrowser-preflight.js';

// ------------------------------------------------------------ versions

test('isNewerVersion compares numerically, not lexically', () => {
    // The bug a string compare produces: "0.5.9" > "0.5.10" alphabetically.
    assert.equal(isNewerVersion('0.5.10', '0.5.9'), true);
    assert.equal(isNewerVersion('0.5.9', '0.5.10'), false);
    assert.equal(isNewerVersion('0.5.3', '0.5.2'), true);
    assert.equal(isNewerVersion('0.5.2', '0.5.2'), false);
    assert.equal(isNewerVersion('0.6.0', '0.5.99'), true);
    assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
});

test('isNewerVersion is safe on missing/odd input', () => {
    assert.equal(isNewerVersion(null, '0.5.2'), false);
    assert.equal(isNewerVersion('0.5.3', null), false);
    assert.equal(isNewerVersion('v0.5.3', '0.5.2'), true);   // leading v tolerated
});

test('parseVersion pads short versions', () => {
    assert.deepEqual(parseVersion('1'), [1, 0, 0]);
    assert.deepEqual(parseVersion('1.2'), [1, 2, 0]);
    assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
});

test('npmBin uses the .cmd shim on Windows', () => {
    assert.equal(npmBin('win32'), 'npm.cmd');
    assert.equal(npmBin('darwin'), 'npm');
});

// ------------------------------------------------------------ key shape

test('looksLikeLicenseKey accepts real key shapes, rejects paste accidents', () => {
    assert.equal(looksLikeLicenseKey('cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978'), true);
    assert.equal(looksLikeLicenseKey('ABCD-1234-EFGH-5678'), true);
    // paste accidents
    assert.equal(looksLikeLicenseKey(''), false);
    assert.equal(looksLikeLicenseKey('   '), false);
    assert.equal(looksLikeLicenseKey('short'), false);
    assert.equal(looksLikeLicenseKey('https://cloakbrowser.dev/free'), false);
    assert.equal(looksLikeLicenseKey('my key with spaces'), false);
    assert.equal(looksLikeLicenseKey(null), false);
});

// ------------------------------------------------------------ licence prompt

function fakeAsk(answer) {
    const fn = async () => answer;
    fn.secret = async () => answer;
    fn.close = () => {};
    return fn;
}

test('a configured key means no prompt at all', async () => {
    let asked = false;
    const ask = fakeAsk('should-not-be-used');
    ask.secret = async () => { asked = true; return 'x'; };
    const r = await ensureLicenseKey({
        ask, env: {}, out: () => {},
        deps: { loadLicenseKeys: () => ['existing-key'] },
    });
    assert.equal(r.status, 'already');
    assert.equal(asked, false, 'must not ask when a key is already configured');
});

test('a pasted key is written 0600 and applied to the running process', async () => {
    const writes = [];
    const env = {};
    const r = await ensureLicenseKey({
        ask: fakeAsk('cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978'),
        env, cwd: '/repo', out: () => {},
        deps: {
            loadLicenseKeys: () => [],
            readHomeLicenseKey: () => null,
            writeSecret: (p, data) => writes.push([p, data]),
            isIgnored: () => true,
            mkdirSync: () => {},
        },
    });
    assert.equal(r.status, 'saved');
    assert.equal(writes.length, 1);
    assert.match(writes[0][0], /cloakbrowser-keys\.txt$/);
    assert.equal(writes[0][1], 'cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978\n');
    // Applied in-process so the login that follows is licensed without a restart.
    assert.equal(env.CLOAKBROWSER_LICENSE_KEYS, 'cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978');
});

test('pressing Enter declines and writes nothing', async () => {
    const writes = [];
    const r = await ensureLicenseKey({
        ask: fakeAsk(''), env: {}, out: () => {},
        deps: { loadLicenseKeys: () => [], readHomeLicenseKey: () => null, writeSecret: (...a) => writes.push(a), isIgnored: () => true },
    });
    assert.equal(r.status, 'declined');
    assert.deepEqual(writes, []);
});

test('EOF / Ctrl-D declines rather than writing null', async () => {
    const writes = [];
    const r = await ensureLicenseKey({
        ask: fakeAsk(null), env: {}, out: () => {},
        deps: { loadLicenseKeys: () => [], readHomeLicenseKey: () => null, writeSecret: (...a) => writes.push(a), isIgnored: () => true },
    });
    assert.equal(r.status, 'declined');
    assert.deepEqual(writes, []);
});

test('REFUSES to write the key when the target is not git-ignored', async () => {
    const writes = [];
    const r = await ensureLicenseKey({
        ask: fakeAsk('cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978'),
        env: {}, out: () => {},
        deps: { loadLicenseKeys: () => [], readHomeLicenseKey: () => null, writeSecret: (...a) => writes.push(a), isIgnored: () => false },
    });
    assert.equal(r.status, 'invalid');
    assert.deepEqual(writes, [], 'a secret must never be written to a tracked path');
});

test('the prompt never echoes the key back through out()', async () => {
    const lines = [];
    const KEY = 'cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978';
    await ensureLicenseKey({
        ask: fakeAsk(KEY), env: {}, out: (l) => lines.push(String(l)),
        deps: { loadLicenseKeys: () => [], readHomeLicenseKey: () => null, writeSecret: () => {}, isIgnored: () => true },
    });
    assert.ok(!lines.some((l) => l.includes(KEY)), 'licence key must not be logged');
});

// ------------------------------------------------------------ update

test('no update attempted when already current', () => {
    const calls = [];
    const r = updateCloakBrowser({
        out: () => {},
        deps: {
            readInstalledVersion: () => '0.5.3',
            readLatestVersion: () => '0.5.3',
            exec: (...a) => calls.push(a),
        },
    });
    assert.equal(r.status, 'current');
    assert.deepEqual(calls, [], 'must not run npm install when current');
});

test('installs the newer version when one exists', () => {
    const calls = [];
    const r = updateCloakBrowser({
        out: () => {},
        deps: {
            readInstalledVersion: () => '0.5.2',
            readLatestVersion: () => '0.5.3',
            exec: (cmd, args) => calls.push([cmd, args]),
        },
    });
    assert.equal(r.status, 'updated');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], ['install', 'cloakbrowser@0.5.3', '--save']);
});

test('an unreachable registry is not fatal', () => {
    const r = updateCloakBrowser({
        out: () => {},
        deps: { readInstalledVersion: () => '0.5.2', readLatestVersion: () => null },
    });
    assert.equal(r.status, 'unknown');
});

test('a failed npm install is not fatal — the login still proceeds', () => {
    const r = updateCloakBrowser({
        out: () => {},
        deps: {
            readInstalledVersion: () => '0.5.2',
            readLatestVersion: () => '0.5.3',
            exec: () => { throw new Error('EACCES'); },
        },
    });
    assert.equal(r.status, 'failed');
    assert.equal(r.from, '0.5.2');
});

// ------------------------------------------------------------ ordering

test('licence is resolved BEFORE the update, so the new binary runs licensed', async () => {
    const order = [];
    await cloakbrowserPreflight({
        ask: fakeAsk(''), env: {}, out: () => {},
        deps: {
            loadLicenseKeys: () => { order.push('license'); return ['k']; },
            updateCloakBrowser: () => { order.push('update'); return { status: 'current' }; },
            prewarmBinary: async () => { order.push('binary'); return { status: 'ready' }; },
        },
    });
    assert.deepEqual(order, ['license', 'update', 'binary']);
});

test('preflight never throws when every step fails', async () => {
    const r = await cloakbrowserPreflight({
        ask: fakeAsk(null), env: {}, out: () => {},
        deps: {
            loadLicenseKeys: () => [],
            readHomeLicenseKey: () => null,
            writeSecret: () => {},
            isIgnored: () => true,
            updateCloakBrowser: () => ({ status: 'failed', from: '0.5.2', to: '0.5.3' }),
            prewarmBinary: async () => ({ status: 'failed' }),
        },
    });
    assert.equal(r.license.status, 'declined');
    assert.equal(r.update.status, 'failed');
    assert.equal(r.binary.status, 'failed');
});

test('KEYS_FILE is the path license-pool actually reads', async () => {
    const { default: fs } = await import('node:fs');
    assert.equal(KEYS_FILE, 'config/cloakbrowser-keys.txt');
    // and it must be git-ignored, since it holds a secret
    assert.ok(fs.readFileSync('.gitignore', 'utf8').includes(KEYS_FILE));
});

test('a filesystem failure still licenses THIS run rather than losing the login', async () => {
    const env = {};
    const KEY = 'cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978';
    const r = await ensureLicenseKey({
        ask: fakeAsk(KEY), env, cwd: '/nonexistent', out: () => {},
        deps: {
            loadLicenseKeys: () => [],
            readHomeLicenseKey: () => null,
            isIgnored: () => true,
            mkdirSync: () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; },
            writeSecret: () => {},
        },
    });
    assert.equal(r.status, 'saved-transient');
    assert.equal(env.CLOAKBROWSER_LICENSE_KEYS, KEY, 'key must still apply in-process');
});

test('a host licensed via ~/.cloakbrowser/license.key is NOT prompted', async () => {
    // license-pool does not look there, but cloakbrowser itself does — prompting
    // an already-licensed host would be pure noise.
    let asked = false;
    const ask = fakeAsk('');
    ask.secret = async () => { asked = true; return ''; };
    const r = await ensureLicenseKey({
        ask, env: {}, out: () => {},
        deps: { loadLicenseKeys: () => [], readHomeLicenseKey: () => 'cb_livekey_from_home' },
    });
    assert.equal(r.status, 'already');
    assert.equal(asked, false);
});

test('no key anywhere DOES prompt', async () => {
    let asked = false;
    const ask = fakeAsk('');
    ask.secret = async () => { asked = true; return ''; };
    await ensureLicenseKey({
        ask, env: {}, out: () => {},
        deps: { loadLicenseKeys: () => [], readHomeLicenseKey: () => null },
    });
    assert.equal(asked, true);
});

// ---------------------------------------------- navigation verification
//
// The regression these guard: shipped preflight checked only that the binary
// LAUNCHED. On the Windows host 2026-07-30 a licensed CloakBrowser launched fine
// and then every navigation died with "Target page, context or browser has been
// closed"; the same code without the key returned HTTP 200. The operator was
// handed a browser that closed itself at the login page.

test('verifyNavigation reports ok when a page loads', async () => {
    const { verifyNavigation } = await import('../../src/setup/cloakbrowser-preflight.js');
    const r = await verifyNavigation({ out: () => {}, deps: { navigationProbe: async () => ({ ok: true, status: 200 }) } });
    assert.equal(r.status, 'ok');
});

test('verifyNavigation reports broken on the exact m1 failure', async () => {
    const { verifyNavigation } = await import('../../src/setup/cloakbrowser-preflight.js');
    const r = await verifyNavigation({
        out: () => {},
        deps: { navigationProbe: async () => { throw new Error('page.goto: Target page, context or browser has been closed'); } },
    });
    assert.equal(r.status, 'broken');
    assert.match(r.detail, /has been closed/);
});

test('a key that breaks navigation is ROLLED BACK and re-verified', async () => {
    const { cloakbrowserPreflight } = await import('../../src/setup/cloakbrowser-preflight.js');
    let keyActive = false;
    let rolled = false;
    const calls = [];
    const r = await cloakbrowserPreflight({
        ask: fakeAsk('cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978'), env: {}, out: () => {},
        deps: {
            loadLicenseKeys: () => [],
            readHomeLicenseKey: () => null,
            isIgnored: () => true,
            mkdirSync: () => {},
            writeSecret: () => { keyActive = true; },
            updateCloakBrowser: () => ({ status: 'current' }),
            prewarmBinary: async () => ({ status: 'ready' }),
            rollbackLicense: () => { rolled = true; keyActive = false; return true; },
            // broken while the key is active, fine once rolled back
            verifyNavigation: async () => {
                calls.push(keyActive);
                return keyActive ? { status: 'broken', detail: 'closed' } : { status: 'ok', detail: 'HTTP 200' };
            },
        },
    });
    assert.equal(rolled, true, 'must roll the key back');
    assert.equal(r.rolledBack, true);
    assert.equal(r.navigation.status, 'ok', 'must re-verify after rollback and report the recovered state');
    assert.deepEqual(calls, [true, false], 'verified once with the key, once without');
});

test('a PRE-EXISTING key is never rolled back — we did not apply it', async () => {
    const { cloakbrowserPreflight } = await import('../../src/setup/cloakbrowser-preflight.js');
    let rolled = false;
    const r = await cloakbrowserPreflight({
        ask: fakeAsk(''), env: {}, out: () => {},
        deps: {
            loadLicenseKeys: () => ['pre-existing'],
            updateCloakBrowser: () => ({ status: 'current' }),
            prewarmBinary: async () => ({ status: 'ready' }),
            rollbackLicense: () => { rolled = true; return true; },
            verifyNavigation: async () => ({ status: 'broken', detail: 'closed' }),
        },
    });
    assert.equal(rolled, false, 'only a key applied in THIS run may be rolled back');
    assert.equal(r.navigation.status, 'broken', 'but the breakage is still reported');
});

test('working navigation never triggers a rollback', async () => {
    const { cloakbrowserPreflight } = await import('../../src/setup/cloakbrowser-preflight.js');
    let rolled = false;
    const r = await cloakbrowserPreflight({
        ask: fakeAsk('cb_6f3a91d2c4e57b8a0d1f2e3c4b5a6978'), env: {}, out: () => {},
        deps: {
            loadLicenseKeys: () => [], readHomeLicenseKey: () => null, isIgnored: () => true,
            mkdirSync: () => {}, writeSecret: () => {},
            updateCloakBrowser: () => ({ status: 'current' }),
            prewarmBinary: async () => ({ status: 'ready' }),
            rollbackLicense: () => { rolled = true; return true; },
            verifyNavigation: async () => ({ status: 'ok', detail: 'HTTP 200' }),
        },
    });
    assert.equal(rolled, false);
    assert.equal(r.navigation.status, 'ok');
});
