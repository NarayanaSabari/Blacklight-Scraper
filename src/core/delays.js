// Delay primitives used across scrapers.
// Centralised so jitter/backoff behaviour is consistent.

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function humanDelay(min = 1000, max = 3000) {
    const jittered = Math.floor(Math.random() * (max - min + 1)) + min;
    return wait(jittered);
}

export function randomDelay(min, max) {
    return wait(min + Math.random() * (max - min));
}

// Exponential backoff with jitter. Returns the delay in ms but does NOT sleep.
// attempt is 0-indexed.
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 30_000, factor = 2 } = {}) {
    const raw = Math.min(baseMs * factor ** attempt, maxMs);
    // Full jitter: random in [0, raw]
    return Math.floor(Math.random() * raw);
}

export async function sleepBackoff(attempt, opts) {
    await wait(backoffDelay(attempt, opts));
}
