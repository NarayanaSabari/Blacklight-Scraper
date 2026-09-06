// Host-local scheduling and exact-ID overlap. An absent/corrupt state only
// causes extra scraping; it must never make a post disappear.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE_INTERVAL_MS = 30 * 60_000;
const MAX_INTERVAL_MS = 4 * 60 * 60_000;
const RECONCILE_MS = 6 * 60 * 60_000;
const TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_IDS = 20_000;

export class QueryState {
    constructor({ filePath = path.join('config', 'linkedin-query-state.json'), now = () => Date.now() } = {}) {
        this.filePath = filePath;
        this.now = now;
        this.entries = {};
        if (filePath) {
            try {
                const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (saved.version === 1 && saved.entries && typeof saved.entries === 'object') this.entries = saved.entries;
            } catch { /* Start with full coverage when state is unavailable. */ }
        }
    }

    plan(key) {
        const entry = this.entries[key];
        const valid = entry && Array.isArray(entry.ids) && Number.isFinite(entry.updatedAt)
            && this.now() - entry.updatedAt < TTL_MS;
        const reconcile = !valid || !entry.reconciledAt || this.now() - entry.reconciledAt >= RECONCILE_MS;
        const reconcileDueAt = entry?.reconciledAt ? entry.reconciledAt + RECONCILE_MS : Infinity;
        // Once an overdue full walk has been attempted, a partial result waits
        // for its normal retry interval instead of staying immediately due.
        const nextDueAt = valid ? Math.min(entry.nextDueAt || 0,
            entry.updatedAt < reconcileDueAt ? reconcileDueAt : Infinity) : 0;
        return {
            due: this.now() >= nextDueAt,
            nextDueAt,
            reconcile,
            // Reconciliation clears the pagination filter, not our knowledge
            // of which retained post IDs have already contributed to yield.
            knownPostIds: new Set(valid ? entry.ids : []),
            seenPostIds: new Set(valid && !reconcile ? entry.ids : []),
        };
    }

    record(key, { posts, newPosts, requests, reconciled = false }) {
        const now = this.now();
        const previous = this.entries[key];
        const emptyRuns = newPosts > 0 ? 0 : Math.min((previous?.emptyRuns || 0) + 1, 4);
        const interval = Math.min(BASE_INTERVAL_MS * (2 ** emptyRuns), MAX_INTERVAL_MS);
        const ids = new Set(previous?.ids || []);
        for (const post of posts) {
            const id = post.activity_id || post.post_url;
            if (id) { ids.delete(id); ids.add(id); }
        }
        const entries = Object.fromEntries(Object.entries(this.entries).filter(([, value]) => now - value.updatedAt < TTL_MS));
        entries[key] = {
            lowYieldRuns: previous?.lowYieldRuns || 0, feedbackAt: previous?.feedbackAt, imported: previous?.imported || 0,
            ids: [...ids].slice(-MAX_IDS), updatedAt: now, nextDueAt: now + interval, emptyRuns,
            reconciledAt: reconciled ? now : previous?.reconciledAt ?? null,
            runs: (previous?.runs || 0) + 1,
            posts: (previous?.posts || 0) + newPosts,
            requests: (previous?.requests || 0) + requests,
        };
        this.#persist(entries);
        return this.plan(key);
    }

    applyFeedback(key, feedback) {
        const entry = this.entries[key];
        const ranAt = Date.parse(feedback?.last_run_at);
        if (!entry || !Number.isFinite(ranAt) || !Number.isInteger(feedback.last_jobs_found)
            || ranAt <= (entry.feedbackAt ?? -1)) return;
        const lowYieldRuns = feedback.last_jobs_found > 0 ? 0 : Math.min((entry.lowYieldRuns || 0) + 1, 3);
        const explicitInterval = Number(feedback.interval_minutes);
        const interval = explicitInterval > 0 ? explicitInterval * 60_000
            : Math.min(BASE_INTERVAL_MS * (2 ** lowYieldRuns), MAX_INTERVAL_MS);
        this.#persist({ ...this.entries, [key]: { ...entry, feedbackAt: ranAt, lowYieldRuns,
            imported: (entry.imported || 0) + feedback.last_jobs_found,
            nextDueAt: ranAt + interval } });
    }

    #persist(entries) {
        if (this.filePath) {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
            const temporary = `${this.filePath}.${randomUUID()}.tmp`;
            const fd = fs.openSync(temporary, 'wx', 0o600);
            try {
                fs.writeFileSync(fd, JSON.stringify({ version: 1, entries }));
                fs.fsyncSync(fd);
            } finally { fs.closeSync(fd); }
            fs.renameSync(temporary, this.filePath);
        }
        this.entries = entries;
    }

    snapshot() {
        const entries = Object.values(this.entries);
        return {
            queries: entries.length,
            runs: entries.reduce((n, entry) => n + entry.runs, 0),
            importedJobs: entries.reduce((n, entry) => n + (entry.imported || 0), 0),
            newPosts: entries.reduce((n, entry) => n + entry.posts, 0),
            requests: entries.reduce((n, entry) => n + entry.requests, 0),
            deferredQueries: Object.keys(this.entries).filter((key) => !this.plan(key).due).length,
        };
    }
}

let state;
export function getQueryState() {
    state ??= new QueryState();
    return state;
}
