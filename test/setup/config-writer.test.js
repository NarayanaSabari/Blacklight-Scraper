import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCredentialsJson, buildDotEnv, mergeCredentials, mergeDotEnv }
    from '../../src/setup/config-writer.js';

const LI = [{ name: 'li_at', value: 'x' }];

test('LOCAL: credentials.json has only the supplied platform sections', () => {
    const c = buildCredentialsJson({
        mode: 'local',
        platforms: { linkedin: { credentials: LI }, techfetch: { email: 'a@b.c', password: 'p' } },
    });
    assert.deepEqual(c, { linkedin: { credentials: LI }, techfetch: { email: 'a@b.c', password: 'p' } });
    assert.equal(c.blacklight, undefined);
});

test('REMOTE: credentials.json has blacklight + scraperCredentials, no cookies', () => {
    const c = buildCredentialsJson({
        mode: 'remote',
        blacklight: { apiUrl: 'https://b', apiKey: 'bk' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'ck' },
    });
    assert.deepEqual(c, {
        blacklight: { apiUrl: 'https://b', apiKey: 'bk' },
        scraperCredentials: { apiUrl: 'https://c', apiKey: 'ck' },
    });
});

test('buildDotEnv LOCAL: NODE_ENV=development; only chosen flags; omits unset', () => {
    const env = buildDotEnv({ mode: 'local', headless: false, strictEmpty: false, scraperMode: 'interactive', port: 3001 });
    assert.match(env, /^NODE_ENV=development$/m);
    assert.doesNotMatch(env, /LINKEDIN_HEADLESS/);
    assert.doesNotMatch(env, /SCRAPER_STRICT_EMPTY/);
    assert.doesNotMatch(env, /^PORT=/m);
    assert.match(env, /^SCRAPER_MODE=interactive$/m);
});

test('buildDotEnv: sets flags when chosen', () => {
    const env = buildDotEnv({ mode: 'remote', headless: true, strictEmpty: true, scraperMode: 'daemon', port: 8080 });
    assert.match(env, /^NODE_ENV=production$/m);
    assert.match(env, /^LINKEDIN_HEADLESS=true$/m);
    assert.match(env, /^SCRAPER_STRICT_EMPTY=true$/m);
    assert.match(env, /^SCRAPER_MODE=daemon$/m);
    assert.match(env, /^PORT=8080$/m);
});

test('mergeCredentials: shallow top-level — next replaces matching key, others preserved', () => {
    const merged = mergeCredentials(
        { blacklight: { apiUrl: 'old' }, linkedin: { credentials: ['old'] } },
        { linkedin: { credentials: LI } });
    assert.deepEqual(merged, { blacklight: { apiUrl: 'old' }, linkedin: { credentials: LI } });
});

test('mergeDotEnv: next keys overwrite their lines; unrelated existing lines/comments kept', () => {
    const out = mergeDotEnv('# hdr\nNODE_ENV=production\nKEEP=1\n', 'NODE_ENV=development\nPORT=8080\n');
    assert.match(out, /# hdr/);
    assert.match(out, /^KEEP=1$/m);
    assert.match(out, /^NODE_ENV=development$/m);
    assert.doesNotMatch(out, /^NODE_ENV=production$/m);
    assert.match(out, /^PORT=8080$/m);
});

test('mergeDotEnv: a duplicated overridden key is de-duplicated (no double-write)', () => {
    const out = mergeDotEnv('PORT=3001\nLOG_LEVEL=info\nPORT=8080\n', 'PORT=9999\n');
    const portLines = out.split('\n').filter((l) => l.startsWith('PORT='));
    assert.deepEqual(portLines, ['PORT=9999']);
    assert.match(out, /^LOG_LEVEL=info$/m);
});

test('mergeDotEnv: appending to a trailing-newline file adds no blank line; no leading blank on empty', () => {
    assert.equal(mergeDotEnv('A=1\n', 'NEW=2\n'), 'A=1\nNEW=2\n');
    assert.equal(mergeDotEnv('', 'A=1\n'), 'A=1\n');
    assert.equal(mergeDotEnv(undefined, 'A=1\n'), 'A=1\n');
});

test('mergeDotEnv: a non-overridden duplicate key is left untouched', () => {
    const out = mergeDotEnv('X=1\nX=2\n', 'Y=3\n');
    assert.equal(out, 'X=1\nX=2\nY=3\n');
});
