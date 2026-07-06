import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptConfig } from '../../scripts/linkedin-login.js';

// Build a fake `ask` that answers by prompt-substring and records which
// prompts it was actually asked (to assert the proxy gating).
function fakeAsk(answers) {
    const asked = [];
    const fn = async (q) => {
        asked.push(q);
        if (/account \/ profile key/i.test(q)) return answers.account ?? '';
        if (/proxy/i.test(q)) return answers.proxy ?? '';
        return '';
    };
    fn.asked = asked;
    return fn;
}

test('blank account → null key, null proxy, and proxy is NOT prompted', async () => {
    const ask = fakeAsk({ account: '' });
    assert.deepEqual(await promptConfig(ask), { profileKey: null, proxy: null });
    assert.equal(ask.asked.some((q) => /proxy/i.test(q)), false, 'proxy must not be asked without an account key');
});

test('account + proxy → both set, proxy IS prompted', async () => {
    const ask = fakeAsk({ account: 'li-acct-2', proxy: 'host:1:u:p' });
    assert.deepEqual(await promptConfig(ask), { profileKey: 'li-acct-2', proxy: 'host:1:u:p' });
    assert.equal(ask.asked.some((q) => /proxy/i.test(q)), true, 'proxy must be asked when an account key is given');
});

test('account + blank proxy → key set, proxy null', async () => {
    const ask = fakeAsk({ account: 'myacct', proxy: '' });
    assert.deepEqual(await promptConfig(ask), { profileKey: 'myacct', proxy: null });
});

test('whitespace is trimmed; whitespace-only answers are treated as blank', async () => {
    assert.deepEqual(await promptConfig(fakeAsk({ account: '  ' })), { profileKey: null, proxy: null });
    assert.deepEqual(
        await promptConfig(fakeAsk({ account: '  key-x  ', proxy: '  h:2:u:p  ' })),
        { profileKey: 'key-x', proxy: 'h:2:u:p' },
    );
});
