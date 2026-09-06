import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInRscSession } from '../../src/scrapers/linkedin-rsc/session.js';
import { AuthError } from '../../src/core/errors.js';

const template = { headers: {}, postData: '{}' };
const cookies = [{ name: 'li_at', value: 'test-session' }, { name: 'JSESSIONID', value: '"ajax:test"' }];
const session = () => new LinkedInRscSession({ apiClient: {}, templateHealth: null });

test('strict request health cannot turn a missing checker into proof of validity', async () => {
    assert.equal(await session().isRequestHealthy({ strict: true }), false);
});

test('strict request health cannot turn an unknown live version into proof of validity', async () => {
    const s = new LinkedInRscSession({ apiClient: {}, templateLoader: () => template,
        templateHealth: { fetchLiveClientVersion: async () => null } });
    assert.equal(await s.isRequestHealthy({ strict: true }), false);
});

test('session diagnostic requires authenticated identity in the response', async () => {
    const s = session();
    const calls = [];
    const healthy = await s.verifySearchSession({ template, cookies,
        fetchImpl: async (url, args) => {
            calls.push({ url, args });
            return { status: 200, json: async () => ({ miniProfile: { entityUrn: 'urn:li:fs_miniProfile:test' } }) };
        } });
    assert.equal(healthy, true);
    assert.equal(calls[0].url, 'https://www.linkedin.com/voyager/api/me');
    assert.equal(calls[0].args.redirect, 'manual', 'never forward session credentials to a redirect');
    assert.equal(await s.verifySearchSession({ template, cookies,
        fetchImpl: async () => ({ status: 200, json: async () => ({}) }) }), false);
});

test('an explicit auth rejection uses AuthError instead of search quota', async () => {
    await assert.rejects(session().verifySearchSession({ template, cookies,
        fetchImpl: async () => ({ status: 401 }) }), AuthError);
});

test('strict template health requires a comparable captured version', async () => {
    const { assessTemplate } = await import('../../src/scrapers/linkedin-rsc/template-health.js');
    const s = new LinkedInRscSession({ apiClient: {}, templateLoader: () => template,
        templateHealth: { assessTemplate, fetchLiveClientVersion: async () => '0.2.7139' } });
    assert.equal(await s.isRequestHealthy({ strict: true }), false);
});
