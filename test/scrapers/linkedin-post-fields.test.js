// Field derivation from LinkedIn post bodies.
//
// Every "REAL POST" string below is actual text harvested from LinkedIn on
// 2026-07-30, or an alias observed in the prod global_roles table that the old
// first-line mapping produced. The prod damage these guard against: 241 posting
// fragments as role aliases across 98 of 346 roles, with wrong attributions such
// as a GCP post filed under "AWS Cloud Engineer".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    titleFromPost, locationFromPost, companyFromPost,
    looksLikeJobTitle, extractLabeled, NEUTRAL_TITLE,
} from '../../src/scrapers/linkedin-rsc/post-fields.js';

// ---------------------------------------------------------------- titles

test('REAL POST: labelled title is extracted, not the "Hiring Alert.!!" opener', () => {
    const text = [
        'Hiring Alert.!!',
        'Anyone you know might be looking ??',
        'Title: Databricks Data Engineer',
        'Location: Remote',
        'Work Mode: Contract (W2)',
    ].join('\n');
    assert.equal(titleFromPost(text), 'Databricks Data Engineer');
});

test('REAL POST: "Role :" with stray spacing', () => {
    const text = '!!Immediate Hiring!!\nRole : Pega Senior System Architect\nLocation : Sunrise, FL';
    assert.equal(titleFromPost(text), 'Pega Senior System Architect');
});

test('REAL POST: "Job Title:" wins over the promotional first line', () => {
    const text = 'We are Hiring for GCP Cloud Engineer with Java (Contract W2 Role)\n'
        + 'Job Title: GCP Cloud Engineer with Java\nLocation: St. Louis, MO (Remote Ok)';
    assert.equal(titleFromPost(text), 'GCP Cloud Engineer with Java');
});

test('REAL POST: a bare role as the first line is accepted', () => {
    assert.equal(titleFromPost('Senior Data Engineer - Remote\nApply now'), 'Senior Data Engineer - Remote');
});

test('REAL POST: greeting-only opener falls back to the neutral title', () => {
    const text = 'Hello Recruiters,\nRepresenting strong C2C consultants available immediately';
    assert.equal(titleFromPost(text), NEUTRAL_TITLE);
});

test('REAL POST: "Hiring Alert.!!" alone never becomes the title', () => {
    assert.equal(titleFromPost('Hiring Alert.!!\nAnyone you know might be looking ??'), NEUTRAL_TITLE);
});

test('REAL PROD ALIAS: prose blob is rejected (this one was filed under AWS Cloud Engineer)', () => {
    const bad = 'We are Hiring for GCP Cloud Engineer with Java (Contract W2 Role)Job Title: '
        + 'GCP Cloud Engineer with JavaLocation: St. Louis, MO (Remote Ok)Contract W2 RoleMandatory skills';
    assert.equal(looksLikeJobTitle(bad), false);
});

test('REAL PROD ALIAS: greeting boilerplate is rejected (was filed under Reporting Specialist)', () => {
    const bad = 'Happy Monday Everyone,Hope you all are doing great!Greetings from ExpertsPro Inc.,'
        + 'My name is Doni, and I am a Staffing Specialist';
    assert.equal(looksLikeJobTitle(bad), false);
});

test('a derived title never exceeds the length the backend guard accepts', () => {
    const long = 'Title: ' + 'Senior '.repeat(40) + 'Engineer';
    const out = titleFromPost(long);
    assert.ok(out.length <= 100, `got ${out.length}`);
    assert.equal(out, NEUTRAL_TITLE, 'an over-long value is neutralised, not truncated into a fragment');
});

test('titles with contact debris are rejected', () => {
    assert.equal(looksLikeJobTitle('Data Engineer call 7000032466'), false);
    assert.equal(looksLikeJobTitle('QA Lead apply at jobs@acme.com'), false);
    assert.equal(looksLikeJobTitle('hashtag#Hiring GCP Cloud Engineer'), false);
});

test('real job titles are accepted', () => {
    for (const good of [
        'Senior Data Engineer',
        'Pega Lead System Architect (CLSA)',
        'GCP Cloud Engineer with Java',
        'Site Reliability Engineer II',
        'Full Stack Developer',
    ]) assert.equal(looksLikeJobTitle(good), true, good);
});

test('generic openers are rejected even when short', () => {
    for (const bad of ['Hiring', 'Hiring Alert.!!', 'Hello Recruiters,', 'Greetings', 'Urgent!!', 'Immediate', 'Looking for']) {
        assert.equal(looksLikeJobTitle(bad), false, bad);
    }
});

test('empty or junk body yields the neutral title, never empty (schema requires non-empty)', () => {
    for (const v of ['', null, undefined, '   ', '🔥🔥🔥', '#hiring #jobs']) {
        assert.equal(titleFromPost(v), NEUTRAL_TITLE);
    }
});

// -------------------------------------------------------------- locations

test('REAL POST: post location overrides the echoed search location', () => {
    const text = 'Resource Required - Data Engineer (5+)\nLocation: Delhi Hybrid';
    assert.equal(locationFromPost(text, 'United States'), 'Delhi Hybrid');
});

test('no stated location falls back to the search location', () => {
    assert.equal(locationFromPost('Hiring a data engineer', 'United States'), 'United States');
});

test('a prose "location" is not trusted', () => {
    const text = 'Location: we are flexible and open to discussing arrangements that suit '
        + 'the right candidate across many of our offices nationwide';
    assert.equal(locationFromPost(text, 'United States'), 'United States');
});

// -------------------------------------------------------------- companies

test('REAL POST: named client is extracted', () => {
    assert.equal(companyFromPost('Hiring: SRE II\nClient: Cognizant\nContract type W2'), 'Cognizant');
});

test('no named client yields null so the caller falls back to the author', () => {
    assert.equal(companyFromPost('Hiring a data engineer, DM me'), null);
});

// ---------------------------------------------------------------- labels

test('extractLabeled stops at the next label on the same line', () => {
    assert.equal(extractLabeled('Title: Data Engineer Location: Austin, TX', ['title']), 'Data Engineer');
});

test('extractLabeled respects label priority order', () => {
    const text = 'Hiring: Something Vague\nJob Title: Staff Data Engineer';
    assert.equal(extractLabeled(text, ['job title', 'hiring']), 'Staff Data Engineer');
});

test('banner phrases are rejected but real titles starting with the same word survive', () => {
    for (const bad of ['Immediate Hiring!!', 'Available Bench Consultants', 'Urgent Requirement', 'New Openings', 'Hot List Update']) {
        assert.equal(looksLikeJobTitle(bad), false, `should reject: ${bad}`);
    }
    // The opener word is only disqualifying when used as a banner.
    for (const good of ['Hiring Manager', 'Hiring Coordinator', 'Needs Assessment Analyst', 'Bench Sales Recruiter']) {
        assert.equal(looksLikeJobTitle(good), true, `should accept: ${good}`);
    }
});

test('parenthetical qualifiers survive intact; dangling ones are dropped', () => {
    // ")" is part of a real title and must not be eaten as trailing noise.
    assert.equal(titleFromPost('Title: Pega Lead System Architect (CLSA)'), 'Pega Lead System Architect (CLSA)');
    assert.equal(
        titleFromPost('Title: Data Engineer (7+ years of experience) (W2 Contract)'),
        'Data Engineer (7+ years of experience) (W2 Contract)',
    );
    // An unbalanced "(" means a split landed mid-parenthetical — drop the fragment.
    assert.equal(titleFromPost('Role: Data Engineer (PySpark'), 'Data Engineer');
    assert.equal(titleFromPost('Title: Senior Data Engineer!!!'), 'Senior Data Engineer');
});

test('LinkedIn UI debris never becomes a title (was "Patanjali Kumar Pendyala • 3rd+")', () => {
    assert.equal(looksLikeJobTitle('Patanjali Kumar Pendyala • 3rd+'), false);
    assert.equal(looksLikeJobTitle('John Smith • 2nd'), false);
    assert.equal(looksLikeJobTitle('Jane Doe 15,000 followers'), false);
});

test('a title must actually name a role', () => {
    for (const bad of ['Greetings of the day', 'Job Description', 'We’re Hiring', 'Not for Bench sales', 'Please share resumes']) {
        assert.equal(looksLikeJobTitle(bad), false, `should reject: ${bad}`);
    }
});

test('smart apostrophes are normalized before matching', () => {
    assert.equal(looksLikeJobTitle('We’re Hiring'), false, 'curly-quote variant must be caught too');
});

test('locations keep balanced parens and drop dangling ones', () => {
    assert.equal(locationFromPost('Location: Dearborn, MI (Onsite', 'US'), 'Dearborn, MI');
    assert.equal(locationFromPost('Location: Jersey City, NJ (Hybrid)', 'US'), 'Jersey City, NJ (Hybrid)');
});
