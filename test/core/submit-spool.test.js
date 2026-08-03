import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spoolSnapshot } from '../../src/core/submit-spool.js';

let dir;

test.beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'blacklight-spool-'));
    process.env.SPOOL_DIR = dir;
});

test.afterEach(async () => {
    delete process.env.SPOOL_DIR;
    await rm(dir, { recursive: true, force: true });
});

test('spoolSnapshot: no spool directory yet → count 0, oldest null', async () => {
    process.env.SPOOL_DIR = path.join(dir, 'does-not-exist');
    assert.deepEqual(await spoolSnapshot(), { count: 0, oldest: null });
});

test('spoolSnapshot: empty spool directory → count 0, oldest null', async () => {
    assert.deepEqual(await spoolSnapshot(), { count: 0, oldest: null });
});

test('spoolSnapshot: counts .json files and reports the oldest mtime', async () => {
    await writeFile(path.join(dir, 'a.json'), '{}');
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(path.join(dir, 'b.json'), '{}');
    await writeFile(path.join(dir, 'ignore.txt'), 'not json');

    const snap = await spoolSnapshot();
    assert.equal(snap.count, 2);
    assert.equal(typeof snap.oldest, 'string');
    // a.json was written first, so its mtime is the oldest.
    const aStat = await import('node:fs/promises').then((fs) => fs.stat(path.join(dir, 'a.json')));
    assert.equal(snap.oldest, new Date(aStat.mtimeMs).toISOString());
});
