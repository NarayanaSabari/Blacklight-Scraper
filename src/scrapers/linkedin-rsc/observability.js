// Safe, bounded runtime diagnostics for LinkedIn RSC.
//
// This module deliberately exposes only correlation and aggregate fields. Never
// add request bodies, URLs, cookie values, headers, proxy configuration, or raw
// search terms here: these diagnostics run continuously in production.

import { createHash } from 'node:crypto';

export function querySha256(query) {
    return createHash('sha256').update(String(query ?? ''), 'utf8').digest('hex');
}

function numericCredentialId(lease) {
    const raw = lease?.credential?.id ?? lease?.id ?? null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
    return null;
}

export function leaseCorrelation({ sessionId = null, lease = null }) {
    return {
        sessionId: sessionId ?? null,
        credentialId: numericCredentialId(lease),
    };
}

export function scrapeCorrelation({ sessionId = null, lease = null, query, datePosted, candidateScoped }) {
    return {
        ...leaseCorrelation({ sessionId, lease }),
        querySha256: querySha256(query),
        datePosted: datePosted ?? null,
        candidateScoped: Boolean(candidateScoped),
    };
}

// Error messages frequently contain response snippets, request URLs, or
// provider details. Keep runtime diagnostics classifiable without emitting them.
export function safeErrorDetails(error) {
    const status = error?.statusCode ?? error?.status ?? null;
    return {
        errorType: error?.name ?? 'Error',
        errorCode: error?.code ?? null,
        httpStatus: Number.isInteger(status) ? status : null,
    };
}
