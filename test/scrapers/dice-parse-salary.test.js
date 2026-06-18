import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary } from '../../scrapers/dice.js';

test('parseSalary: modern MonetaryAmount range with year period', () => {
    const r = parseSalary({
        '@type': 'MonetaryAmount',
        currency: 'USD',
        minValue: 60000,
        maxValue: 65000,
        unitText: 'YEAR',
    });
    assert.equal(r.min, 60000);
    assert.equal(r.max, 65000);
    assert.equal(r.currency, 'USD');
    assert.equal(r.period, 'YEAR');
    assert.equal(r.formatted, '$60,000 - $65,000/yr');
});

test('parseSalary: hourly variant', () => {
    const r = parseSalary({ minValue: 40, maxValue: 60, unitText: 'HOUR', currency: 'USD' });
    assert.equal(r.formatted, '$40 - $60/hr');
});

test('parseSalary: single value (no max)', () => {
    const r = parseSalary({ minValue: 100000, unitText: 'YEAR', currency: 'USD' });
    assert.equal(r.min, 100000);
    assert.equal(r.max, null);
    assert.equal(r.formatted, '$100,000/yr');
});

test('parseSalary: legacy nested value.minValue shape', () => {
    const r = parseSalary({ value: { minValue: 50000, maxValue: 70000 }, currency: 'USD' });
    assert.equal(r.min, 50000);
    assert.equal(r.max, 70000);
});

test('parseSalary: missing baseSalary → all null', () => {
    const r = parseSalary(null);
    assert.deepEqual(r, { min: null, max: null, currency: 'USD', period: null, formatted: 'N/A' });
});

test('parseSalary: undefined → all null', () => {
    const r = parseSalary(undefined);
    assert.equal(r.formatted, 'N/A');
});

test('parseSalary: no period → no suffix in formatted', () => {
    const r = parseSalary({ minValue: 70000, maxValue: 90000, currency: 'USD' });
    assert.equal(r.period, null);
    assert.equal(r.formatted, '$70,000 - $90,000');
});

test('parseSalary: non-USD currency preserved', () => {
    const r = parseSalary({ minValue: 50000, maxValue: 70000, currency: 'EUR', unitText: 'YEAR' });
    assert.equal(r.currency, 'EUR');
});
