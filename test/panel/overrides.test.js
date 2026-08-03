import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformOverrides, UnknownPlatformError } from '../../src/panel/overrides.js';

const KNOWN = ['dice', 'indeed', 'glassdoor'];

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
