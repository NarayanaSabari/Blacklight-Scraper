// Minimal async counting semaphore. acquire() resolves with a one-shot
// release function when a slot is free, else queues FIFO. release() frees a
// slot (handing it directly to the next waiter if any) and is idempotent so a
// double-release can't over-grant. No timeouts/cancellation (YAGNI).
export class Semaphore {
    constructor(max) {
        this._max = Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1);
        this._inUse = 0;
        this._queue = [];
    }

    // Slots currently held (running + handed-to-waiter). Lets callers tell
    // whether any borrower is active right now.
    get inUse() { return this._inUse; }

    async acquire() {
        if (this._inUse < this._max) {
            this._inUse++;
            return this.#makeRelease();
        }
        return new Promise((resolve) => {
            this._queue.push(() => resolve(this.#makeRelease()));
        });
    }

    #makeRelease() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = this._queue.shift();
            if (next) {
                next();          // hand the held slot straight to the next waiter
            } else {
                this._inUse--;   // no waiter: free the slot
            }
        };
    }
}
