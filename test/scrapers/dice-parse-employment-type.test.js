import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmploymentType } from '../../scrapers/dice.js';

test('parseEmploymentType: FULL_TIME → full_time', () => {
    assert.equal(parseEmploymentType('FULL_TIME'), 'full_time');
});

test('parseEmploymentType: PART_TIME → part_time', () => {
    assert.equal(parseEmploymentType('PART_TIME'), 'part_time');
});

test('parseEmploymentType: CONTRACTOR → contract', () => {
    assert.equal(parseEmploymentType('CONTRACTOR'), 'contract');
});

test('parseEmploymentType: TEMPORARY → temporary', () => {
    assert.equal(parseEmploymentType('TEMPORARY'), 'temporary');
});

test('parseEmploymentType: INTERN → internship', () => {
    assert.equal(parseEmploymentType('INTERN'), 'internship');
});

test('parseEmploymentType: array form → comma-separated', () => {
    assert.equal(parseEmploymentType(['FULL_TIME', 'PART_TIME']), 'full_time, part_time');
});

test('parseEmploymentType: unknown string → lowercase passthrough', () => {
    assert.equal(parseEmploymentType('SOMETHING_NEW'), 'something_new');
});

test('parseEmploymentType: null / undefined / empty → N/A', () => {
    assert.equal(parseEmploymentType(null), 'N/A');
    assert.equal(parseEmploymentType(undefined), 'N/A');
    assert.equal(parseEmploymentType(''), 'N/A');
});

test('parseEmploymentType: empty array → N/A', () => {
    assert.equal(parseEmploymentType([]), 'N/A');
});
