import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indeedProfileDir, indeedProfileExists } from '../../scrapers/indeed.js';

test('indeedProfileDir: defaults to ~/.blacklight-indeed-profile', () => {
    const saved = process.env.INDEED_PROFILE_DIR;
    delete process.env.INDEED_PROFILE_DIR;
    try {
        assert.equal(indeedProfileDir(), path.join(os.homedir(), '.blacklight-indeed-profile'));
    } finally {
        if (saved !== undefined) process.env.INDEED_PROFILE_DIR = saved;
    }
});

test('indeedProfileDir: honors INDEED_PROFILE_DIR override', () => {
    const saved = process.env.INDEED_PROFILE_DIR;
    process.env.INDEED_PROFILE_DIR = '/tmp/custom-indeed-profile';
    try {
        assert.equal(indeedProfileDir(), '/tmp/custom-indeed-profile');
    } finally {
        if (saved === undefined) delete process.env.INDEED_PROFILE_DIR;
        else process.env.INDEED_PROFILE_DIR = saved;
    }
});

test('indeedProfileExists: missing → false, non-empty → true, empty → false', () => {
    const saved = process.env.INDEED_PROFILE_DIR;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'indeed-prof-'));
    try {
        process.env.INDEED_PROFILE_DIR = path.join(base, 'nope');
        assert.equal(indeedProfileExists(), false, 'missing dir');

        const present = path.join(base, 'yes');
        fs.mkdirSync(present);
        fs.writeFileSync(path.join(present, 'Default'), 'x');
        process.env.INDEED_PROFILE_DIR = present;
        assert.equal(indeedProfileExists(), true, 'non-empty dir');

        const empty = path.join(base, 'empty');
        fs.mkdirSync(empty);
        process.env.INDEED_PROFILE_DIR = empty;
        assert.equal(indeedProfileExists(), false, 'empty dir');
    } finally {
        if (saved === undefined) delete process.env.INDEED_PROFILE_DIR;
        else process.env.INDEED_PROFILE_DIR = saved;
        fs.rmSync(base, { recursive: true, force: true });
    }
});
