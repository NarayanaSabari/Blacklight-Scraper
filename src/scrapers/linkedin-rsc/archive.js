// Immutable scrape evidence, separate from deliverable jobs and cookie profiles.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeArchiveRecord } from '../../core/record-archive.js';

export class ScrapeArchive {
    constructor({ directory = process.env.LINKEDIN_ARCHIVE_DIR || path.join('results', 'linkedin-archive') } = {}) {
        this.directory = directory;
        this._stats = null;
        this._statsAt = 0;
    }

    async save({ sessionId, keywords, location, datePosted, posts = [], jobs = [], pages = [], outcome, candidateScoped, budgetExhausted }) {
        return writeArchiveRecord(this.directory, {
            version: 1, archivedAt: new Date().toISOString(), sessionId,
            keywords, location, datePosted, posts, jobs, pages, outcome,
            candidateScoped: Boolean(candidateScoped), budgetExhausted: Boolean(budgetExhausted),
        });
    }

    async stats() {
        if (this._stats && Date.now() - this._statsAt < 60_000) return this._stats;
        let names;
        try { names = await readdir(this.directory); }
        catch (error) {
            if (error.code === 'ENOENT') return { count: 0, bytes: 0 };
            throw error;
        }
        let bytes = 0;
        let count = 0;
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            bytes += (await stat(path.join(this.directory, name))).size;
            count++;
        }
        this._stats = { count, bytes };
        this._statsAt = Date.now();
        return this._stats;
    }
}

let archive;
export function getScrapeArchive() {
    archive ??= new ScrapeArchive();
    return archive;
}
