// Process-exit codes. Wired into server.js shutdown so supervisors
// (launchctl, NSSM, pm2) can distinguish recoverable from fatal exits.
//   0  signal        clean SIGINT/SIGTERM; supervisors should restart per policy
//   2  auth-dead     LinkedIn session unrecoverable (cookies dead, no fallback) — page humans
//   3  lease-starved scraper credential pool empty for N consecutive polls — back off, retry later
//   42 crash         uncaught exception / unhandled rejection — supervisor restart
//   1  unknown       any other reason; treat as crash by default

export const EXIT_REASONS = Object.freeze({
    SIGNAL: 'signal',
    AUTH_DEAD: 'auth-dead',
    LEASE_STARVED: 'lease-starved',
    CRASH: 'crash',
});

const CODES = Object.freeze({
    [EXIT_REASONS.SIGNAL]: 0,
    [EXIT_REASONS.AUTH_DEAD]: 2,
    [EXIT_REASONS.LEASE_STARVED]: 3,
    [EXIT_REASONS.CRASH]: 42,
});

export function exitCodeFor(reason) {
    return Object.prototype.hasOwnProperty.call(CODES, reason) ? CODES[reason] : 1;
}
