import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalLogSink } from '../../src/logger/local-log.js';
import { attachLocalSink, createLogger } from '../../src/logger/index.js';

function fixture(t) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'scraper-logs-'));
    t.after(() => { attachLocalSink(null); rmSync(directory, { recursive: true, force: true }); });
    return directory;
}

test('local logger persists masked lines and keeps earlier days across rollover and restart', (t) => {
    const directory = fixture(t);
    let now = new Date('2026-09-06T12:00:00Z');
    const sink = new LocalLogSink({ directory, now: () => now });
    attachLocalSink(sink);
    const logger = createLogger('archive-test');
    logger.info('Scrape finished', { sessionId: 's1', password: 'secret-password', cookies: ['secret-cookie'] });
    now = new Date('2026-09-07T00:00:00Z');
    logger.warn('Next day', { sessionId: 's2' });
    sink.close();
    const restarted = new LocalLogSink({ directory, now: () => now });
    restarted.enqueue('info', 'archive-test', 'after restart');
    restarted.close();
    assert.deepEqual(readdirSync(directory), ['2026-09-06.jsonl', '2026-09-07.jsonl']);
    const first = readFileSync(path.join(directory, '2026-09-06.jsonl'), 'utf8');
    assert.equal(first.includes('secret-password'), false);
    assert.equal(first.includes('secret-cookie'), false);
    assert.equal(JSON.parse(first).scope, 'archive-test');
    assert.match(JSON.parse(first).line, /s1/);
    const second = readFileSync(path.join(directory, '2026-09-07.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(second.length, 2);
    assert.equal(second[1].line, 'after restart');
    if (process.platform !== 'win32') assert.equal(statSync(path.join(directory, '2026-09-06.jsonl')).mode & 0o777, 0o600);
});

test('unwritable log destination reports failure without crashing scraping or retrying each line', (t) => {
    const directory = fixture(t);
    const destination = path.join(directory, 'file');
    writeFileSync(destination, 'not a directory');
    const failures = [];
    let now = new Date('2026-09-06T12:00:00Z');
    const sink = new LocalLogSink({ directory: destination, now: () => now, onError: (error) => failures.push(error) });
    attachLocalSink(sink);
    const logger = createLogger('archive-test');
    assert.doesNotThrow(() => { logger.info('one'); logger.info('two'); });
    assert.equal(failures.length, 1);
    now = new Date(now.getTime() + 60_000);
    logger.info('retry after cooldown');
    assert.equal(failures.length, 2);
    assert.doesNotThrow(() => sink.close());
});

test('real startup retains its boot record and fatal startup failure', { timeout: 10_000 }, async (t) => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const directory = fixture(t);
    const logs = path.join(directory, 'logs');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../server.js', import.meta.url))], {
        cwd: directory,
        env: { PATH: process.env.PATH, PORT: '-1', SCRAPER_LOG_DIR: logs },
        stdio: 'ignore',
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 42);
    const records = readdirSync(logs).flatMap((file) => readFileSync(path.join(logs, file), 'utf8').trim().split('\n').map(JSON.parse));
    assert.ok(records.some(({ line }) => /\[SERVER\] boot/.test(line)));
    assert.ok(records.some(({ line }) => /Fatal startup error/.test(line)));
});
