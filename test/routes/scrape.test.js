// SCR-28: POST /scrape used to always write a per-platform JSON file to
// results/, with no retention — an unbounded directory on a long-lived
// operator host. The write is now gated behind saveResultsToDisk() (backed
// by SCRAPE_SAVE_RESULTS, see src/config/env.js), off by default.
//
// These tests exercise registerScrapeRoute directly (mirrors the DI pattern
// in test/routes/healthz.test.js), injecting a fake scraper + an in-memory
// fs so no real platform code or disk I/O runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerScrapeRoute } from '../../src/routes/scrape.js';

function fakeFs() {
    const files = new Map();
    return {
        files,
        mkdirSync() { /* no-op — no real directory needed */ },
        writeFileSync(filepath, contents) { files.set(filepath, contents); },
    };
}

function fakeScraper(jobs) {
    return { execute: async () => jobs };
}

function inject(deps) {
    const app = express();
    registerScrapeRoute(app, deps);
    return app;
}

// Synthetic req/res pair, same shape as test/routes/healthz.test.js. No real
// socket is opened (the sandbox in this environment blocks `listen`), and no
// body-parser middleware is needed — req.body is set directly, exactly as
// express.json() would have left it.
function post(app, urlPath, body) {
    return new Promise((resolve) => {
        const req = { method: 'POST', url: urlPath, query: {}, headers: {}, body };
        const url = new URL(urlPath, 'http://localhost');
        req.path = url.pathname;
        const chunks = [];
        const res = {
            statusCode: 200,
            _headers: {},
            setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(o) { chunks.push(JSON.stringify(o)); resolve({ status: this.statusCode, body: JSON.parse(chunks[0]) }); return this; },
            end() { resolve({ status: this.statusCode, body: null }); },
        };
        app.handle(req, res, () => resolve({ status: 404, body: null }));
    });
}

test('POST /scrape: SCRAPE_SAVE_RESULTS off — no file written, response carries full results', async () => {
    const fs = fakeFs();
    const app = inject({
        getScraper: () => fakeScraper([{ title: 'Engineer' }]),
        saveResultsToDisk: () => false,
        fs,
        resultsDir: '/fake/results',
    });

    const { status, body } = await post(app, '/scrape', {
        platform: 'dice',
        jobTitle: 'Engineer',
        location: 'Remote',
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.summary.savedFiles.length, 0);
    assert.equal(body.results.platforms.dice.success, true);
    assert.equal(body.results.platforms.dice.count, 1);
    assert.deepEqual(body.results.platforms.dice.jobs, [{ title: 'Engineer' }]);
    assert.equal(fs.files.size, 0, 'no file should be written when the flag is off');
});

test('POST /scrape: SCRAPE_SAVE_RESULTS on — file written per platform, same response as off', async () => {
    const fs = fakeFs();
    const app = inject({
        getScraper: () => fakeScraper([{ title: 'Engineer' }]),
        saveResultsToDisk: () => true,
        fs,
        resultsDir: '/fake/results',
    });

    const { status, body } = await post(app, '/scrape', {
        platform: 'dice',
        jobTitle: 'Engineer',
        location: 'Remote',
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.summary.savedFiles.length, 1);
    assert.equal(body.results.platforms.dice.success, true);
    assert.equal(body.results.platforms.dice.count, 1);
    assert.deepEqual(body.results.platforms.dice.jobs, [{ title: 'Engineer' }]);
    assert.equal(fs.files.size, 1, 'exactly one file should be written when the flag is on');

    const [filepath, contents] = [...fs.files.entries()][0];
    assert.match(filepath, /^\/fake\/results\/dice_/);
    const saved = JSON.parse(contents);
    assert.equal(saved.platform, 'dice');
    assert.equal(saved.jobTitle, 'Engineer');
    assert.equal(saved.location, 'Remote');
    assert.deepEqual(saved.jobs, [{ title: 'Engineer' }]);
});

test('POST /scrape: a per-platform save failure does not fail the response', async () => {
    const app = inject({
        getScraper: () => fakeScraper([{ title: 'Engineer' }]),
        saveResultsToDisk: () => true,
        fs: {
            mkdirSync() { /* no-op */ },
            writeFileSync() { throw new Error('disk full'); },
        },
        resultsDir: '/fake/results',
    });

    const { status, body } = await post(app, '/scrape', {
        platform: 'dice',
        jobTitle: 'Engineer',
        location: 'Remote',
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.summary.savedFiles.length, 0);
    assert.equal(body.results.platforms.dice.success, true);
});
