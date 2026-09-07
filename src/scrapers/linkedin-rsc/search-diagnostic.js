import { AuthError, BlockedError } from '../../core/errors.js';
import { createLogger } from '../../logger/index.js';
import { accountKey } from './search-quota.js';
import { diagnosticPages } from './response-evidence.js';

const log = createLogger('linkedin-rsc:diagnostic');

// A control probe shares the lease, egress and pacing of the requested search.
// Only small, explicitly selected evidence is logged; never headers or cookies.
export async function diagnoseSearch({ tracker, session, lease, template, cookies,
    paginateImpl, fetchImpl, pacer, archive, sessionId, metrics, trigger, observedError }) {
    const keywords = observedError ? null : tracker.nextProbeQuery();
    const account = accountKey(lease);
    let probe;
    let outcome;
    let authError;
    let probeError;
    let authVerified = false;
    let templateFresh = null;
    try {
        if (observedError) throw observedError;
        await pacer?.pace?.(lease);
        probe = await paginateImpl({ template, cookies, keywords,
            datePosted: 'past-24h', count: 10, maxPosts: 10, maxPages: 1,
            timeBudgetMs: 30_000, fetchImpl });
        if (probe.posts.length > 0) {
            outcome = 'healthy';
            session.noteSearchServed?.(lease);
        } else if (!probe.emptyConfirmed) {
            outcome = 'response_unknown';
        } else {
            authVerified = typeof session.verifySearchSession === 'function'
                && await session.verifySearchSession({ cookies, template, fetchImpl }) === true;
            if (!authVerified) {
                outcome = 'session_unknown';
            } else {
                // A matching client version proves freshness, not working search.
                templateFresh = typeof session.isRequestHealthy === 'function'
                    ? await session.isRequestHealthy({ strict: true, fetchImpl }) === true : null;
                outcome = templateFresh === true ? 'empty' : 'request_unhealthy';
            }
        }
    } catch (error) {
        probeError = error;
        if (error instanceof AuthError) {
            outcome = error.code === 'NEEDS_TEMPLATE' ? 'request_unhealthy' : 'auth_failed';
            authError = error;
        } else if (error instanceof BlockedError && error.kind === 'rate_limit') {
            outcome = 'rate_limited';
        } else {
            outcome = 'network_unknown';
        }
    }
    const decision = tracker.finishRecovery(outcome);
    const pages = diagnosticPages(probe?.pages ?? probeError?.pages);
    const evidence = { account, trigger, outcome, keywords,
        posts: probe?.posts?.length ?? 0, emptyConfirmed: probe?.emptyConfirmed === true,
        searchVerified: (probe?.posts?.length ?? 0) > 0, authVerified,
        templateFresh, templateCheck: 'freshness_only',
        responses: pages.flatMap((page) => page.response ? [page.response] : []),
        cooldownMs: decision.tripped ? decision.pauseMs : 0,
        nextRetryAt: tracker.snapshot().nextRetryAt,
        corroboratingEmpties: tracker.snapshot().corroboratingEmpties };
    log.info('LinkedIn search diagnostic', evidence);
    try { metrics?.recordLinkedInSearch?.('recovery', outcome, probe?.pages?.length ?? 0, probe?.posts?.length ?? 0, 0); }
    catch { /* telemetry must not interfere with auth or cooldown reporting */ }
    // Retain evidence before a remote credential report can release the lease.
    let archiveError;
    try {
        await archive?.save({ sessionId, keywords, datePosted: 'past-24h',
            posts: probe?.rawPosts ?? probe?.posts ?? [], pages,
            outcome: `diagnostic_${outcome}`, diagnostic: evidence });
    } catch (error) {
        archiveError = error;
        log.error('Failed to retain search diagnostic', { account, outcome });
    }
    if (decision.tripped) {
        try { metrics?.recordLinkedInQuotaPause?.(decision.pauseMs); } catch { /* best effort */ }
        try {
            const report = await lease?.reportFailure?.(`LinkedIn search unavailable: ${outcome}; account diagnostic`, decision.pauseMs / 60_000);
            if (report?.ok === false) log.warn('Account cooldown report rejected; local gate remains active', { account });
        } catch {
            log.warn('Account cooldown report failed; local diagnostic gate remains active', { account });
        }
    }
    // The session owner already handles invalidation and auth-dead reporting.
    if (authError) throw authError;
    if (archiveError) throw archiveError;
    return { ...decision, served: outcome === 'healthy' };
}
