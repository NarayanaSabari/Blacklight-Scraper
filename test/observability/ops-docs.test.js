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

// The per-OS setup guides were consolidated into docs/SETUP.md. The assertion
// that matters is unchanged: an always-on host must be told to run in daemon
// mode, or offline alerts never fire.
test('SETUP launchd plist sets SCRAPER_MODE=daemon', () => {
    const s = read('docs/SETUP.md');
    assert.match(s, /<key>SCRAPER_MODE<\/key>\s*\n\s*<string>daemon<\/string>/);
});

test('SETUP NSSM env sets SCRAPER_MODE=daemon', () => {
    const s = read('docs/SETUP.md');
    assert.match(s, /AppEnvironmentExtra[^\n]*SCRAPER_MODE=daemon/);
});

test('SETUP systemd example sets SCRAPER_MODE=daemon', () => {
    const s = read('docs/SETUP.md');
    assert.match(s, /Environment=SCRAPER_MODE=daemon/);
});
