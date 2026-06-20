import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureApiKey } from '../../src/setup/ensure-api-key.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ensurekey-')); }
function scriptedAsk(answers) { let i = 0; return async () => answers[i++]; }
const credPathFor = (cwd) => path.join(cwd, 'config', 'credentials.json');
// Distinctive so the "never echo the key" assertion has teeth.
const SECRET = 'SK-LIVE-NEVER-ECHO-7Z';

test('already configured: does NOT prompt and writes nothing', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    const existing = '{"blacklight":{"apiUrl":"https://api.qpeakhire.com","apiKey":"REAL-KEY-123"}}';
    fs.writeFileSync(credPathFor(cwd), existing);
    let asked = false;
    const res = await ensureApiKey({
        cwd, isTTY: true, isIgnored: () => true, out: () => {},
        ask: async () => { asked = true; return 'X'; },
    });
    assert.equal(asked, false, 'must not prompt when already configured');
    assert.equal(res.configured, true);
    assert.equal(res.wrote, false);
    assert.equal(fs.readFileSync(credPathFor(cwd), 'utf-8'), existing, 'file untouched');
});

test('missing key + TTY: prompts, writes credentials.json with the key + fixed prod URL', async () => {
    const cwd = tmp();
    const out = [];
    const res = await ensureApiKey({
        cwd, isTTY: true, isIgnored: () => true,
        ask: scriptedAsk([SECRET]), out: (s) => out.push(String(s)),
    });
    assert.equal(res.wrote, true);
    assert.equal(res.configured, true);
    const cred = JSON.parse(fs.readFileSync(credPathFor(cwd), 'utf-8'));
    assert.equal(cred.blacklight.apiKey, SECRET);
    assert.equal(cred.blacklight.apiUrl, 'https://api.qpeakhire.com');
    assert.ok(!out.join('\n').includes(SECRET), 'the API key must never be echoed to output');
});

test('creates config/ directory when it does not exist', async () => {
    const cwd = tmp(); // no config/ dir yet
    await ensureApiKey({ cwd, isTTY: true, isIgnored: () => true, ask: scriptedAsk(['K']), out: () => {} });
    assert.ok(fs.existsSync(credPathFor(cwd)), 'credentials.json created from scratch');
});

test('placeholder key (REPLACE_ME...) is treated as NOT configured', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(credPathFor(cwd), '{"blacklight":{"apiUrl":"https://x","apiKey":"REPLACE_ME_BLACKLIGHT_SCRAPER_KEY"}}');
    const res = await ensureApiKey({ cwd, isTTY: true, isIgnored: () => true, ask: scriptedAsk(['REALKEY']), out: () => {} });
    assert.equal(res.wrote, true);
    const cred = JSON.parse(fs.readFileSync(credPathFor(cwd), 'utf-8'));
    assert.equal(cred.blacklight.apiKey, 'REALKEY');
});

test('non-TTY (daemon/CI): never prompts, never writes — boot must not hang', async () => {
    const cwd = tmp();
    let asked = false;
    const res = await ensureApiKey({
        cwd, isTTY: false, isIgnored: () => true, out: () => {},
        ask: async () => { asked = true; return 'X'; },
    });
    assert.equal(asked, false, 'must never block on a prompt without a TTY');
    assert.equal(res.configured, false);
    assert.equal(res.wrote, false);
    assert.ok(!fs.existsSync(credPathFor(cwd)), 'nothing written');
});

test('merge preserves an unrelated existing section (linkedin cookies)', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(credPathFor(cwd), '{"linkedin":{"credentials":[{"name":"li_at"}]}}');
    await ensureApiKey({ cwd, isTTY: true, isIgnored: () => true, ask: scriptedAsk(['NEWKEY']), out: () => {} });
    const cred = JSON.parse(fs.readFileSync(credPathFor(cwd), 'utf-8'));
    assert.equal(cred.linkedin.credentials[0].name, 'li_at', 'unrelated section preserved');
    assert.equal(cred.blacklight.apiKey, 'NEWKEY', 'new section merged in');
});

test('git-ignore guard: refuses to write when the target is NOT ignored (real commit risk)', async () => {
    const cwd = tmp();
    const res = await ensureApiKey({ cwd, isTTY: true, isIgnored: () => false, ask: scriptedAsk(['KEY']), out: () => {} });
    assert.equal(res.wrote, false);
    assert.ok(!fs.existsSync(credPathFor(cwd)), 'no secret written to a non-ignored path');
});

test('unknown git-ignore status (null, e.g. standalone non-repo host): warns but DOES write', async () => {
    const cwd = tmp();
    const out = [];
    const res = await ensureApiKey({ cwd, isTTY: true, isIgnored: () => null, ask: scriptedAsk(['KEY']), out: (s) => out.push(String(s)) });
    assert.equal(res.wrote, true, 'standalone deploy (no git) should still be able to save the key');
    assert.ok(out.join('\n').toLowerCase().includes('could not confirm'), 'warns about unknown ignore status');
});

test('credentials.json is written 0600 (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const cwd = tmp();
    await ensureApiKey({ cwd, isTTY: true, isIgnored: () => true, ask: scriptedAsk(['KEY']), out: () => {} });
    const mode = fs.statSync(credPathFor(cwd)).mode & 0o777;
    assert.equal(mode, 0o600);
});

test('EOF / closed stdin (ask returns null): writes nothing, configured=false', async () => {
    const cwd = tmp();
    const res = await ensureApiKey({ cwd, isTTY: true, isIgnored: () => true, ask: async () => null, out: () => {} });
    assert.equal(res.wrote, false);
    assert.equal(res.configured, false);
    assert.ok(!fs.existsSync(credPathFor(cwd)));
});

test('empty/whitespace key re-prompts until a real key is entered', async () => {
    const cwd = tmp();
    const res = await ensureApiKey({ cwd, isTTY: true, isIgnored: () => true, ask: scriptedAsk(['', '   ', 'FINALKEY']), out: () => {} });
    assert.equal(res.wrote, true);
    const cred = JSON.parse(fs.readFileSync(credPathFor(cwd), 'utf-8'));
    assert.equal(cred.blacklight.apiKey, 'FINALKEY');
});

test('unparseable existing credentials.json is NOT destroyed', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    const broken = '{ not valid json';
    fs.writeFileSync(credPathFor(cwd), broken);
    const res = await ensureApiKey({ cwd, isTTY: true, isIgnored: () => true, ask: scriptedAsk(['KEY']), out: () => {} });
    assert.equal(res.wrote, false);
    assert.equal(fs.readFileSync(credPathFor(cwd), 'utf-8'), broken, 'operator file must be preserved');
});
