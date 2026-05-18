import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('.env.example documents SCRAPER_STRICT_EMPTY (default false)', () => {
    const e = read('.env.example');
    assert.match(e, /SCRAPER_STRICT_EMPTY\s*=\s*false/);
    assert.match(e, /strict/i);
});

test('MAC_SETUP launchd plist sets SCRAPER_MODE=daemon', () => {
    const m = read('docs/MAC_SETUP.md');
    assert.match(m, /<key>SCRAPER_MODE<\/key>\s*\n\s*<string>daemon<\/string>/);
});

test('WINDOWS_SETUP NSSM env sets SCRAPER_MODE=daemon', () => {
    const w = read('docs/WINDOWS_SETUP.md');
    assert.match(w, /AppEnvironmentExtra[^\n]*SCRAPER_MODE=daemon/);
});
