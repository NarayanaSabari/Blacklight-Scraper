// Resolves the immutable boot identity for this process. Pure given its deps.
// Used by server.js to stamp every boot log, by /healthz to surface state,
// and by scraper_build_info to label metrics by SHA.

import { execSync as realExecSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function defaultReadPkg(cwd = process.cwd()) {
    return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
}

// NB: this module deliberately does NOT import from scrapers/linkedin.js.
// Callers (server.js) inject `profileDir: () => linkedInProfileDir()`.
// The default is a sentinel so unit tests don't need a real profile path.

export function resolveBootInfo(deps = {}) {
    const env = deps.env ?? process.env;
    const execSync = deps.execSync ?? realExecSync;
    const readPkg = deps.readPkg ?? defaultReadPkg;
    const profileDir = deps.profileDir ?? (() => 'unknown');
    const now = deps.now ?? (() => new Date());
    const nodeVersion = deps.nodeVersion ?? process.version;
    const pid = deps.pid ?? process.pid;

    let gitSha;
    if (env.GIT_SHA) {
        gitSha = String(env.GIT_SHA).trim();
    } else {
        try {
            const out = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] });
            gitSha = String(out).trim();
        } catch {
            gitSha = 'unknown';
        }
    }

    let pkgVersion = '0.0.0';
    try { pkgVersion = readPkg().version || pkgVersion; } catch { /* keep default */ }

    return {
        pid,
        gitSha,
        bootedAt: now().toISOString(),
        nodeVersion,
        pkgVersion,
        profileDir: profileDir(),
        headless: env.LINKEDIN_HEADLESS === 'true',
        strict: env.SCRAPER_STRICT_EMPTY === 'true',
    };
}
