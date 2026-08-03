// Aggregates live process state into one JSON payload for the control panel.
//
// Every read here is a PURE READ — no side effects, nothing here mutates
// pool/queue/cooldown state. That matters because this runs on every
// GET /panel/api/status poll (every 3s per connected browser tab), so it has
// to be cheap and safe to call from anywhere.
//
// All dependencies are injected (buildStatus(deps)) rather than imported as
// singletons, so it's unit-testable without a live process, a real
// CloakBrowser pool, or disk I/O beyond what deps.spoolStats chooses to do.

import { existsSync } from 'node:fs';
import { PLATFORM_NAMES } from '../scrapers/registry.js';

// A cooldown that still has this much time left is worth calling out — the
// operator likely needs to intervene (rotate a proxy, wait out a long
// DataDome block) rather than just "it'll clear on its own in a minute".
const LONG_COOLDOWN_ALERT_MS = 20 * 60 * 1000;

function pickLatestSession(activeSessions) {
    if (!Array.isArray(activeSessions) || activeSessions.length === 0) return null;
    return activeSessions.reduce(
        (latest, s) => (!latest || s.startedAt > latest.startedAt ? s : latest),
        null,
    );
}

/**
 * @param {object} deps
 * @param {object} deps.bootInfo - from src/config/boot-info.js
 * @param {() => object} [deps.getLinkedInSession] - () => LinkedInRscSession-shaped { isAlive(), lease }
 * @param {import('../queue/orchestrator.js').QueueOrchestrator|null} deps.orchestrator
 * @param {{snapshot: () => object}} deps.licensePool
 * @param {{snapshot: () => object}} deps.proxyPool
 * @param {(now?: Date) => object} deps.cooldownSnapshot
 * @param {() => Promise<{count:number, recent:number, oldest:string|null,
 *   newest:string|null, deliveryFailingNow:boolean, backlog:boolean}>} deps.spoolStats
 * @param {import('./overrides.js').PlatformOverrides} deps.overrides
 * @param {{list: () => Array}} deps.recent
 * @param {import('./linkedin-login-controller.js').LinkedInLoginController} [deps.loginController]
 * @param {() => Date} [deps.now]
 * @returns {Promise<object>}
 */
export async function buildStatus(deps) {
    const {
        bootInfo = {},
        getLinkedInSession,
        orchestrator = null,
        licensePool,
        proxyPool,
        cooldownSnapshot,
        spoolStats,
        overrides,
        recent,
        loginController,
        now = () => new Date(),
    } = deps;

    const identity = {
        instance: bootInfo.instance ?? null,
        gitSha: bootInfo.gitSha ?? 'unknown',
        pkgVersion: bootInfo.pkgVersion ?? '0.0.0',
        nodeVersion: bootInfo.nodeVersion ?? process.version,
        pid: bootInfo.pid ?? process.pid,
        bootedAt: bootInfo.bootedAt ?? null,
        uptimeSec: Math.round(process.uptime()),
        headless: !!bootInfo.headless,
        strict: !!bootInfo.strict,
        // The REAL allowlist is a server-side property of this host's
        // scraper API key (platform_allowlist) — not visible locally. This
        // is the full set of platforms this build of the code can run.
        knownPlatforms: [...PLATFORM_NAMES],
    };

    const orchestratorSnapshot = orchestrator ? orchestrator.snapshot() : null;
    const poll = {
        enabled: !!orchestrator,
        running: orchestratorSnapshot?.running ?? false,
        lastPollAt: orchestratorSnapshot?.lastPollAt ?? null,
        lastPollOutcome: orchestratorSnapshot?.lastPollOutcome ?? null,
        secondsUntilNextTick: orchestratorSnapshot?.secondsUntilNextTick ?? null,
        mutexLocked: orchestratorSnapshot?.mutexLocked ?? false,
    };

    const session = pickLatestSession(orchestratorSnapshot?.activeSessions);

    const licenses = licensePool?.snapshot?.() ?? { total: 0, leased: 0, free: 0, waiting: 0, leasedKeys: [] };
    const proxies = proxyPool?.snapshot?.() ?? { total: 0, leased: 0, cooling: [] };
    const cooldowns = cooldownSnapshot ? cooldownSnapshot(now()) : {};

    const linkedInSession = getLinkedInSession ? getLinkedInSession() : null;
    const sessionAlive = !!linkedInSession?.isAlive?.();
    const profileDir = bootInfo.profileDir ?? null;
    const profileDirExists = !!(profileDir && profileDir !== 'unknown' && existsSync(profileDir));
    // `login` is the two-step control-panel flow's OWN state (see
    // linkedin-login-controller.js) — distinct from sessionAlive/profileDir
    // above, which describe the credential the scraper is currently using at
    // RUNTIME. They can legitimately point at different profile dirs when a
    // per-account profileKey is used for login.
    const login = loginController ? loginController.status() : {
        state: 'idle', profileKey: null, profileDir: null, startedAt: null, lastVerdict: null, lastError: null,
    };
    const linkedin = {
        sessionAlive,
        profileDir,
        profileDirExists,
        needsRelogin: profileDirExists && !sessionAlive,
        login,
    };

    const spool = spoolStats
        ? await spoolStats()
        : { count: 0, recent: 0, oldest: null, newest: null, deliveryFailingNow: false, backlog: false };

    const recentSubmissions = recent ? recent.list() : [];
    const pausedPlatforms = overrides ? overrides.pausedList() : [];

    const alerts = [];
    if (linkedin.needsRelogin) {
        alerts.push({ level: 'error', message: 'LinkedIn needs re-login — profile exists but the session is not alive.' });
    }
    // Two DIFFERENT conditions, deliberately not merged into "spool is non-empty".
    // That single test is why the panel warned "backend delivery is failing" for
    // 34 hours (2026-08-01 → 08-03) while Indeed submissions were being accepted:
    // the spool had a stale backlog and nothing drains it. An always-on alarm is
    // an ignored alarm, and it hid the real problem.
    if (spool.deliveryFailingNow) {
        alerts.push({
            level: 'error',
            message: `${spool.recent} submission(s) failed to deliver in the last 15 min — backend delivery is failing NOW.`,
        });
    }
    if (spool.backlog) {
        alerts.push({
            level: 'warn',
            message: `${spool.count} spooled submission(s) awaiting replay (oldest ${spool.oldest}) — run drain_scraper_spool.py.`,
        });
    }
    // `free === 0` alone is NORMAL — it just means every seat is doing real work.
    // The 2026-08-03 deadlock signature was zero free seats WITH callers queued,
    // sustained, so requiring `waiting > 0` is what makes this alert mean something.
    if (licenses.total > 0 && licenses.free === 0 && licenses.waiting > 0) {
        alerts.push({
            level: 'warn',
            message: `No free CloakBrowser seats and ${licenses.waiting} launch(es) queued — seats may be leaking.`,
        });
    }
    if (poll.enabled && !poll.running) {
        alerts.push({ level: 'error', message: 'Auto queue checker is not running — this host is not polling for work.' });
    }
    if (login.state === 'awaiting_operator') {
        alerts.push({ level: 'warn', message: 'LinkedIn login is open and waiting for you to log in, then click "capture".' });
    }
    if (login.state === 'failed' && login.lastVerdict && !login.lastVerdict.ok) {
        alerts.push({
            level: 'error',
            message: `LinkedIn login validation failed (${login.lastVerdict.reason || 'unknown reason'}) — the profile is still dead.`,
        });
    }
    const nowMs = now().getTime();
    for (const [platform, state] of Object.entries(cooldowns)) {
        if (!state.onCooldown || !state.until) continue;
        const remainingMs = new Date(state.until).getTime() - nowMs;
        if (remainingMs > LONG_COOLDOWN_ALERT_MS) {
            const minutes = Math.round(remainingMs / 60000);
            alerts.push({ level: 'warn', message: `${platform} is on cooldown for ~${minutes} more minute(s).` });
        }
    }

    return {
        identity,
        poll,
        session,
        licenses,
        proxies,
        cooldowns,
        linkedin,
        spool,
        recentSubmissions,
        pausedPlatforms,
        alerts,
    };
}
