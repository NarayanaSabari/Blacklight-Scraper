// Shared setup I/O primitives, used by both the full `npm run setup` wizard
// and the `npm start` first-run API-key preflight. Extracted so the EOF-safe
// masked-readline prompt and the atomic 0600 secret-writer have ONE
// implementation (they guard real secrets — two copies is how they drift).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

// Real readline wrapper. Two hardening properties beyond a bare question():
//  (1) EOF-safe: on Ctrl-D / closed stdin, rl.question() never settles, so
//      we race it against the interface 'close' event and resolve null.
//      Callers treat null as "cancel — write nothing".
//  (2) .secret(q): masks keystroke echo for API keys / passwords.
export function defaultAsk() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    let muted = false;
    const onClose = new Promise((resolve) => rl.once('close', () => { closed = true; resolve(null); }));
    const origWrite = typeof rl._writeToOutput === 'function' ? rl._writeToOutput.bind(rl) : null;
    if (origWrite) {
        rl._writeToOutput = (s) => { if (!muted) origWrite(s); else if (/\n/.test(s)) origWrite('\n'); };
    }
    const core = async (q) => {
        if (closed) return null;
        try {
            return await Promise.race([rl.question(q + ' ').then((a) => a.trim()), onClose]);
        } catch (e) {
            if (e && e.code === 'ERR_USE_AFTER_CLOSE') return null;
            throw e;
        }
    };
    const fn = async (q) => core(q);
    fn.secret = async (q) => {
        process.stdout.write(q + ' ');
        muted = true;
        try { return await core(''); } finally { muted = false; }
    };
    fn.close = () => rl.close();
    return fn;
}

// git check-ignore: true = ignored, false = NOT ignored, null = unknown
// (no git / not a repo). Callers decide policy per null.
export function realIsIgnored(p) {
    try { execFileSync('git', ['check-ignore', '-q', p], { stdio: 'ignore' }); return true; }
    catch (e) { return e.status === 1 ? false : null; } // 1 = not ignored; other/no-git = null (unknown)
}

// Write a secret file atomically (temp + rename) and lock it to 0600.
// Never silently degrade: if chmod fails on a POSIX host, warn loudly via `out`.
export function writeSecret(p, data, out = () => {}) {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, data);
    try {
        fs.chmodSync(tmp, 0o600);
    } catch (e) {
        if (process.platform !== 'win32') {
            out(`⚠️ Could not chmod ${path.basename(p)} to 0600 (${e.code || e.message}); secrets may be world-readable — fix the file permissions manually.`);
        }
    }
    fs.renameSync(tmp, p);
}
