import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformOverrides, UnknownPlatformError } from '../../src/panel/overrides.js';

const KNOWN = ['dice', 'indeed', 'glassdoor'];
const FILE = 'config/platform-overrides.json';

function fakeFs(initialFiles = {}) {
    const files = new Map(Object.entries(initialFiles));
    return {
        files,
        readFileSync(p) {
            if (!files.has(p)) {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            }
            return files.get(p);
        },
        writeFileSync(p, contents) { files.set(p, contents); },
        mkdirSync() { /* no-op */ },
    };
}

test('no file yet: nothing is paused', () => {
    const overrides = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs: fakeFs(), knownPlatforms: KNOWN });
    assert.deepEqual(overrides.pausedList(), []);
    assert.equal(overrides.isPaused('dice'), false);
});

test('pause() persists to disk and round-trips through a fresh instance', () => {
    const fs = fakeFs();
    const a = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs, knownPlatforms: KNOWN });
    a.pause('glassdoor');
    assert.deepEqual(a.pausedList(), ['glassdoor']);

    const b = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs, knownPlatforms: KNOWN });
    assert.deepEqual(b.pausedList(), ['glassdoor']);
    assert.equal(b.isPaused('glassdoor'), true);
});

test('resume() persists and round-trips', () => {
    const fs = fakeFs();
    const a = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs, knownPlatforms: KNOWN });
    a.pause('glassdoor');
    a.resume('glassdoor');
    assert.deepEqual(a.pausedList(), []);

    const b = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs, knownPlatforms: KNOWN });
    assert.deepEqual(b.pausedList(), []);
});

test('pause()/resume() on an unknown platform throws UnknownPlatformError', () => {
    const overrides = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs: fakeFs(), knownPlatforms: KNOWN });
    assert.throws(() => overrides.pause('not-a-real-platform'), UnknownPlatformError);
    assert.throws(() => overrides.resume('not-a-real-platform'), UnknownPlatformError);
});

test('a corrupt file is ignored (starts with nothing paused) rather than throwing at construction', () => {
    const fs = fakeFs({ 'config/platform-overrides.json': '{ not valid json' });
    assert.doesNotThrow(() => {
        const overrides = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs, knownPlatforms: KNOWN });
        assert.deepEqual(overrides.pausedList(), []);
    });
});

test('an unknown platform name in the file on disk is dropped, not trusted', () => {
    const fs = fakeFs({
        'config/platform-overrides.json': JSON.stringify({ paused: ['dice', 'not-a-real-platform'] }),
    });
    const overrides = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs, knownPlatforms: KNOWN });
    assert.deepEqual(overrides.pausedList(), ['dice']);
});

test('filterAllowed drops paused platforms from a candidate list', () => {
    const overrides = new PlatformOverrides({ filePath: 'config/platform-overrides.json', fs: fakeFs(), knownPlatforms: KNOWN });
    overrides.pause('indeed');
    assert.deepEqual(overrides.filterAllowed(['dice', 'indeed', 'glassdoor']), ['dice', 'glassdoor']);
});

// ─── per-platform sweep cadence (2026-08-03) ────────────────────────────
// Indeed was re-scraping every role every ~5 min for a 0.29% import rate.
// The interval lives here so an operator can retune it from the panel
// without a code deploy.

test('intervalMinutes: platforms without a built-in default claim every cycle', () => {
    // glassdoor and monster have no default and are not assigned to any host.
    // dice/techfetch USED to be the example here; they now ship a 20-minute
    // cadence because an uncapped browser platform pins a CloakBrowser seat.
    const o = new PlatformOverrides({ filePath: FILE, fs: fakeFs(), knownPlatforms: KNOWN, env: {} });
    assert.equal(o.intervalMinutes('glassdoor'), null);
});

test('indeed ships with a 60-minute default sweep', () => {
    const o = new PlatformOverrides({ filePath: FILE, fs: fakeFs(), knownPlatforms: KNOWN, env: {} });
    assert.equal(o.intervalMinutes('indeed'), 60);
});

test('env overrides the built-in default; the file overrides env', () => {
    const fsImpl = fakeFs();
    const env = { SCRAPE_INTERVAL_INDEED_MINUTES: '30' };
    const a = new PlatformOverrides({ filePath: FILE, fs: fsImpl, knownPlatforms: KNOWN, env });
    assert.equal(a.intervalMinutes('indeed'), 30, 'env beats the default');

    a.setInterval('indeed', 90);
    const b = new PlatformOverrides({ filePath: FILE, fs: fsImpl, knownPlatforms: KNOWN, env });
    assert.equal(b.intervalMinutes('indeed'), 90, 'an explicit panel value beats env');
});

test('turning the cadence OFF is not silently re-defaulted', () => {
    const fsImpl = fakeFs();
    const a = new PlatformOverrides({ filePath: FILE, fs: fsImpl, knownPlatforms: KNOWN, env: {} });
    a.setInterval('indeed', 0);
    assert.equal(a.intervalMinutes('indeed'), null);

    const b = new PlatformOverrides({ filePath: FILE, fs: fsImpl, knownPlatforms: KNOWN, env: {} });
    assert.equal(b.intervalMinutes('indeed'), null, 'stays off across a restart');
});

test('setInterval persists and round-trips through the file', () => {
    const fsImpl = fakeFs();
    const file = FILE;
    const a = new PlatformOverrides({ filePath: file, fs: fsImpl, knownPlatforms: KNOWN });
    a.setInterval('indeed', 60);
    assert.equal(a.intervalMinutes('indeed'), 60);

    const b = new PlatformOverrides({ filePath: file, fs: fsImpl, knownPlatforms: KNOWN });
    assert.equal(b.intervalMinutes('indeed'), 60, 'survives a restart');
});

test('setInterval(0 or null) clears the cadence', () => {
    const o = new PlatformOverrides({ filePath: FILE, fs: fakeFs(), knownPlatforms: KNOWN, env: {} });
    o.setInterval('indeed', 60);
    o.setInterval('indeed', 0);
    assert.equal(o.intervalMinutes('indeed'), null);
});

test('setInterval rejects an unknown platform', () => {
    const o = new PlatformOverrides({ filePath: FILE, fs: fakeFs(), knownPlatforms: KNOWN });
    assert.throws(() => o.setInterval('nope', 60), UnknownPlatformError);
});

test('pause and interval coexist in one file', () => {
    const fsImpl = fakeFs();
    const file = FILE;
    const a = new PlatformOverrides({ filePath: file, fs: fsImpl, knownPlatforms: KNOWN });
    a.pause('glassdoor');
    a.setInterval('indeed', 60);

    const b = new PlatformOverrides({ filePath: file, fs: fsImpl, knownPlatforms: KNOWN });
    assert.deepEqual(b.pausedList(), ['glassdoor']);
    assert.equal(b.intervalMinutes('indeed'), 60);
});

test('a garbage interval in the file is ignored, not fatal', () => {
    const fsImpl = fakeFs();
    const file = FILE;
    fsImpl.writeFileSync(file, JSON.stringify({
        paused: [], intervals: { indeed: 'soon', glassdoor: -5, nope: 60 },
    }));
    const o = new PlatformOverrides({ filePath: file, fs: fsImpl, knownPlatforms: KNOWN, env: {} });
    assert.equal(o.intervalMinutes('indeed'), 60, 'garbage ignored → falls back to the default');
    assert.equal(o.intervalMinutes('glassdoor'), null, 'garbage ignored → no default, every cycle');
});

// ── Browser platforms need a cadence too (production 2026-08-20) ───────────
//
// dice and techfetch shipped with no default cadence, so they re-claimed
// continuously. While dice was being served empty pages it turned over a
// session every ~1.3s (124 failed sessions in two minutes) and techfetch
// relaunched its browser every ~3s; between them they held both CloakBrowser
// seats, starving every other browser platform.
test('every browser platform has a default sweep cadence', () => {
    const o = new PlatformOverrides({
        filePath: FILE, fs: fakeFs(), env: {},
        knownPlatforms: ['dice', 'indeed', 'linkedin', 'techfetch'],
    });

    // The two that compete for CloakBrowser seats. An uncapped browser platform
    // is the one that can pin a seat indefinitely.
    assert.equal(o.intervalMinutes('dice'), 20);
    assert.equal(o.intervalMinutes('techfetch'), 20);

    // Unchanged.
    assert.equal(o.intervalMinutes('indeed'), 60);
    assert.equal(o.intervalMinutes('linkedin'), 30);
});

test('a deliberate operator 0 still wins over the new browser defaults', () => {
    // Raising a default must never silently override a host where someone
    // turned the cadence off on purpose.
    const fs = fakeFs({ [FILE]: JSON.stringify({ paused: [], intervals: { dice: 0 } }) });
    const o = new PlatformOverrides({
        filePath: FILE, fs, env: {},
        knownPlatforms: ['dice', 'indeed', 'linkedin', 'techfetch'],
    });
    assert.equal(o.intervalMinutes('dice'), null, 'a stored 0 means no cadence limit');
});
