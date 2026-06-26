import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../../src/setup/wizard.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'setupw-banner-')); }
function scripted(answers) { let i = 0; return async () => answers[i++]; }
const okFetch = async () => ({
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ ok: true }),
});
// URL is defaulted now; prompts in order: API key, SCRAPER_MODE, headless,
// strictEmpty, PORT — no URL prompts, no "run mode" prompt (always prod).
const REMOTE = ['KEYB', 'daemon', 'no', 'no', '3001'];

test('success path prints the linkedin:login banner', async () => {
    const cwd = tmp(); const out = [];
    const code = await runSetupWizard({
        cwd,
        defaultApiUrl: 'https://d',
        ask: scripted([...REMOTE]),
        fetchFn: okFetch,
        isIgnored: () => true,
        out: (s) => out.push(String(s)),
    });
    assert.equal(code, 0);
    const joined = out.join('\n');
    assert.match(joined, /IMPORTANT.*next step/i);
    assert.match(joined, /npm run linkedin:login/);
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
