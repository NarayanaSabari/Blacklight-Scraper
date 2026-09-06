import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlacklightApiClient } from '../../src/api/blacklight.js';
import { ScrapeArchive } from '../../src/scrapers/linkedin-rsc/archive.js';
import { QueryState } from '../../src/scrapers/linkedin-rsc/query-state.js';
import { scrapeLinkedInRsc } from '../../src/scrapers/linkedin-rsc/scraper.js';

test('archived LinkedIn work survives a lost acceptance response and replays the same API body', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-delivery-'));
    const previousArchive = process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR;
    process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR = path.join(directory, 'submissions');
    const previousSpool = process.env.SPOOL_DIR;
    process.env.SPOOL_DIR = path.join(directory, 'spool');
    t.after(async () => {
        if (previousArchive === undefined) delete process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR;
        else process.env.SCRAPER_SUBMISSION_ARCHIVE_DIR = previousArchive;
        if (previousSpool === undefined) delete process.env.SPOOL_DIR;
        else process.env.SPOOL_DIR = previousSpool;
        await rm(directory, { recursive: true, force: true });
    });
    const bodies = [];
    const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        bodies.push(JSON.parse(body));
        response.writeHead(202, { 'content-type': 'application/json' });
        // The server accepted the first body, but its response was truncated.
        response.end(bodies.length === 1 ? '{' : JSON.stringify({ receipt_id: 17 }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const post = { activity_id: '7487914656553025536',
        text: 'Hiring a Data Engineer in Chicago. C2C contract. Python and SQL required.',
        post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7487914656553025536' };
    const archive = new ScrapeArchive({ directory: path.join(directory, 'archive') });
    const result = await scrapeLinkedInRsc('Data Engineer', 'US', 'session', {
        session: { withCookies: async (_, fn) => fn([], { credential: { id: 1 } }) },
        template: {}, highWater: null, canaryTracker: null, archive,
        scheduledRefresh: true, queryState: new QueryState({ filePath: null }),
        paginateImpl: async () => ({ posts: [post], rawPosts: [post], pages: [{ page: 1 }], exhausted: true }),
    });
    const client = new BlacklightApiClient(`http://127.0.0.1:${server.address().port}`, 'test-key');
    await assert.rejects(client.submitJobs('session', 'linkedin', result.jobs, 'success', null, result));
    const names = await readdir(process.env.SPOOL_DIR);
    const spool = JSON.parse(await readFile(path.join(process.env.SPOOL_DIR, names[0]), 'utf8'));
    assert.deepEqual(spool.requestBody, bodies[0]);
    assert.equal(JSON.stringify(spool).includes('test-key'), false);
    const archives = await readdir(archive.directory);
    const retained = JSON.parse(await readFile(path.join(archive.directory, archives[0]), 'utf8'));
    assert.equal(retained.posts[0].text, post.text);
    const body = spool.requestBody;
    const accepted = await client.submitJobs(body.session_id, body.platform, body.jobs,
        body.status ?? 'success', body.error_message ?? null, {
            emptyConfirmed: body.empty_confirmed, searchOutcome: body.search_outcome,
            nextRefreshAt: body.next_refresh_at,
        });
    assert.equal(accepted.receipt_id, 17);
    assert.deepEqual(bodies[1], bodies[0]);
});
