import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { extractSkills, extractWorkplaceType } from '../../scrapers/dice.js';

const DETAIL_HTML = fs.readFileSync(new URL('../fixtures/dice-detail.html', import.meta.url), 'utf-8');

test('extractSkills: returns [] for an empty page', () => {
    const $ = cheerio.load('<!doctype html><html><body><p>no skills here</p></body></html>');
    assert.deepEqual(extractSkills($), []);
});

test('extractSkills: parses the Skills <h3> + sibling <ul>', () => {
    const $ = cheerio.load(`
        <h3>Skills</h3>
        <ul>
            <li>JavaScript</li>
            <li>TypeScript</li>
            <li>  React  </li>
            <li></li>
        </ul>
    `);
    assert.deepEqual(extractSkills($), ['JavaScript', 'TypeScript', 'React']);
});

test('extractSkills: ignores h3 headings with other text', () => {
    const $ = cheerio.load(`
        <h3>Description</h3>
        <ul>
            <li>Not a skill</li>
        </ul>
    `);
    assert.deepEqual(extractSkills($), []);
});

test('extractSkills: tolerates a Skills h3 with no following ul', () => {
    const $ = cheerio.load('<h3>Skills</h3><p>(none listed)</p>');
    assert.deepEqual(extractSkills($), []);
});

test('extractSkills: runs against the real detail fixture without throwing', () => {
    const $ = cheerio.load(DETAIL_HTML);
    const skills = extractSkills($);
    assert.ok(Array.isArray(skills), 'should always return an array');
});

// Regression: the live 2026-07-24 markup nests the list inside a wrapper <div>
// (so `heading.next('ul')` matches nothing) and ships an aria-hidden duplicate
// <ul> used only for width measurement (so a naive "all <li>" fix double-counts).
// Before the fix this returned [] on every live Dice job.
test('extractSkills: CURRENT markup — nested list inside a wrapper div', () => {
    const $ = cheerio.load(`
        <div class="">
          <h3 class="font-bold text-pretty mb-2">Skills</h3>
          <div class="relative flex flex-col gap-2">
            <ul aria-hidden="true" class="pointer-events-none invisible absolute">
              <li><div><div>Java</div></div></li>
              <li><div><div>Spring Boot</div></div></li>
            </ul>
            <div>
              <ul class="flex flex-wrap gap-3">
                <li><div><div>Java</div></div></li>
                <li><div><div>Spring Boot</div></div></li>
                <li><div><div>Microservices</div></div></li>
              </ul>
            </div>
          </div>
        </div>
    `);
    assert.deepEqual(extractSkills($), ['Java', 'Spring Boot', 'Microservices']);
});

test('extractSkills: CURRENT markup — aria-hidden decoy alone never double-counts', () => {
    const $ = cheerio.load(`
        <div>
          <h3>Skills</h3>
          <div>
            <ul aria-hidden="true"><li>Python</li></ul>
            <div><ul><li>Python</li></ul></div>
          </div>
        </div>
    `);
    assert.deepEqual(extractSkills($), ['Python'], 'decoy must not duplicate');
});

test('extractWorkplaceType: returns null when the badge is absent', () => {
    const $ = cheerio.load('<!doctype html><html><body><p>no badge</p></body></html>');
    assert.equal(extractWorkplaceType($), null);
});

test('extractWorkplaceType: reads the badge text', () => {
    const $ = cheerio.load('<div data-testid="locationTypeBadge">Remote</div>');
    assert.equal(extractWorkplaceType($), 'Remote');
});

test('extractWorkplaceType: trims surrounding whitespace', () => {
    const $ = cheerio.load('<div data-testid="locationTypeBadge">  Hybrid  </div>');
    assert.equal(extractWorkplaceType($), 'Hybrid');
});

test('extractWorkplaceType: empty badge text → null', () => {
    const $ = cheerio.load('<div data-testid="locationTypeBadge"></div>');
    assert.equal(extractWorkplaceType($), null);
});

test('extractWorkplaceType: runs against the real detail fixture without throwing', () => {
    const $ = cheerio.load(DETAIL_HTML);
    const v = extractWorkplaceType($);
    assert.ok(v === null || typeof v === 'string', `expected null or string, got ${typeof v}`);
});
