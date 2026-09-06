import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlacklightApiClient } from '../../src/api/blacklight.js';

test('every platform submission is archived before the HTTP request without authentication headers', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'submission-history-'));
    const originalFetch = globalThis.fetch;
    const previous = process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR;
    process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR = directory;
    t.after(async () => {
        globalThis.fetch = originalFetch;
        if (previous === undefined) delete process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR;
        else process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR = previous;
        await rm(directory, { recursive: true, force: true });
    });
    const client = new BlacklightApiClient('https://archive-test.invalid', 'secret-api-key');
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
        calls++;
        const names = await readdir(directory);
        assert.equal(names.length, 1);
        const saved = await readFile(path.join(directory, names[0]), 'utf8');
        assert.deepEqual(JSON.parse(saved).requestBody, JSON.parse(options.body));
        assert.equal(saved.includes('secret-api-key'), false);
        return new Response(JSON.stringify({ receipt_id: 42 }), { status: 202 });
    };
    await client.submitJobs('s', 'indeed', [{ description: 'Complete post body' }]);
    assert.equal(calls, 1);
    const blocked = path.join(directory, 'not-a-directory');
    await writeFile(blocked, 'file');
    process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR = blocked;
    await assert.rejects(client.submitJobs('s2', 'linkedin', []));
    assert.equal(calls, 1, 'an archive failure must stop delivery before temporary-only backend acceptance');
});
