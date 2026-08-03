// Fixed-size in-memory ring buffer of recent submitJobs() outcomes, for the
// control panel's "recent submissions" table. Process-local and
// non-persistent by design — a restart clearing it is fine, this is a live
// operator view, not an audit log (that's what Loki/Grafana are for).

const CAPACITY = 50;

let buffer = [];

// Record one submitJobs() outcome. Defensive: a bad/missing entry must never
// throw into the submit path (see the call site in src/api/blacklight.js),
// so this normalizes rather than validating strictly.
export function record(entry) {
    const normalized = {
        timestamp: new Date().toISOString(),
        platform: entry?.platform != null ? String(entry.platform) : 'unknown',
        sessionId: entry?.sessionId != null ? String(entry.sessionId) : null,
        jobsSent: Number.isFinite(entry?.jobsSent) ? entry.jobsSent : 0,
        outcome: entry?.outcome != null ? String(entry.outcome) : 'unknown',
        error: entry?.error != null ? String(entry.error) : null,
    };
    buffer.push(normalized);
    if (buffer.length > CAPACITY) buffer = buffer.slice(buffer.length - CAPACITY);
}

// Most recent first — that's the natural reading order for an operator
// glancing at the panel.
export function list() {
    return [...buffer].reverse();
}

export function __resetForTest() {
    buffer = [];
}
