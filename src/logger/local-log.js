// Daily host-local logs for SSH analysis. No automatic retention deletion.
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

export class LocalLogSink {
    constructor({
        directory = process.env.SCRAPER_LOG_DIR || path.join('results', 'logs'),
        now = () => new Date(),
        onError = (error) => console.error(`[local-log] Cannot persist logs: ${error.message}; retrying in 60 seconds`),
    } = {}) {
        this.directory = directory;
        this.now = now;
        this.onError = onError;
        this.fd = null;
        this.day = null;
        this.retryAt = 0;
        this.closed = false;
    }

    enqueue(level, scope, line) {
        if (this.closed) return;
        const now = this.now();
        if (now.getTime() < this.retryAt) return;
        try {
            const day = now.toISOString().slice(0, 10);
            if (day !== this.day || this.fd === null) {
                this.#closeFile();
                mkdirSync(this.directory, { recursive: true, mode: 0o700 });
                this.fd = openSync(path.join(this.directory, `${day}.jsonl`), 'a', 0o600);
                this.day = day;
            }
            // The caller passes its already-masked line. Synchronous writes
            // avoid an unbounded queue and persist each log before returning.
            const bytes = Buffer.from(JSON.stringify({ timestamp: now.toISOString(), level, scope, line }) + '\n');
            let offset = 0;
            while (offset < bytes.length) {
                const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
                if (written === 0) throw new Error('Log write made no progress');
                offset += written;
            }
        } catch (error) {
            try { this.#closeFile(); } catch { /* original failure is reported below */ }
            this.retryAt = now.getTime() + 60_000;
            try { this.onError(error); } catch { /* logging must not stop scraping */ }
        }
    }

    #closeFile() {
        const fd = this.fd;
        this.fd = null;
        if (fd !== null) {
            try { fsyncSync(fd); } finally { closeSync(fd); }
        }
    }

    close() {
        this.closed = true;
        try { this.#closeFile(); }
        catch (error) {
            try { this.onError(error); } catch { /* best-effort shutdown */ }
        }
    }
}
