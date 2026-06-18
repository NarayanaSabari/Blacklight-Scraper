import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../../src/setup/wizard.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setupw-banner-')); }
function scripted(answers) { let i = 0; return async () => answers[i++]; }
const okBrowser = async () => ({
    newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => 'https://www.linkedin.com/feed/' }) }),
    close: async () => {},
});
const LI = JSON.stringify([{ name: 'li_at', value: 'V', domain: '.www.linkedin.com' }]);

test('LOCAL success path prints the linkedin:login banner', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        ask: scripted(['1', LI, 'done', 'no', 'no', 'interactive', '3001']),
        launchFn: okBrowser,
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    const joined = out.join('\n');
    assert.match(joined, /IMPORTANT.*next step/i);
    assert.match(joined, /npm run linkedin:login/);
});

test('REMOTE success path also prints the linkedin:login banner', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        ask: scripted(['2', 'https://blacklight.example.com', 'KEYB', 'https://creds.example.com', 'KEYC', 'daemon', 'no', 'no', '3001']),
        fetchFn: async () => ({
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ ok: true }),
        }),
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    assert.match(out.join('\n'), /npm run linkedin:login/);
});

test('Cancel path does NOT print the linkedin:login banner', async () => {
    const cwd = tmp(); const out = [];
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(path.join(cwd, 'config', 'credentials.json'), '{}');
    const code = await runSetupWizard({
        cwd,
        ask: scripted(['cancel']),
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 1);
    assert.doesNotMatch(out.join('\n'), /npm run linkedin:login/);
});
