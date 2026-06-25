import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoginArgs } from '../../scripts/linkedin-login.js';

test('parseLoginArgs reads --account <profile_key>', () => {
    assert.deepEqual(parseLoginArgs(['--account', 'li-acct-2']), { profileKey: 'li-acct-2', proxy: null });
    assert.deepEqual(parseLoginArgs([]), { profileKey: null, proxy: null });
});

test('parseLoginArgs reads --proxy when provided with --account', () => {
    assert.deepEqual(
        parseLoginArgs(['--account', 'li-acct-2', '--proxy', 'host:1:u:p']),
        { profileKey: 'li-acct-2', proxy: 'host:1:u:p' },
    );
});

test('parseLoginArgs returns null proxy without --proxy flag', () => {
    assert.deepEqual(parseLoginArgs(['--account', 'myacct']), { profileKey: 'myacct', proxy: null });
});
