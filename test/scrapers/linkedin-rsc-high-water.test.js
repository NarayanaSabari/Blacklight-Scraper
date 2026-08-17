import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    HighWaterStore, isNewerThan, newestActivityId, markKey,
} from '../../src/scrapers/linkedin-rsc/high-water.js';

// Real LinkedIn activity ids: 19 digits, well past Number.MAX_SAFE_INTEGER.
// Deliberately one apart — at this magnitude a double's ULP is ~1024, so these
// two distinct posts are indistinguishable as Numbers. That is the exact bug
// BigInt comparison exists to avoid.
const OLD = '7358901234567890123';
const NEW = '7358901234567890124';

function memoryFs(seed = null) {
    const files = new Map();
    if (seed) files.set('marks.json', seed);
    return {
        files,
        readFileSync(p) {
            if (!files.has(p)) {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            }
            return files.get(p);
        },
        writeFileSync(p, data) { files.set(p, data); },
        mkdirSync() { /* no-op */ },
    };
}

function store(opts = {}) {
    return new HighWaterStore({ filePath: 'marks.json', fs: memoryFs(opts.seed), now: opts.now, ...opts.rest });
}

test('activity ids compare as BigInt, not Number', () => {
    // The whole feature rests on this. Number() rounds 19-digit ids, making
    // distinct recent posts compare equal and silently dropping new results.
    assert.equal(Number(OLD) === Number(NEW), true, 'precondition: Number() cannot tell these apart');
    assert.equal(isNewerThan(NEW, OLD), true);
    assert.equal(isNewerThan(OLD, NEW), false);
});

test('no mark means everything is new', () => {
    assert.equal(isNewerThan(OLD, null), true);
});

test('a post equal to the mark is not new', () => {
    assert.equal(isNewerThan(OLD, OLD), false);
});

test('a missing id is never treated as new', () => {
    assert.equal(isNewerThan(null, OLD), false);
});

test('a non-numeric id fails toward scraping, not skipping', () => {
    assert.equal(isNewerThan('not-an-id', OLD), true);
});

test('newestActivityId picks the max, not the last', () => {
    assert.equal(newestActivityId([OLD, NEW, OLD]), NEW);
    assert.equal(newestActivityId([]), null);
});

test('datePosted is part of the key so widening the window re-runs full', () => {
    assert.notEqual(markKey('java', 'past-24h'), markKey('java', 'past-week'));
});

test('advance then get round-trips', () => {
    const s = store();
    assert.equal(s.get('java', 'past-24h'), null);
    s.advance('java', 'past-24h', OLD);
    assert.equal(s.get('java', 'past-24h'), OLD);
});

test('a mark never moves backward', () => {
    // A partial or out-of-order run must not re-open covered ground, or every
    // later sweep re-forwards the same posts.
    const s = store();
    s.advance('java', 'past-24h', NEW);
    s.advance('java', 'past-24h', OLD);
    assert.equal(s.get('java', 'past-24h'), NEW);
});

test('marks are scoped per query', () => {
    const s = store();
    s.advance('java', 'past-24h', NEW);
    assert.equal(s.get('python', 'past-24h'), null);
});

test('marks persist across instances', () => {
    const fs = memoryFs();
    new HighWaterStore({ filePath: 'marks.json', fs }).advance('java', 'past-24h', NEW);
    const reopened = new HighWaterStore({ filePath: 'marks.json', fs });
    assert.equal(reopened.get('java', 'past-24h'), NEW);
});

test('a corrupt file degrades to empty rather than throwing', () => {
    // One full pass is an acceptable cost; refusing to scrape is not.
    const s = new HighWaterStore({ filePath: 'marks.json', fs: memoryFs('{not json') });
    assert.equal(s.get('java', 'past-24h'), null);
    assert.doesNotThrow(() => s.advance('java', 'past-24h', NEW));
});

test('an unwritable file does not break the scrape', () => {
    const fs = memoryFs();
    fs.writeFileSync = () => { throw new Error('EACCES'); };
    const s = new HighWaterStore({ filePath: 'marks.json', fs });
    assert.doesNotThrow(() => s.advance('java', 'past-24h', NEW));
});

test('marks past their TTL are ignored and pruned', () => {
    let clock = 1_000_000_000_000;
    const fs = memoryFs();
    const s = new HighWaterStore({ filePath: 'marks.json', fs, now: () => clock, ttlMs: 1000 });
    s.advance('java', 'past-24h', NEW);
    assert.equal(s.get('java', 'past-24h'), NEW);

    clock += 5000;
    assert.equal(s.get('java', 'past-24h'), null, 'expired mark must not gate a scrape');

    s.advance('python', 'past-24h', NEW);
    assert.equal(s.size(), 1, 'the expired entry is pruned on write');
});
