import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveLinkedinCredential } from '../../src/setup/linkedin-credential.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lilogin-')); }
const credPathFor = (cwd) => path.join(cwd, 'config', 'credentials.json');
// Distinctive so the "never echo the auth cookie" assertion has teeth.
const LI_AT = 'SECRET-LIAT-NEVER-ECHO-9X';
const liCookies = () => [
    { name: 'li_at', value: LI_AT, domain: '.www.linkedin.com', path: '/' },
    { name: 'JSESSIONID', value: 'ajax:1', domain: '.www.linkedin.com', path: '/' },
];

test('valid login (li_at present): writes linkedin.credentials to credentials.json', () => {
    const cwd = tmp();
    const out = [];
    const res = saveLinkedinCredential({ cwd, cookies: liCookies(), isIgnored: () => true, out: (s) => out.push(String(s)) });
    assert.equal(res.saved, true);
    const cred = JSON.parse(fs.readFileSync(credPathFor(cwd), 'utf-8'));
    assert.ok(Array.isArray(cred.linkedin.credentials));
    assert.ok(cred.linkedin.credentials.some((c) => c.name === 'li_at'), 'li_at persisted');
    assert.ok(!out.join('\n').includes(LI_AT), 'the auth cookie value must never be echoed');
});

test('merge preserves an existing blacklight section', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    fs.writeFileSync(credPathFor(cwd), '{"blacklight":{"apiUrl":"https://api.qpeakhire.com","apiKey":"KEY"}}');
    saveLinkedinCredential({ cwd, cookies: liCookies(), isIgnored: () => true, out: () => {} });
    const cred = JSON.parse(fs.readFileSync(credPathFor(cwd), 'utf-8'));
    assert.equal(cred.blacklight.apiKey, 'KEY', 'blacklight preserved');
    assert.ok(cred.linkedin.credentials.some((c) => c.name === 'li_at'), 'linkedin added');
});

test('not logged in (no li_at cookie): saves nothing', () => {
    const cwd = tmp();
    const res = saveLinkedinCredential({
        cwd,
        cookies: [{ name: 'bcookie', value: 'x', domain: '.linkedin.com', path: '/' }],
        isIgnored: () => true,
        out: () => {},
    });
    assert.equal(res.saved, false);
    assert.ok(!fs.existsSync(credPathFor(cwd)), 'nothing written when not logged in');
});

test('empty cookies: saves nothing', () => {
    const cwd = tmp();
    const res = saveLinkedinCredential({ cwd, cookies: [], isIgnored: () => true, out: () => {} });
    assert.equal(res.saved, false);
    assert.ok(!fs.existsSync(credPathFor(cwd)));
});

test('filters to linkedin-domain cookies only', () => {
    const cwd = tmp();
    const cookies = [...liCookies(), { name: 'ga', value: 'y', domain: '.example.com', path: '/' }];
    saveLinkedinCredential({ cwd, cookies, isIgnored: () => true, out: () => {} });
    const cred = JSON.parse(fs.readFileSync(credPathFor(cwd), 'utf-8'));
    assert.ok(cred.linkedin.credentials.every((c) => c.domain.includes('linkedin')), 'only linkedin cookies kept');
    assert.ok(!cred.linkedin.credentials.some((c) => c.name === 'ga'), 'foreign cookie dropped');
});

test('git-ignore guard: refuses to write when target is NOT ignored', () => {
    const cwd = tmp();
    const res = saveLinkedinCredential({ cwd, cookies: liCookies(), isIgnored: () => false, out: () => {} });
    assert.equal(res.saved, false);
    assert.ok(!fs.existsSync(credPathFor(cwd)), 'no secret written to a non-ignored path');
});

test('credentials.json is written 0600 (POSIX)', { skip: process.platform === 'win32' }, () => {
    const cwd = tmp();
    saveLinkedinCredential({ cwd, cookies: liCookies(), isIgnored: () => true, out: () => {} });
    assert.equal(fs.statSync(credPathFor(cwd)).mode & 0o777, 0o600);
});

test('unparseable existing credentials.json is NOT destroyed', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, 'config'));
    const broken = '{ not valid json';
    fs.writeFileSync(credPathFor(cwd), broken);
    const res = saveLinkedinCredential({ cwd, cookies: liCookies(), isIgnored: () => true, out: () => {} });
    assert.equal(res.saved, false);
    assert.equal(fs.readFileSync(credPathFor(cwd), 'utf-8'), broken, 'operator file preserved');
});
