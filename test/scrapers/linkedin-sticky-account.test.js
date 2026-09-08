import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CredentialsClient } from '../../src/api/credentials.js';
import { AuthError } from '../../src/core/errors.js';
import { LinkedInRscSession } from '../../src/scrapers/linkedin-rsc/session.js';

// Real HTTP exercises query construction and lease release; the external
// credential API's selection policy is separately tested against its database.
test('LinkedIn retains its chosen account, switches on cooldown, and stays with the replacement', async (t) => {
    const cooling = new Set();
    let previous = 17;
    const requests = [];
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET') {
            requests.push({ preferred: url.searchParams.get('preferred_credential_id'), session: url.searchParams.get('session_id') });
            const preferred = Number(url.searchParams.get('preferred_credential_id'));
            const ids = [15, 17].filter(id => !cooling.has(id));
            const id = ids.includes(preferred) ? preferred : ids.find(id => id !== previous) ?? ids[0];
            if (!id) { res.writeHead(204); res.end(); return; }
            previous = id;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ id, name: `Account ${id}`, platform: 'linkedin', profile_key: `account-${id}`, lease_token: `lease-${requests.length}` }));
        } else { for await (const chunk of req) {} res.setHeader('content-type','application/json'); res.end('{"ok":true}'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const session = new LinkedInRscSession({ apiClient: new CredentialsClient({ apiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' }),
        cookieReader: async () => [{ name: 'li_at', value: 'test-cookie' }], metrics: null, heartbeatMs: 0 });
    const use = id => session.withCookies(id, async (_cookies, lease) => lease.credential.id);
    const selected = [await use('one'), await use('two')];
    cooling.add(15);
    selected.push(await use('three'));
    cooling.delete(15);
    selected.push(await use('four'));
    cooling.add(15); cooling.add(17);
    await assert.rejects(use('five'), error => error.skipNoCreds === true);
    assert.deepEqual(selected, [15, 15, 17, 17]);
    assert.deepEqual(requests.map(r => r.preferred), [null, '15', '15', '17', '17']);
    assert.deepEqual(requests.map(r => r.session), ['one','two','three','four','five']);
});

test('overlapping LinkedIn calls cannot acquire another account before the first lease is released', async () => {
    let acquired = 0;
    let finishFirst;
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    const gate = new Promise(resolve => { finishFirst = resolve; });
    const events = [];
    const session = new LinkedInRscSession({
        apiClient: { isLocal: false, acquire: async () => {
            const id = ++acquired; events.push(`acquire-${id}`);
            return { credential: { id }, release: async () => { events.push(`release-${id}`); } };
        } },
        cookieReader: async () => [{ name: 'li_at', value: 'test-cookie' }], metrics: null, heartbeatMs: 0,
    });
    const first = session.withCookies('first', async () => { firstStarted(); await gate; throw new Error('first failed'); });
    const caught = first.catch(error => error.message);
    await started;
    const second = session.withCookies('second', async () => 'second completed');
    await new Promise(resolve => setImmediate(resolve));
    const beforeRelease = acquired;
    finishFirst();
    assert.deepEqual(await Promise.all([caught,second]), ['first failed','second completed']);
    assert.equal(beforeRelease, 1, 'only one account may be acquired while another is active');
    assert.deepEqual(events, ['acquire-1','release-1','acquire-2','release-2']);
});


test('queued LinkedIn work waits for the failed account report before selecting its backup', async () => {
    let finishReport;
    let reportStarted;
    const reporting = new Promise(resolve => { reportStarted = resolve; });
    const gate = new Promise(resolve => { finishReport = resolve; });
    let failed = false;
    const selected = [];
    const session = new LinkedInRscSession({
        apiClient: { isLocal: false, acquire: async () => {
            const id = failed ? 17 : 15;
            selected.push(id);
            return {
                credential: { id, profile_key: `account-${id}` },
                reportFailure: async () => { reportStarted(); await gate; failed = true; },
                release: async () => {},
            };
        } },
        cookieReader: async () => [{ name: 'li_at', value: 'test-cookie' }],
        metrics: null, heartbeatMs: 0,
    });
    const first = session.withCookies('first', async () => {
        throw new AuthError('session expired', { platform: 'linkedin' });
    });
    const rejection = assert.rejects(first, AuthError);
    await reporting;
    const second = session.withCookies('second', async (_cookies, lease) => lease.credential.id);
    await new Promise(resolve => setImmediate(resolve));
    const beforeReport = [...selected];
    finishReport();
    await rejection;
    assert.equal(await second, 17);
    assert.deepEqual(beforeReport, [15]);
    assert.deepEqual(selected, [15, 17]);
});
