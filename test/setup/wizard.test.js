import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../../src/setup/wizard.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setupw-')); }
function scriptedAsk(answers) { let i = 0; return async () => answers[i++]; }
const okBrowser = async () => ({
    newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }) }),
    close: async () => {},
});
// Distinctive so the "never echo a cookie value" assertion has teeth.
const LI = JSON.stringify([{ name: 'li_at', value: 'SEKRIT-LI-AT-7Z', domain: '.www.linkedin.com' }]);

test('LOCAL: writes credentials.json + .env, returns 0, NEVER echoes the cookie value', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['1', LI, 'done', 'yes', 'no', 'interactive', '3001']),
        launchFn: okBrowser,
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.ok(Array.isArray(cred.linkedin.credentials) && cred.linkedin.credentials[0].name === 'li_at');
    assert.match(fs.readFileSync(path.join(cwd, '.env'), 'utf-8'), /^NODE_ENV=development$/m);
    // Strong AND-style guarantee: the actual secret cookie value must never appear in any output line.
    assert.ok(!out.join('\n').includes('SEKRIT-LI-AT-7Z'), 'cookie value must never be echoed');
});

test('credentials.json is written 0600 (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const cwd = tmp();
    await runSetupWizard({ cwd, ask: scriptedAsk(['1', LI, 'done', 'no', 'no', 'interactive', '3001']), launchFn: okBrowser, isIgnored: () => true, out: () => {} });
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

test('REMOTE: writes blacklight+scraperCredentials, NODE_ENV=production, returns 0', async () => {
    const cwd = tmp();
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['2', 'https://b', 'bkey', 'https://c', 'ckey', 'daemon', 'yes', 'no', '3001']),
        fetchFn: async () => ({ status: 200 }),
        isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.equal(cred.blacklight.apiUrl, 'https://b');
    assert.equal(cred.scraperCredentials.apiKey, 'ckey');
    assert.ok(cred.linkedin === undefined);
    assert.match(fs.readFileSync(path.join(cwd, '.env'), 'utf-8'), /^NODE_ENV=production$/m);
});

test('REMOTE: re-prompts on a non-http(s) apiUrl until valid', async () => {
    const cwd = tmp();
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['2', 'ftp://nope', 'https://good', 'bkey', 'https://c', 'ckey', 'daemon', 'yes', 'no', '3001']),
        fetchFn: async () => ({ status: 200 }),
        isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.equal(cred.blacklight.apiUrl, 'https://good');
});

test('overwrite replaces an existing config (no merge)', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{"linkedin":{"credentials":[{"name":"old"}]}}');
    fs.writeFileSync(path.join(cwd, '.env'), 'OLD=1\n');
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['overwrite', '2', 'https://b', 'bkey', 'https://c', 'ckey', 'daemon', 'yes', 'no', '3001']),
        fetchFn: async () => ({ status: 200 }),
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
        ask: scriptedAsk(['merge', '1', LI, 'done', 'no', 'no', 'interactive', '3001']),
        launchFn: okBrowser, isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.ok(cred.glassdoor && cred.glassdoor.credentials[0].name === 'gid', 'unrelated section preserved');
    assert.ok(cred.linkedin && cred.linkedin.credentials[0].name === 'li_at', 'new section merged in');
});

test('merge ABORTS (writes nothing) when the existing credentials file is unparseable', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    const broken = '{ this is not valid json';
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), broken);
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['merge', '1', LI, 'done', 'no', 'no', 'interactive', '3001']),
        launchFn: okBrowser, isIgnored: () => true, out: () => {},
    });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'), broken, 'must not destroy the operator file');
    assert.ok(!fs.existsSync(path.join(cwd, '.env')), 'must not write .env on abort');
});

test('git-ignore guard: refuses to write when the target is NOT ignored', async () => {
    const cwd = tmp();
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['2', 'https://b', 'bkey', 'https://c', 'ckey', 'daemon', 'yes', 'no', '3001']),
        fetchFn: async () => ({ status: 200 }),
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
        ask: scriptedAsk(['2', 'https://b', 'bkey', 'https://c', 'ckey', 'daemon', 'yes', 'no', '3001', 'n']),
        fetchFn: async () => ({ status: 200 }),
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
