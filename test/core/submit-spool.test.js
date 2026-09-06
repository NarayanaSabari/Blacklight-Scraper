import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spoolStats, spoolUndeliverableSubmission } from '../../src/core/submit-spool.js';

// spoolSnapshot() was folded into spoolStats(), which returns a superset.
// These cases still pin the count/oldest contract the control panel reads;
// the failing-now vs backlog split is covered in submit-spool-stats.test.js.
let dir;

// spoolStats returns more fields; these tests assert the panel-facing subset.
const pick = ({ count, oldest }) => ({ count, oldest });

test.beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'blacklight-spool-'));
    process.env.SPOOL_DIR = dir;
});

test.afterEach(async () => {
    delete process.env.SPOOL_DIR;
    await rm(dir, { recursive: true, force: true });
});

test('spoolStats: no spool directory yet → count 0, oldest null', async () => {
    process.env.SPOOL_DIR = path.join(dir, 'does-not-exist');
    assert.deepEqual(pick(await spoolStats()), { count: 0, oldest: null });
});

test('spoolStats: empty spool directory → count 0, oldest null', async () => {
    assert.deepEqual(pick(await spoolStats()), { count: 0, oldest: null });
});

test('spoolStats: counts .json files and reports the oldest mtime', async () => {
    await writeFile(path.join(dir, 'a.json'), '{}');
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(path.join(dir, 'b.json'), '{}');
    await writeFile(path.join(dir, 'ignore.txt'), 'not json');

    const snap = await spoolStats();
    assert.equal(snap.count, 2);
    assert.equal(typeof snap.oldest, 'string');
    // a.json was written first, so its mtime is the oldest.
    const aStat = await import('node:fs/promises').then((fs) => fs.stat(path.join(dir, 'a.json')));
    assert.equal(snap.oldest, new Date(aStat.mtimeMs).toISOString());
});

test('spool retains the exact API body for idempotent replay', async () => {
    const requestBody = { session_id: 'session', platform: 'linkedin', jobs: [],
        empty_confirmed: false, search_outcome: 'deferred', next_refresh_at: '2026-09-06T12:00:00Z' };
    const file = await spoolUndeliverableSubmission({ sessionId: 'session', platform: 'linkedin',
        jobs: [], status: 'success', deliveryError: 'response lost', requestBody });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).requestBody, requestBody);
});
