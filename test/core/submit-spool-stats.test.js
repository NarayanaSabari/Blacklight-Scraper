// spoolStats — the alert must distinguish "failing now" from "old backlog".
//
// On 2026-08-03 the panel warned "3554 submission(s) spooled locally - backend
// delivery is failing" for 34 hours while Indeed submissions were being
// accepted, because the alert only tested "directory is non-empty". The real
// problem — nothing ever drains the spool — stayed hidden behind an alarm
// everyone had learned to ignore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spoolStats } from '../../src/core/submit-spool.js';

function withSpool(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-stats-'));
    for (const [name, ageMs] of files) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, '{}');
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(p, when, when);
    }
    return dir;
}

test('empty or missing spool is healthy', async () => {
    const missing = path.join(os.tmpdir(), 'spool-stats-does-not-exist');
    process.env.SPOOL_DIR = missing;
    const s = await spoolStats();
    assert.equal(s.count, 0);
    assert.equal(s.deliveryFailingNow, false);
    assert.equal(s.backlog, false);
    delete process.env.SPOOL_DIR;
});

test('old files are BACKLOG, not a live delivery failure', async () => {
    // The exact 2026-08-03 shape: a large, stale pile while delivery works.
    const dir = withSpool([
        ['a.json', 34 * 60 * 60_000],
        ['b.json', 20 * 60 * 60_000],
        ['c.json', 90 * 60_000],
    ]);
    process.env.SPOOL_DIR = dir;
    const s = await spoolStats();
    assert.equal(s.count, 3);
    assert.equal(s.recent, 0);
    assert.equal(s.deliveryFailingNow, false, 'must NOT claim delivery is failing');
    assert.equal(s.backlog, true, 'but must still report undrained work');
    delete process.env.SPOOL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a file inside the active window IS a live delivery failure', async () => {
    const dir = withSpool([['fresh.json', 60_000]]);
    process.env.SPOOL_DIR = dir;
    const s = await spoolStats();
    assert.equal(s.recent, 1);
    assert.equal(s.deliveryFailingNow, true);
    assert.equal(s.backlog, false, 'nothing older than the window');
    delete process.env.SPOOL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
});

test('both conditions can hold at once and are reported independently', async () => {
    const dir = withSpool([
        ['old.json', 30 * 60 * 60_000],
        ['new.json', 30_000],
    ]);
    process.env.SPOOL_DIR = dir;
    const s = await spoolStats();
    assert.equal(s.count, 2);
    assert.equal(s.deliveryFailingNow, true);
    assert.equal(s.backlog, true);
    assert.ok(s.oldest < s.newest, 'oldest/newest bracket the range');
    delete process.env.SPOOL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
});

test('non-json files are ignored', async () => {
    const dir = withSpool([['a.json', 1000], ['notes.txt', 1000]]);
    process.env.SPOOL_DIR = dir;
    const s = await spoolStats();
    assert.equal(s.count, 1);
    delete process.env.SPOOL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
});
