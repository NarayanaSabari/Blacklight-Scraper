import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    archiveName,
    pruneArchives,
    rotateConfig,
    rotateFile,
    rotateOnce,
    startLogRotation,
} from '../../src/logger/rotate.js';

const MB = 1024 * 1024;

async function tmpdir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'rotate-test-'));
}

async function writeMb(dir, name, mb) {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(Math.round(mb * MB), 0x61));
}

test('rotateConfig: defaults', () => {
    const c = rotateConfig({});
    assert.equal(c.dir, 'logs');
    assert.equal(c.maxMb, 100);
    assert.equal(c.keep, 3);
    assert.equal(c.intervalMs, 300000);
    assert.deepEqual(c.files, ['stdout.log', 'stderr.log']);
});

test('rotateConfig: env overrides, and 0 is honoured as "off" not "default"', () => {
    const c = rotateConfig({ LOG_DIR: '/var/log/x', LOG_ROTATE_MAX_MB: '0', LOG_ROTATE_KEEP: '7' });
    assert.equal(c.dir, '/var/log/x');
    assert.equal(c.maxMb, 0);
    assert.equal(c.keep, 7);
});

test('rotateConfig: garbage values fall back rather than producing NaN', () => {
    const c = rotateConfig({ LOG_ROTATE_MAX_MB: 'banana', LOG_ROTATE_KEEP: '-4' });
    assert.equal(c.maxMb, 100);
    assert.equal(c.keep, 3);
});

test('archiveName: stamp is filesystem-safe and sortable', () => {
    const name = archiveName('stdout.log', '2026-08-08T08:19:01.905Z');
    assert.equal(name, 'stdout.log.2026-08-08T08-19-01-905Z');
    assert.ok(!name.includes(':'));
});

test('rotateFile: leaves a file under the threshold alone', async () => {
    const dir = await tmpdir();
    await writeMb(dir, 'stdout.log', 0.5);
    const result = await rotateFile(dir, 'stdout.log', { maxMb: 1, keep: 3, stamp: 'S' });
    assert.equal(result.rotated, false);
    assert.deepEqual(await fs.readdir(dir), ['stdout.log']);
});

test('rotateFile: copytruncate keeps the content and empties the original', async () => {
    const dir = await tmpdir();
    await writeMb(dir, 'stdout.log', 2);
    const result = await rotateFile(dir, 'stdout.log', { maxMb: 1, keep: 3, stamp: 'S' });

    assert.equal(result.rotated, true);
    assert.equal(result.archive, 'stdout.log.S');
    // The original must still EXIST - the shell's append handle points at this
    // inode and a delete would send every later line into a void.
    const live = await fs.stat(path.join(dir, 'stdout.log'));
    assert.equal(live.size, 0);
    const archived = await fs.stat(path.join(dir, 'stdout.log.S'));
    assert.equal(archived.size, 2 * MB);
});

test('rotateFile: a missing log file is not an error', async () => {
    const dir = await tmpdir();
    const result = await rotateFile(dir, 'stdout.log', { maxMb: 1, keep: 3, stamp: 'S' });
    assert.equal(result.rotated, false);
    assert.equal(result.sizeBytes, 0);
    assert.equal(result.error, undefined);
});

test('rotateFile: maxMb 0 disables rotation even for a huge file', async () => {
    const dir = await tmpdir();
    await writeMb(dir, 'stdout.log', 2);
    const result = await rotateFile(dir, 'stdout.log', { maxMb: 0, keep: 3, stamp: 'S' });
    assert.equal(result.rotated, false);
});

test('pruneArchives: keeps the newest N and never touches the live file', async () => {
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, 'stdout.log'), 'live');
    for (const s of ['A', 'B', 'C', 'D', 'E']) {
        await fs.writeFile(path.join(dir, `stdout.log.${s}`), s);
    }
    const removed = await pruneArchives(dir, 'stdout.log', 2);
    assert.deepEqual(removed.sort(), ['stdout.log.A', 'stdout.log.B', 'stdout.log.C']);
    const left = (await fs.readdir(dir)).sort();
    assert.deepEqual(left, ['stdout.log', 'stdout.log.D', 'stdout.log.E']);
});

test('pruneArchives: does not prune a different file that shares a prefix', async () => {
    const dir = await tmpdir();
    await fs.writeFile(path.join(dir, 'stdout.log.A'), 'a');
    await fs.writeFile(path.join(dir, 'stderr.log.A'), 'a');
    await pruneArchives(dir, 'stdout.log', 0);
    assert.deepEqual(await fs.readdir(dir), ['stderr.log.A']);
});

test('rotateOnce: rotates every configured file in one pass', async () => {
    const dir = await tmpdir();
    await writeMb(dir, 'stdout.log', 2);
    await writeMb(dir, 'stderr.log', 2);
    const results = await rotateOnce(
        { dir, files: ['stdout.log', 'stderr.log'], maxMb: 1, keep: 3 },
        'S',
    );
    assert.deepEqual(
        results.map((r) => r.rotated),
        [true, true],
    );
    assert.equal((await fs.stat(path.join(dir, 'stdout.log'))).size, 0);
    assert.equal((await fs.stat(path.join(dir, 'stderr.log'))).size, 0);
});

test('startLogRotation: returns null when disabled, so "off" is distinguishable', () => {
    assert.equal(startLogRotation({ LOG_ROTATE_MAX_MB: '0' }), null);
    assert.equal(startLogRotation({ LOG_ROTATE_INTERVAL_MS: '0' }), null);
});

test('startLogRotation: runs an immediate pass and returns a stop function', async () => {
    const dir = await tmpdir();
    await writeMb(dir, 'stdout.log', 2);
    const stop = startLogRotation({
        LOG_DIR: dir,
        LOG_ROTATE_MAX_MB: '1',
        LOG_ROTATE_INTERVAL_MS: '600000',
    });
    assert.equal(typeof stop, 'function');
    // The first pass fires synchronously on start but resolves on a later tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fs.stat(path.join(dir, 'stdout.log'))).size, 0);
    stop();
});
