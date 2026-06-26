import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../../src/setup/wizard.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setupw-')); }
function scriptedAsk(answers) { let i = 0; return async () => answers[i++]; }
const okFetch = async () => ({
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: true }),
});
// The remote/prod flow no longer prompts for URLs — the API URL is a default
// (injected here as deps.defaultApiUrl, overridable in prod via BLACKLIGHT_API_URL).
// It asks, in order: API key, SCRAPER_MODE, headless, strictEmpty, PORT.
const REMOTE = ['mykey', 'daemon', 'yes', 'no', '3001'];

test('defaults the apiUrl, asks ONLY for the key, applies it to both sections', async () => {
    const cwd = tmp();
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://default-api',
        ask: scriptedAsk([...REMOTE]),
        fetchFn: okFetch,
        isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.equal(cred.blacklight.apiUrl, 'https://default-api');
    assert.equal(cred.scraperCredentials.apiUrl, 'https://default-api');
    assert.equal(cred.blacklight.apiKey, 'mykey');
    assert.equal(cred.scraperCredentials.apiKey, 'mykey', 'the one key is applied to both sections');
    assert.ok(cred.linkedin === undefined);
    assert.match(fs.readFileSync(path.join(cwd, '.env'), 'utf-8'), /^NODE_ENV=production$/m);
});

test('BLACKLIGHT_API_URL env overrides the default when not injected', async () => {
    const cwd = tmp();
    const prev = process.env.BLACKLIGHT_API_URL;
    process.env.BLACKLIGHT_API_URL = 'https://env-api';
    try {
        const code = await runSetupWizard({
            cwd, ask: scriptedAsk([...REMOTE]), fetchFn: okFetch, isIgnored: () => true, out: () => {},
        });
        assert.equal(code, 0);
        const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
        assert.equal(cred.blacklight.apiUrl, 'https://env-api');
    } finally {
        if (prev === undefined) delete process.env.BLACKLIGHT_API_URL;
        else process.env.BLACKLIGHT_API_URL = prev;
    }
});

test('credentials.json is written 0600 (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const cwd = tmp();
    await runSetupWizard({ cwd, defaultApiUrl: 'https://d', ask: scriptedAsk([...REMOTE]), fetchFn: okFetch, isIgnored: () => true, out: () => {} });
    const mode = fs.statSync(path.join(cwd, 'config', 'credentials.json')).mode & 0o777;
    assert.equal(mode, 0o600);
});

test('cancel on existing-file prompt writes nothing and returns 1', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{"blacklight":{"apiKey":"SECRET99"}}');
    const out = [];
    const code = await runSetupWizard({ cwd, ask: scriptedAsk(['cancel']), isIgnored: () => true, out: (s) => out.push(String(s)) });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'), '{"blacklight":{"apiKey":"SECRET99"}}');
    assert.ok(!out.join('\n').includes('SECRET99'), 'existing secret must not be echoed by the preview');
});

test('NEVER echoes the apiKey secret', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://d',
        ask: scriptedAsk(['SEKRIT-API-KEY-7Z', 'daemon', 'no', 'no', '3001']),
        fetchFn: okFetch,
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    assert.ok(!out.join('\n').includes('SEKRIT-API-KEY-7Z'), 'apiKey value must never be echoed');
});

test('overwrite replaces an existing config (no merge)', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{"linkedin":{"credentials":[{"name":"old"}]}}');
    fs.writeFileSync(path.join(cwd, '.env'), 'OLD=1\n');
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://b',
        ask: scriptedAsk(['overwrite', ...REMOTE]),
        fetchFn: okFetch,
        isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.ok(cred.linkedin === undefined && cred.blacklight.apiUrl === 'https://b');
    const env = fs.readFileSync(path.join(cwd, '.env'), 'utf-8');
    assert.match(env, /^NODE_ENV=production$/m);
    assert.doesNotMatch(env, /^OLD=1$/m);
});

test('merge preserves an unrelated existing credential section', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{"glassdoor":{"credentials":[{"name":"gid"}]}}');
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://b',
        ask: scriptedAsk(['merge', ...REMOTE]),
        fetchFn: okFetch, isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.ok(cred.glassdoor && cred.glassdoor.credentials[0].name === 'gid', 'unrelated section preserved');
    assert.ok(cred.blacklight && cred.blacklight.apiUrl === 'https://b', 'new section merged in');
});

test('merge ABORTS (writes nothing) when the existing credentials file is unparseable', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    const broken = '{ this is not valid json';
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), broken);
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://b',
        ask: scriptedAsk(['merge', ...REMOTE]),
        fetchFn: okFetch, isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'), broken, 'must not destroy the operator file');
    assert.ok(!fs.existsSync(path.join(cwd, '.env')), 'must not write .env on abort');
});

test('git-ignore guard: refuses to write when the target is NOT ignored', async () => {
    const cwd = tmp();
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://b',
        ask: scriptedAsk([...REMOTE]),
        fetchFn: okFetch,
        isIgnored: () => false, out: () => {},
    });
    assert.equal(code, 1);
    assert.ok(!fs.existsSync(path.join(cwd, 'config', 'credentials.json')), 'no credentials.json written');
    assert.ok(!fs.existsSync(path.join(cwd, '.env')), 'no .env written');
});

test('git-ignore guard: unknown status (null) warns + requires confirm; declining writes nothing', async () => {
    const cwd = tmp();
    const out = [];
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://b',
        ask: scriptedAsk([...REMOTE, 'n']),
        fetchFn: okFetch,
        isIgnored: () => null, out: (s) => out.push(String(s)),
    });
    assert.equal(code, 1);
    assert.ok(out.join('\n').includes('Could not confirm'), 'warns on unknown ignore status');
    assert.ok(!fs.existsSync(path.join(cwd, 'config', 'credentials.json')));
});

test('EOF / closed stdin (ask returns null) cancels cleanly: exit 1, nothing written', async () => {
    const cwd = tmp();
    const code = await runSetupWizard({ cwd, ask: async () => null, isIgnored: () => true, out: () => {} });
    assert.equal(code, 1);
    assert.ok(!fs.existsSync(path.join(cwd, 'config', 'credentials.json')));
    assert.ok(!fs.existsSync(path.join(cwd, '.env')));
});
