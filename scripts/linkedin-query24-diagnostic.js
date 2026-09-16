#!/usr/bin/env node
// One bounded, production-path probe for a single candidate query.
//
// WHY THIS EXISTS
// query24 ("Senior .NET Developer" … past-24h) returns zero in production while
// a local headed run of the same boolean extracted 15 unique posts. The three
// causes that wear a zero-result shape — a stale template, LinkedIn refusing a
// repeated search, an account/platform refusal — are indistinguishable from
// inside a normal sweep. This runs the EXACT production transport for ONE page
// of ONE query and reports the observable facts, so the cause can be settled
// with evidence rather than guessed.
//
// SAFETY (what this deliberately does and does not do)
//   • Bootstraps getConfig() and the REMOTE credential client FIRST, then fails
//     closed if the host is not in REMOTE mode — a LOCAL fallback would read a
//     base profile that isn't the production account and report a phantom
//     NEEDS_RELOGIN (the flaw in the previous version of this script).
//   • Uses the normal lease (withCookies → heartbeat → release), the real
//     per-credential pacer, and credential-bound egress. Every guard the daemon
//     relies on stays in place.
//   • Bounded to ONE page via paginate({ maxPages: 1 }) — it drives the real
//     paginate() with an explicit page cap, so the candidate 2000-page default
//     never applies and no global behaviour changes.
//   • Never submits jobs, never advances a high-water mark, never runs the ban
//     canary or the quota back-off (a single bounded page is not evidence for
//     either), and never re-logs in.
//   • Logs an ALLOWLIST of non-secret facts only: query sha, date, credential
//     numeric id / profile key / profile-dir existence, stage, HTTP status,
//     body bytes, extracted count, the no-results marker, the template's
//     non-secret build/age, and a stop reason. Never cookies, headers, payload,
//     or an exception's message.
//
//     node scripts/linkedin-query24-diagnostic.js
//     node scripts/linkedin-query24-diagnostic.js --query '<boolean>' --date past-week

import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getConfig } from '../src/config/env.js';
import { initializeCredentialsClient } from '../src/api/credentials.js';
import { getLinkedInRscSession } from '../src/scrapers/linkedin-rsc/session.js';
import { paginate, countPerRequest } from '../src/scrapers/linkedin-rsc/client.js';
import { fetchForCredential } from '../src/scrapers/linkedin-rsc/egress.js';
import { getRequestPacer } from '../src/scrapers/linkedin-rsc/pacer.js';
import { profileDirFor } from '../src/core/linkedin-profile.js';
import { AuthError, NetworkError, BlockedError } from '../src/core/errors.js';

// The recruiter-authored query under investigation. Sent EXACTLY as written.
export const QUERY24 = '("Senior .NET Developer" OR ".NET Full Stack Developer" '
    + 'OR ".NET Developer" OR "Full Stack Developer") AND (".NET Core" OR ASP.NET)';

// Matches client.js: the date filter every sweep uses.
export const DEFAULT_DATE_POSTED = 'past-24h';

// A short, stable fingerprint of the query. Lets two runs be compared in the
// log without ever printing the boolean itself into a shared channel.
export function queryFingerprint(query) {
    return createHash('sha256').update(String(query ?? '')).digest('hex').slice(0, 12);
}

// Non-secret credential facts. `id` is the backend's only guaranteed-unique
// field; profile_key is nullable. Neither is a secret. The profile directory's
// EXISTENCE is reported, never its contents.
export function describeCredential(credential, { existsSync = fs.existsSync } = {}) {
    const profileKey = credential?.profile_key ?? null;
    let profileDirExists = null;
    try {
        profileDirExists = existsSync(profileDirFor(profileKey));
    } catch {
        profileDirExists = null; // a stat failure is not itself evidence
    }
    return {
        credentialId: credential?.id ?? null,
        profileKey,
        profileDirExists,
    };
}

// Non-secret template facts: the client build LinkedIn versions requests
// against, and when we captured it. Both appear in staleness triage already.
export function describeTemplate(template) {
    return {
        templateBuild: template?.headers?.['x-li-application-version'] ?? null,
        templateCapturedAt: template?.capturedAt ?? null,
    };
}

// Wrap a fetch so the single page's HTTP status and body size can be logged
// without the transport having to surface them. fetchPage() only reads
// `response.status` and `response.text()`, so a thin façade suffices for both
// the real Response and a test fake.
function instrumentFetch(fetchImpl, sink) {
    return async (url, init) => {
        const response = await fetchImpl(url, init);
        sink.httpStatus = response.status ?? null;
        const readText = response.text.bind(response);
        return {
            status: response.status,
            text: async () => {
                const body = await readText();
                // Bytes on the wire, not UTF-16 code units: a multibyte payload
                // (LinkedIn posts carry non-ASCII freely) makes String.length
                // undercount, and body size is a triage signal — a truncated or
                // challenge body is smaller than a real one.
                sink.bodyBytes = typeof body === 'string'
                    ? Buffer.byteLength(body, 'utf8')
                    : null;
                return body;
            },
        };
    };
}

/**
 * Run one bounded, production-path page fetch for a single query and return the
 * observable facts. Every collaborator is injectable so the whole path can be
 * exercised with fakes and fixtures — no live network in tests.
 *
 * @returns {Promise<object>} the same allowlisted summary that is logged
 */
export async function runLinkedInQueryDiagnostic({
    query = QUERY24,
    datePosted = DEFAULT_DATE_POSTED,
    // Bootstrap seams. Order matters: config THEN the credential client THEN the
    // session, so the session's lazily-built API client sees the loaded config
    // and the REMOTE pool rather than the LOCAL credentials.json fallback.
    getConfigImpl = getConfig,
    initCredentials = initializeCredentialsClient,
    makeSession = getLinkedInRscSession,
    // Transport seams.
    paginateImpl = paginate,
    fetchForCredentialImpl = fetchForCredential,
    count = countPerRequest(),
    // Null → the real process-wide pacer (only when the session is the default).
    pacer = undefined,
    newSessionId = randomUUID,
    now = () => Date.now(),
    log = defaultLog,
} = {}) {
    const startedAt = new Date(now()).toISOString();
    const sha = queryFingerprint(query);
    const base = { kind: 'linkedin-query24-diagnostic', querySha: sha, datePosted, startedAt };

    // 1) Load config from disk (.env + credentials.json) BEFORE anything reads
    //    it. Skipping this is what made the prior version resolve the base
    //    profile and report a phantom NEEDS_RELOGIN.
    getConfigImpl();

    // 2) Select the credential source, then FAIL CLOSED unless it is REMOTE.
    //    A LOCAL client would lease a credentials.json account whose on-disk
    //    profile is not the production session under investigation.
    const client = initCredentials();
    if (client?.isLocal !== false) {
        log({ ...base, stage: 'bootstrap', stopReason: 'not_remote_mode' });
        const err = new Error(
            'Refusing to run: credential client is not in REMOTE mode '
            + '(configure config/credentials.json blacklight/scraperCredentials)',
        );
        err.code = 'NOT_REMOTE';
        throw err;
    }
    log({ ...base, stage: 'bootstrap', remoteMode: true });

    // 3) Now build the session (its API client is the REMOTE one selected above)
    //    and run the normal lease lifecycle. withCookies owns acquire, the lease
    //    heartbeat, the auth-failure report, and release — all preserved.
    const session = makeSession();
    const sessionId = newSessionId();
    // Default to the real process-wide pacer ONLY on the production path. The
    // seam is `makeSession`, checked by reference so an injected fake never
    // triggers a real getLinkedInRscSession() singleton (which a `session ===
    // getLinkedInRscSession()` comparison would). A caller may still force a
    // pacer explicitly, including null to disable pacing.
    const activePacer = pacer !== undefined
        ? pacer
        : (makeSession === getLinkedInRscSession ? getRequestPacer() : null);

    return session.withCookies(sessionId, async (cookies, lease) => {
        const cred = describeCredential(lease?.credential);
        log({ ...base, stage: 'lease', sessionIdIsUuid: isUuid(sessionId), ...cred });

        // Real per-credential pacing, inside the lease, exactly as a sweep does.
        await activePacer?.pace?.(lease);

        // Real template (freshness check runs its normal path), and real
        // credential-bound egress so the cookie and the request share an IP.
        const template = await session.template();
        const boundFetch = fetchForCredentialImpl(lease?.credential);
        const page = {};
        const fetchImpl = instrumentFetch(boundFetch, page);

        // ONE bounded page. maxPages:1 is the seam that overrides the candidate
        // default without touching global behaviour; sinceActivityId:null so no
        // high-water mark is read or written.
        const result = await paginateImpl({
            template,
            cookies,
            keywords: query,
            datePosted,
            maxPosts: count,
            count,
            maxPages: 1,
            sinceActivityId: null,
            fetchImpl,
        });

        const summary = {
            ...base,
            stage: 'page',
            ...cred,
            ...describeTemplate(template),
            httpStatus: page.httpStatus ?? null,
            bodyBytes: page.bodyBytes ?? null,
            requests: result.pages?.length ?? 0,
            extracted: result.posts?.length ?? 0,
            noResultMarker: Boolean(result.emptyConfirmed),
            upToDate: Boolean(result.upToDate),
            stopReason: stopReasonFor(result),
        };
        log(summary);
        return summary;
    });
}

// A single bounded page can only end one of three honest ways.
function stopReasonFor(result) {
    if (Boolean(result?.emptyConfirmed)) return 'no_results_marker';
    if ((result?.posts?.length ?? 0) > 0) return 'page_cap_reached';
    return 'empty_unconfirmed';
}

function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ''));
}

// Default sink: one JSON line per stage on stdout. Only ever receives the
// allowlisted objects assembled above — no secrets pass through here.
function defaultLog(record) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
}

// Non-secret error shape. An exception's message can echo a request, so only
// its class/code and any numeric HTTP status are surfaced.
export function describeError(error) {
    let errorKind = error?.name ?? 'Error';
    if (error instanceof AuthError) errorKind = 'AuthError';
    else if (error instanceof BlockedError) errorKind = 'BlockedError';
    else if (error instanceof NetworkError) errorKind = 'NetworkError';
    return {
        errorKind,
        errorCode: error?.code ?? null,
        statusCode: error?.statusCode ?? null,
    };
}

function parseArgs(argv) {
    const out = { query: QUERY24, datePosted: DEFAULT_DATE_POSTED };
    for (let i = 0; i < argv.length; i += 1) {
        if ((argv[i] === '--query' || argv[i] === '-q') && argv[i + 1]) out.query = argv[++i];
        else if ((argv[i] === '--date' || argv[i] === '-d') && argv[i + 1]) out.datePosted = argv[++i];
    }
    return out;
}

async function main() {
    const { query, datePosted } = parseArgs(process.argv.slice(2));
    try {
        await runLinkedInQueryDiagnostic({ query, datePosted });
    } catch (error) {
        defaultLog({
            kind: 'linkedin-query24-diagnostic',
            stage: 'error',
            querySha: queryFingerprint(query),
            datePosted,
            ...describeError(error),
        });
        process.exitCode = 1;
    }
}

// True when this module is the process entrypoint. Compared as file:// URLs so
// a Windows path (C:\…, spaces) matches: a literal `file://${argv[1]}` string
// mangles the drive letter and backslashes and would silently never run main.
export function isMainEntrypoint(argv = process.argv, moduleUrl = import.meta.url) {
    const entry = argv?.[1];
    if (!entry) return false;
    try {
        return moduleUrl === pathToFileURL(path.resolve(entry)).href;
    } catch {
        return false;
    }
}

// Only run when invoked directly, so the module can be imported by tests.
if (isMainEntrypoint()) {
    main();
}
