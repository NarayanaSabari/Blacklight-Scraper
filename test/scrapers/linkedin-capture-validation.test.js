import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureTemplate } from '../../src/scrapers/linkedin-rsc/capture-template.js';

// The browser is an external boundary. Real HTTP responses, extraction, capture
// decisions and disk replacement are exercised, including failure preservation.
for (const [label, status, fixture, accepted] of [
    ['confirmed empty', 200, 'linkedin-rsc-no-results.txt', false],
    ['rate limited', 429, 'linkedin-rsc-search.txt', false],
    ['unknown shape', 200, null, false],
    ['posts served', 200, 'linkedin-rsc-search.txt', true],
    ['overlapping responses', 200, 'linkedin-rsc-search.txt', true],
]) {
    test(`template capture ${label}: only proven results replace the saved template`, async () => {
        const body = fixture ? await readFile(new URL(`../fixtures/${fixture}`, import.meta.url), 'utf8') : '<html>Unexpected page</html>';
        const server = http.createServer((req, res) => { res.writeHead(status); res.end(body); });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'capture-proof-'));
        const outPath = path.join(directory, 'template.json');
        const prior = '{"old":"working template"}';
        await writeFile(outPath, prior);
        const context = new EventEmitter();
        let closed = false;
        let finishSlowBody;
        const url = `http://127.0.0.1:${server.address().port}/rsc-action/actions/pagination?sduiid=contentSearchResults`;
        const request = { url: () => url, headers: () => ({ cookie: 'secret-cookie', 'csrf-token': 'secret-csrf', 'x-li-application-version': '0.2.7139' }),
            postData: () => JSON.stringify({ clientArguments: { payload: { keywords: 'hiring' } } }) };
        context.cookies = async () => [{ name: 'li_at', value: 'secret-cookie' }];
        context.newPage = async () => ({
            goto: async () => {
                context.emit('request', request);
                if (label === 'overlapping responses') {
                    context.emit('response', { request: () => request, status: () => 200,
                        text: () => new Promise((resolve) => { finishSlowBody = () => resolve('<html>Unknown</html>'); }) });
                }
                const response = await fetch(url);
                context.emit('response', { request: () => request, url: () => url,
                    status: () => response.status, text: () => response.text() });
            },
            evaluate: async () => { finishSlowBody?.(); },
        });
        context.close = async () => { finishSlowBody?.(); closed = true; };
        try {
            const captured = await captureTemplate({ outPath, query: 'hiring', launch: async () => context });
            const stored = await readFile(outPath, 'utf8');
            if (accepted) {
                assert.ok(captured, 'a successful response must be retained even when another response is slow');
                assert.equal(captured.url, url);
                assert.equal(JSON.parse(stored).url, url);
                assert.equal(stored.includes('secret-cookie'), false);
                assert.equal(stored.includes('secret-csrf'), false);
                assert.ok(captured.validation.posts > 0);
                assert.equal(captured.validation.status, 200);
            } else {
                assert.equal(captured, null, 'a request alone does not prove the template works');
                assert.equal(stored, prior, 'failed capture preserves the existing template byte for byte');
            }
            assert.equal(closed, true);
        } finally {
            server.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
