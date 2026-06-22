import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchPersistentProfile, linkedInProfileDir } from '../../scrapers/linkedin.js';

// The launcher is injectable as the last arg so we can assert on the options
// without spinning up a real CloakBrowser. It returns a stub context.
function spyLauncher() {
    const calls = [];
    const fn = async (opts) => { calls.push(opts); return { __ctx: true }; };
    return { fn, calls };
}

test('launchPersistentProfile(): no-arg call is byte-identical to today (fixed dir, no proxy)', async () => {
    const spy = spyLauncher();
    const ctx = await launchPersistentProfile(undefined, spy.fn);
    assert.equal(spy.calls.length, 1);
    const opts = spy.calls[0];
    assert.equal(opts.userDataDir, linkedInProfileDir());
    assert.ok(!('proxy' in opts), 'no proxy key when proxy is null');
    assert.deepEqual(ctx, { __ctx: true });
});

test('launchPersistentProfile({}): empty options → legacy fixed dir, no proxy', async () => {
    const spy = spyLauncher();
    await launchPersistentProfile({}, spy.fn);
    const opts = spy.calls[0];
    assert.equal(opts.userDataDir, linkedInProfileDir());
    assert.ok(!('proxy' in opts));
});

test('launchPersistentProfile({ profileKey }): resolves the per-account userDataDir', async () => {
    const spy = spyLauncher();
    await launchPersistentProfile({ profileKey: 'acct-7' }, spy.fn);
    const opts = spy.calls[0];
    assert.equal(opts.userDataDir, `${linkedInProfileDir()}-acct-7`);
    assert.ok(!('proxy' in opts), 'still no proxy when only profileKey set');
});

test('launchPersistentProfile({ proxy }): threads proxy as { server } into launch options', async () => {
    const spy = spyLauncher();
    await launchPersistentProfile({ proxy: 'http://u:p@host:8080' }, spy.fn);
    const opts = spy.calls[0];
    assert.deepEqual(opts.proxy, { server: 'http://u:p@host:8080' });
});

test('launchPersistentProfile({ profileKey, proxy }): both threaded together', async () => {
    const spy = spyLauncher();
    await launchPersistentProfile({ profileKey: 'acct-9', proxy: 'socks5://1.2.3.4:1080' }, spy.fn);
    const opts = spy.calls[0];
    assert.equal(opts.userDataDir, `${linkedInProfileDir()}-acct-9`);
    assert.deepEqual(opts.proxy, { server: 'socks5://1.2.3.4:1080' });
});

test('launchPersistentProfile({ proxy }): parses pool "host:port:user:pass" into Playwright shape', async () => {
    const spy = spyLauncher();
    // The format stored in the credential pool (e.g. Decodo). Passing this raw
    // as { server } is an Invalid URL — it must be parsed into server/user/pass.
    await launchPersistentProfile({ proxy: 'isp.decodo.com:10001:sp0ac3m6sp:secretpass' }, spy.fn);
    const opts = spy.calls[0];
    assert.deepEqual(opts.proxy, {
        server: 'http://isp.decodo.com:10001',
        username: 'sp0ac3m6sp',
        password: 'secretpass',
    });
});

test('launchPersistentProfile: preserves the standard launch knobs', async () => {
    const spy = spyLauncher();
    await launchPersistentProfile({}, spy.fn);
    const opts = spy.calls[0];
    assert.equal(opts.humanize, true);
    assert.deepEqual(opts.viewport, { width: 1366, height: 900 });
    assert.equal(opts.locale, 'en-US');
    assert.equal(opts.timezoneId, 'America/New_York');
});
