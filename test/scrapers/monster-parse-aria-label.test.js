import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAriaLabel } from '../../scrapers/monster.js';

test('parseAriaLabel: standard "Title at Company" → title + company', () => {
    assert.deepEqual(parseAriaLabel('Principal Software Engineer at Microsoft Corporation'), {
        title: 'Principal Software Engineer',
        company: 'Microsoft Corporation',
    });
});

test('parseAriaLabel: multi-word company with spaces', () => {
    assert.deepEqual(parseAriaLabel('Software Engineer(s) at Praxent'), {
        title: 'Software Engineer(s)',
        company: 'Praxent',
    });
});

test('parseAriaLabel: title containing " at " uses LAST " at " as the separator', () => {
    assert.deepEqual(parseAriaLabel('Engineer III at Google'), {
        title: 'Engineer III',
        company: 'Google',
    });
});

test('parseAriaLabel: empty / nullish input → null', () => {
    assert.equal(parseAriaLabel(''), null);
    assert.equal(parseAriaLabel(null), null);
    assert.equal(parseAriaLabel(undefined), null);
});

test('parseAriaLabel: no " at " separator → null (signals dom_changed)', () => {
    assert.equal(parseAriaLabel('Just a title'), null);
    assert.equal(parseAriaLabel('View job'), null);
});

test('parseAriaLabel: separator-only edge case → null', () => {
    assert.equal(parseAriaLabel(' at '), null);
    assert.equal(parseAriaLabel('Title at '), null);
    assert.equal(parseAriaLabel(' at Company'), null);
});
