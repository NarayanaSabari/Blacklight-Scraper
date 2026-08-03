// Guards the control panel against stored XSS.
//
// The panel renders values that originate from REMOTE, attacker-influenced
// sources — a submission's error text can carry remote HTTP response body, a
// validation verdict's URL is chosen by the remote site via redirects — into a
// page that holds restart, pause, and login-start buttons. The loopback guard
// does not mitigate this: the payload fires in the operator's browser at the
// moment they open the panel to diagnose the failure that planted it.
//
// These tests assert the rule structurally rather than via a DOM, because the
// browser script is a string spliced into the page at render time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPage } from '../../src/panel/page.js';

const PAGE = renderPage();

// The interpolation sites that carry remote-sourced data. Each entry is a
// fragment that MUST appear in the rendered script verbatim — i.e. wrapped in
// esc(). If someone drops the escaping, the fragment stops matching.
const MUST_BE_ESCAPED = [
    // renderRecent — the highest-risk row: platform + error come from submits.
    "esc(e.platform)",
    "esc(e.error || '')",
    "esc(e.outcome)",
    "esc(e.jobsSent)",
    // renderLinkedin — profileDir/profileKey/lastError.
    "esc(login.lastError || '—')",
    "esc(linkedin.profileDir || '—')",
    // renderSession — role names come off the queue.
    "esc(session.role)",
    "esc(session.sessionId)",
    // renderAlerts — alert text embeds upstream error strings.
    "esc(a.message)",
    // renderSpool.
    "esc(spool.count)",
];

test('every remote-sourced interpolation site is wrapped in esc()', () => {
    for (const fragment of MUST_BE_ESCAPED) {
        assert.ok(
            PAGE.includes(fragment),
            `Unescaped interpolation: expected the rendered page to contain "${fragment}". `
            + 'A value reachable from remote input is being written into innerHTML raw.',
        );
    }
});

test('the emitted browser script actually PARSES', () => {
    // The script is built by interpolating into a template literal, so a
    // backslash escape written in the source is consumed at build time and
    // never reaches the browser. That shipped once: `I\'m logged in` became a
    // bare apostrophe that terminated the string and broke the ENTIRE script,
    // leaving every card on the page empty while the server still answered
    // 200 on /panel and /panel/api/status. Substring assertions cannot catch
    // that — only compiling the result can.
    const script = PAGE.slice(
        PAGE.indexOf('<script>') + '<script>'.length,
        PAGE.lastIndexOf('</script>'),
    );
    assert.ok(script.length > 1000, 'expected to find the inline script');

    // new Function compiles without executing — no DOM needed.
    assert.doesNotThrow(
        () => new Function(script),
        'the inline panel script must be syntactically valid JavaScript',
    );
});

test('the emitted script contains no build-time-stripped escapes', () => {
    const script = PAGE.slice(PAGE.indexOf('<script>'), PAGE.lastIndexOf('</script>'));
    // A lone apostrophe inside a single-quoted JS string is the exact failure
    // mode above. Catch the specific shape rather than all quoting in general.
    assert.ok(
        !/'[^'\n]*\b\w'\w/.test(script),
        'found an unescaped apostrophe inside a single-quoted string',
    );
});

test('pill() escapes both its text and its level', () => {
    assert.match(
        PAGE,
        /function pill\(text, level\) \{\s*return '<span class="pill ' \+ esc\(level\) \+ '">' \+ esc\(text\) \+ '<\/span>';/,
        'pill() composes markup from both arguments and must escape each one.',
    );
});

test('the escaping helper is inlined into the browser script', () => {
    // page.js splices escapeHtml.toString() in, so server and browser can
    // never drift to two different definitions of the rule.
    assert.ok(PAGE.includes('function escapeHtml(value)'), 'escapeHtml source must be inlined');
    assert.ok(PAGE.includes('const esc = escapeHtml;'), 'esc must alias the inlined helper');

    for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
        assert.ok(PAGE.includes(entity), `escaping must cover ${entity}`);
    }
});

test('a script payload in remote-sourced data cannot reach innerHTML raw', async () => {
    // End-to-end on the helper itself, using the exact shape an attacker would
    // plant in a submission error string.
    const { escapeHtml } = await import('../../src/panel/escape-html.js');
    const payload = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(payload);

    assert.ok(!escaped.includes('<img'), 'tag must not survive escaping');
    assert.ok(!escaped.includes('onerror=alert(1)>'), 'handler must not survive escaping');
    assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
});

test('escapeHtml coerces nullish and non-string input safely', async () => {
    const { escapeHtml } = await import('../../src/panel/escape-html.js');

    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(false), 'false');
    assert.equal(escapeHtml("it's <b>"), 'it&#39;s &lt;b&gt;');
});
