import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocationDate, parsePay, isPromoted } from '../../scrapers/monster.js';

test('parseLocationDate: joined "Redmond, WA7 days ago" (probe-observed)', () => {
    assert.deepEqual(parseLocationDate('Redmond, WA7 days ago'), {
        location: 'Redmond, WA',
        datePosted: '7 days ago',
    });
});

test('parseLocationDate: separated by newline', () => {
    assert.deepEqual(parseLocationDate('Redmond, WA\n7 days ago'), {
        location: 'Redmond, WA',
        datePosted: '7 days ago',
    });
});

test('parseLocationDate: Remote location', () => {
    assert.deepEqual(parseLocationDate('Remote\n3 days ago'), {
        location: 'Remote',
        datePosted: '3 days ago',
    });
});

test('parseLocationDate: hours/weeks/months variants', () => {
    assert.equal(parseLocationDate('Atlanta, GA2 hours ago').datePosted, '2 hours ago');
    assert.equal(parseLocationDate('NYC, NY1 week ago').datePosted, '1 week ago');
    assert.equal(parseLocationDate('Austin, TX2 months ago').datePosted, '2 months ago');
});

test('parseLocationDate: missing date → location only', () => {
    assert.deepEqual(parseLocationDate('Atlanta, GA'), { location: 'Atlanta, GA', datePosted: '' });
});

test('parseLocationDate: nothing parseable → both empty', () => {
    assert.deepEqual(parseLocationDate('lorem ipsum'), { location: '', datePosted: '' });
    assert.deepEqual(parseLocationDate(''), { location: '', datePosted: '' });
});

test('parsePay: range with units', () => {
    assert.equal(parsePay('Some prefix $142,800–$274,800 / Year suffix'), '$142,800–$274,800 / Year');
});

test('parsePay: hyphen-not-en-dash variant', () => {
    assert.equal(parsePay('$50,000-$80,000 / Year'), '$50,000-$80,000 / Year');
});

test('parsePay: single value', () => {
    assert.equal(parsePay('Compensation $85,000 / Year'), '$85,000 / Year');
});

test('parsePay: hourly', () => {
    assert.equal(parsePay('Up to $40 / Hour'), '$40 / Hour');
});

test('parsePay: not present → empty string', () => {
    assert.equal(parsePay('No pay info here'), '');
    assert.equal(parsePay(''), '');
});

test('isPromoted: explicit Promoted badge', () => {
    assert.equal(isPromoted('Software Engineer\nMicrosoft\nRedmond, WA\nPromoted'), true);
});

test('isPromoted: absence returns false', () => {
    assert.equal(isPromoted('Software Engineer\nMicrosoft\nRedmond, WA'), false);
    assert.equal(isPromoted(''), false);
});
