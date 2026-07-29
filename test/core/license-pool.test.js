import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LicensePool, loadLicenseKeys, parseKeyLine } from '../../src/core/license-pool.js';
import { __setLauncherForTest, launch, launchPersistentContext } from '../../src/core/browser-pool.js';
import { __resetLicensePoolForTest } from '../../src/core/license-pool.js';

// CloakBrowser enforces its session limit PER LICENCE KEY, globally. Verified
// live 2026-07-28: 2 browsers on one key → 1 alive, 1 killed with "Target page,
// context or browser has been closed"; two separate OS processes collide the
// same way. Since the orchestrator scrapes a role's platforms in parallel, a
// four-platform host was losing three browsers per assignment. Giving each
// launch its own key fixes it (2 keys → 2 concurrent browsers, both fine), so
// these guard the seat accounting that makes that safe.

test('parseKeyLine: trims, skips blanks and # comments', () => {
    assert.equal(parseKeyLine('  cb_abc  '), 'cb_abc');
    assert.equal(parseKeyLine(''), null);
    assert.equal(parseKeyLine('   '), null);
    assert.equal(parseKeyLine('# a comment'), null);
});

test('loadLicenseKeys: env wins over file, comma or newline, de-duped', () => {
    const deps = { existsSync: () => false, readFileSync: () => '' };
    assert.deepEqual(loadLicenseKeys({ CLOAKBROWSER_LICENSE_KEYS: 'k1,k2' }, deps), ['k1', 'k2']);
    assert.deepEqual(loadLicenseKeys({ CLOAKBROWSER_LICENSE_KEYS: 'k1\nk2\nk1' }, deps), ['k1', 'k2']);
    assert.deepEqual(loadLicenseKeys({}, deps), []);
    // File path used only when the env var is absent.
    const fileDeps = { existsSync: () => true, readFileSync: () => '# keys\nk9\n\nk8\n' };
    assert.deepEqual(loadLicenseKeys({}, fileDeps), ['k9', 'k8']);
    assert.deepEqual(loadLicenseKeys({ CLOAKBROWSER_LICENSE_KEYS: 'kenv' }, fileDeps), ['kenv']);
});

test('seat count equals key count', () => {
    assert.equal(new LicensePool(['a', 'b', 'c']).size, 3);
    assert.equal(new LicensePool(['a']).size, 1);
});

test('no keys configured still yields ONE seat carrying a null key', async () => {
    // Null key matters: it lets cloakbrowser resolve its own env/file key while
    // still serialising launches so they cannot kill each other.
    const pool = new LicensePool([]);
    assert.equal(pool.size, 1);
    const lease = await pool.acquire();
    assert.equal(lease.key, null);
    assert.deepEqual(pool.stats(), { seats: 1, inUse: 1, waiting: 0 });
});

test('acquire hands out each key once, then queues until a seat frees', async () => {
    const pool = new LicensePool(['k1', 'k2']);
    const a = await pool.acquire();
    const b = await pool.acquire();
    assert.deepEqual([a.key, b.key].sort(), ['k1', 'k2']);
    assert.deepEqual(pool.stats(), { seats: 2, inUse: 2, waiting: 0 });

    let third = null;
    const pending = pool.acquire().then((l) => { third = l; });
    await new Promise((r) => setImmediate(r));
    assert.equal(third, null, 'third caller must wait, not oversubscribe');
    assert.equal(pool.stats().waiting, 1);

    a.release();
    await pending;
    assert.equal(third.key, a.key, 'the freed seat is handed to the waiter');
    assert.deepEqual(pool.stats(), { seats: 2, inUse: 2, waiting: 0 });
});

test('release is idempotent — a double release cannot free a seat twice', async () => {
    const pool = new LicensePool(['k1']);
    const lease = await pool.acquire();
    lease.release();
    lease.release();
    assert.deepEqual(pool.stats(), { seats: 1, inUse: 0, waiting: 0 });
    // The seat is genuinely reusable, exactly once.
    const again = await pool.acquire();
    assert.equal(again.key, 'k1');
    assert.equal(pool.stats().inUse, 1);
});

test('queue is FIFO', async () => {
    const pool = new LicensePool(['only']);
    const held = await pool.acquire();
    const order = [];
    const p1 = pool.acquire().then((l) => { order.push('first'); l.release(); });
    const p2 = pool.acquire().then((l) => { order.push('second'); l.release(); });
    held.release();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ['first', 'second']);
});

// ---- browser-pool wiring ----

function fakeBrowser(closeImpl) {
    return { closed: 0, close: closeImpl ?? async function () { this.closed += 1; } };
}

test('launch injects the leased licenseKey and releases the seat on close', async () => {
    __resetLicensePoolForTest();
    process.env.CLOAKBROWSER_LICENSE_KEYS = 'key-one';
    const seen = [];
    __setLauncherForTest({ launch: async (opts) => { seen.push(opts); return fakeBrowser(); } });
    try {
        const b = await launch({ headless: true });
        assert.equal(seen[0].licenseKey, 'key-one');
        assert.equal(seen[0].headless, true, 'caller options are preserved');
        await b.close();
        // Seat freed, so a second launch succeeds on the single key.
        const b2 = await launch({});
        assert.equal(seen[1].licenseKey, 'key-one');
        await b2.close();
    } finally {
        delete process.env.CLOAKBROWSER_LICENSE_KEYS;
        __setLauncherForTest(null);
        __resetLicensePoolForTest();
    }
});

test('launch omits licenseKey entirely when no keys are configured', async () => {
    __resetLicensePoolForTest();
    delete process.env.CLOAKBROWSER_LICENSE_KEYS;
    // Point the file lookup at nothing: a real config/cloakbrowser-keys.txt on
    // the machine would otherwise load and make this test environment-dependent.
    process.env.CLOAKBROWSER_LICENSE_KEYS_FILE = '/nonexistent/cloakbrowser-keys.txt';
    const seen = [];
    __setLauncherForTest({ launch: async (opts) => { seen.push(opts); return fakeBrowser(); } });
    try {
        const b = await launch({ headless: false });
        // An explicit null would override cloakbrowser's own env/file resolution.
        assert.ok(!('licenseKey' in seen[0]), 'must not pass licenseKey: null');
        await b.close();
    } finally {
        delete process.env.CLOAKBROWSER_LICENSE_KEYS_FILE;
        __setLauncherForTest(null);
        __resetLicensePoolForTest();
    }
});

test('a failed launch does not hold a seat hostage', async () => {
    __resetLicensePoolForTest();
    process.env.CLOAKBROWSER_LICENSE_KEYS = 'solo';
    let calls = 0;
    __setLauncherForTest({
        launch: async () => { calls += 1; if (calls === 1) throw new Error('launch boom'); return fakeBrowser(); },
    });
    try {
        await assert.rejects(() => launch({}), /launch boom/);
        // If the seat leaked, this would hang forever rather than resolve.
        const b = await launch({});
        assert.ok(b);
        await b.close();
    } finally {
        delete process.env.CLOAKBROWSER_LICENSE_KEYS;
        __setLauncherForTest(null);
        __resetLicensePoolForTest();
    }
});

test('the seat is released even when close() throws', async () => {
    __resetLicensePoolForTest();
    process.env.CLOAKBROWSER_LICENSE_KEYS = 'solo';
    __setLauncherForTest({ launch: async () => fakeBrowser(async () => { throw new Error('close boom'); }) });
    try {
        const b = await launch({});
        await assert.rejects(() => b.close(), /close boom/);
        const b2 = await launch({});   // would hang if the seat leaked
        assert.ok(b2);
    } finally {
        delete process.env.CLOAKBROWSER_LICENSE_KEYS;
        __setLauncherForTest(null);
        __resetLicensePoolForTest();
    }
});

test('launchPersistentContext takes a seat too', async () => {
    __resetLicensePoolForTest();
    process.env.CLOAKBROWSER_LICENSE_KEYS = 'ctx-key';
    const seen = [];
    __setLauncherForTest({ launchPersistentContext: async (opts) => { seen.push(opts); return fakeBrowser(); } });
    try {
        const ctx = await launchPersistentContext({ userDataDir: '/tmp/x' });
        assert.equal(seen[0].licenseKey, 'ctx-key');
        assert.equal(seen[0].userDataDir, '/tmp/x');
        await ctx.close();
    } finally {
        delete process.env.CLOAKBROWSER_LICENSE_KEYS;
        __setLauncherForTest(null);
        __resetLicensePoolForTest();
    }
});
