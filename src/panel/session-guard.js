// Shared "is a scrape running right now on this host" check. Both
// POST /panel/api/restart and POST /panel/api/linkedin/login/start need the
// exact same answer — a scrape in flight is a reason to refuse each of them
// (restart would kill it; a login would fight it for a CloakBrowser seat) —
// so this is the one place that reads it.
export function activeSessions(orchestrator) {
    return orchestrator?.snapshot?.().activeSessions ?? [];
}
