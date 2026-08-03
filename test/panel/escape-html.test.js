import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../../src/panel/escape-html.js';

test('escapeHtml: escapes all five XSS-relevant characters', () => {
    assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});

test('escapeHtml: neutralizes a classic <img onerror> payload', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(payload);
    assert.ok(!escaped.includes('<img'));
    assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
});

test('escapeHtml: null/undefined coerce to empty string, not "null"/"undefined"', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml: numbers and booleans coerce safely', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(true), 'true');
    assert.equal(escapeHtml(false), 'false');
});

test('escapeHtml: plain text without special characters passes through unchanged', () => {
    assert.equal(escapeHtml('dice'), 'dice');
    assert.equal(escapeHtml('li-acct-1'), 'li-acct-1');
});
