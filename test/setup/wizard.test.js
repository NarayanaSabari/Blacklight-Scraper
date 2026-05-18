import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../../src/setup/wizard.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setupw-')); }
function scriptedAsk(answers) { let i = 0; return async () => answers[i++]; }
const LI = JSON.stringify([{ name: 'li_at', value: 'x', domain: '.www.linkedin.com' }]);

test('LOCAL: writes credentials.json + .env, returns 0, no raw secret in output', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        ask: scriptedAsk(['1', LI, 'done', 'yes', 'no', 'interactive', '3001']),
        launchFn: async () => ({ newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }) }), close: async () => {} }),
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    const cred = JSON.parse(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'));
    assert.ok(Array.isArray(cred.linkedin.credentials) && cred.linkedin.credentials[0].name === 'li_at');
    const env = fs.readFileSync(path.join(cwd, '.env'), 'utf-8');
    assert.match(env, /^NODE_ENV=development$/m);
    assert.ok(!out.join('\n').includes('li_at') || !out.join('\n').includes('"value":"x"'),
        'wizard output must not echo raw cookie values');
});

test('cancel on existing-file prompt writes nothing and returns 1', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{"blacklight":{"apiKey":"SECRET99"}}');
    const code = await runSetupWizard({ cwd, ask: scriptedAsk(['cancel']), isIgnored: () => true, out: () => {} });
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(path.join(cwd, 'config', 'credentials.json'), 'utf-8'),
        '{"blacklight":{"apiKey":"SECRET99"}}');
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
