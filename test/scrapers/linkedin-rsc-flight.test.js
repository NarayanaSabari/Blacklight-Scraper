// RSC flight-format parsing for LinkedIn content search.
//
// LinkedIn's content search is a React-Server-Components app. Its data endpoint
// returns a "flight" payload: newline-delimited `<rowId>:<json>` rows where the
// rendered element tree is split across rows and joined by `$L<id>` references.
// These tests pin the format facts the parser depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    parseFlightRows,
    findTextGroups,
    groupText,
} from '../../src/scrapers/linkedin-rsc/flight.js';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// --- parseFlightRows --------------------------------------------------------

test('parseFlightRows: parses `<id>:<json>` rows into id + value', () => {
    const body = '1:{"a":1}\n2:["b",2]\n';
    const rows = parseFlightRows(body);
    assert.deepEqual(rows.map((r) => r.id), ['1', '2']);
    assert.deepEqual(rows[0].value, { a: 1 });
    assert.deepEqual(rows[1].value, ['b', 2]);
});

test('parseFlightRows: skips rows whose payload is not JSON (streaming markers)', () => {
    // Real payloads carry non-JSON rows such as `4:HL["...","style"]` and bare
    // partial-stream rows. They must be skipped, not throw.
    const body = '1:{"ok":true}\n4:HL["/x.css","style"]\n5:not json at all\n6:[1]\n';
    const rows = parseFlightRows(body);
    assert.deepEqual(rows.map((r) => r.id), ['1', '6']);
});

test('parseFlightRows: reports each row byte offset in the original body', () => {
    // Offsets matter: one post's commentary row is associated to its card by
    // emission proximity, so positions must survive parsing.
    const first = '1:{"a":1}';
    const body = `${first}\n2:{"b":2}\n`;
    const rows = parseFlightRows(body);
    assert.equal(rows[0].offset, 0);
    assert.equal(rows[1].offset, first.length + 1);
});

// --- groupText -------------------------------------------------------------

test('groupText: renders <br> elements as newlines', () => {
    // Without this, paragraphs glue together ("ConsultantsHello,").
    const node = ['$', 'span', 'text-attr-0', {
        children: [
            ['$', 'span', '0', { children: [null, 'Line one'] }],
            ['$', 'span', '1', { children: [['$', 'br', null, {}], 'Line two'] }],
        ],
    }];
    assert.equal(groupText(node), 'Line one\nLine two');
});

test('groupText: skips flight sentinels ($L refs, $undefined) but keeps $$-escaped text', () => {
    const node = ['$', 'span', 'text-attr-0', {
        children: [
            ['$', 'span', '0', { children: [null, 'Rate is'] }],
            '$L2be',
            '$undefined',
            ['$', 'span', '1', { children: [['$', 'br', null, {}], '$$60/hr'] }],
        ],
    }];
    // "$L2be"/"$undefined" are markup, not content. "$$60/hr" is a literal "$".
    assert.equal(groupText(node), 'Rate is\n$60/hr');
});

test('groupText: ignores element type and key slots, reading only children', () => {
    // Sweeping sibling props drags in binding ids and i18n patterns, which is
    // exactly what corrupted earlier extraction attempts.
    const node = ['$', 'span', 'text-attr-0', {
        className: '_7285ccbd c8dab43f',
        stateKey: 'charExceededCountBinding-CgsIgMC0',
        i18nPattern: { pattern: '{0,number,integer}', locale: 'en_US' },
        children: [['$', 'span', '0', { children: [null, 'Hiring Data Engineer'] }]],
    }];
    assert.equal(groupText(node), 'Hiring Data Engineer');
});

// --- findTextGroups --------------------------------------------------------

test('findTextGroups: finds elements keyed text-attr-<n>', () => {
    const tree = ['$', 'div', null, {
        children: [
            ['$', 'span', 'text-attr-0', { children: [['$', 'span', '0', { children: [null, 'body'] }]] }],
        ],
    }];
    const groups = findTextGroups(tree);
    assert.equal(groups.length, 1);
    assert.equal(groupText(groups[0]), 'body');
});

test('findTextGroups: also finds bare numeric-keyed sibling runs with no text-attr wrapper', () => {
    // A second render path emits post lines as siblings keyed "0","1","2" with
    // no text-attr element. A detector that only knows text-attr loses those
    // bodies entirely.
    const tree = ['$', 'div', null, {
        children: [[
            ['$', 'span', '0', { children: [null, 'Hiring: Senior Data Engineer'] }],
            ['$', 'span', '1', { children: [['$', 'br', null, {}], 'Location: Remote'] }],
        ]],
    }];
    const groups = findTextGroups(tree);
    assert.equal(groups.length, 1);
    assert.equal(groupText(groups[0]), 'Hiring: Senior Data Engineer\nLocation: Remote');
});

test('findTextGroups: a single numeric-keyed child is not a text group', () => {
    // Guard against over-matching: one keyed child is ordinary markup.
    const tree = ['$', 'div', null, {
        children: [[['$', 'span', '0', { children: [null, 'just one'] }]]],
    }];
    assert.deepEqual(findTextGroups(tree), []);
});

// --- against a real captured payload ---------------------------------------

test('parseFlightRows: parses a real captured search payload', () => {
    const rows = parseFlightRows(readFixture('linkedin-rsc-search.txt'));
    assert.ok(rows.length > 50, `expected many rows, got ${rows.length}`);
    // Offsets must be strictly increasing in document order.
    for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i].offset > rows[i - 1].offset, 'offsets must increase');
    }
});
