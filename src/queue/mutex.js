// Single-slot mutex for the Blacklight queue worker.
// Replaces the old `isProcessingQueue` boolean flag, which had a TOCTOU
// race when the auto-checker fired while another invocation was already
// mid-flight.
//
// Usage:
//   const mutex = new Mutex();
//   if (!mutex.tryAcquire()) return;      // already running — skip
//   try { await runJob(); }
//   finally { mutex.release(); }

export class Mutex {
    constructor() {
        this.locked = false;
    }

    tryAcquire() {
        if (this.locked) return false;
        this.locked = true;
        return true;
    }

    release() {
        this.locked = false;
    }

    get isLocked() {
        return this.locked;
    }
}
