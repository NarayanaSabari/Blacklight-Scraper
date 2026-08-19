// Control panel routes: the HTML page + its JSON API.
//
// Mounted under /panel by server.js, immediately after registerScrapeQueueRoute.
// Every route here (including the page itself) sits behind panelAccessGuard —
// see src/panel/guard.js for why that matters on a host bound to 0.0.0.0.

import { createLogger } from '../logger/index.js';
import { panelAccessGuard } from './guard.js';
import { buildStatus } from './status.js';
import { renderPage } from './page.js';
import { UnknownPlatformError } from './overrides.js';
import { activeSessions } from './session-guard.js';

const log = createLogger('panel:router');

// Error codes the LinkedInLoginController throws, and the HTTP status each
// maps to. Anything else falls through to a 500.
const LOGIN_ERROR_STATUS = Object.freeze({
    LOGIN_IN_PROGRESS: 409,
    SESSION_IN_FLIGHT: 409,
    NO_FREE_SEAT: 409,
    NOT_AWAITING: 409,
});

function sendJson(res, status, body) {
    res.status(status).json(body);
}

function sendLoginError(res, error, fallbackLogMessage) {
    const status = LOGIN_ERROR_STATUS[error.code];
    if (status) {
        return sendJson(res, status, { success: false, error: error.message });
    }
    log.error(fallbackLogMessage, { err: error.message });
    return sendJson(res, 500, { success: false, error: error.message });
}

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {import('../queue/orchestrator.js').QueueOrchestrator|null} deps.orchestrator
 * @param {object} deps.bootInfo
 * @param {() => object} deps.getLinkedInSession
 * @param {{snapshot: () => object}} deps.licensePool
 * @param {{snapshot: () => object}} deps.proxyPool
 * @param {(now?: Date) => object} deps.cooldownSnapshot
 * @param {() => Promise<object>} deps.spoolStats
 * @param {import('./overrides.js').PlatformOverrides} deps.overrides
 * @param {{list: () => Array}} deps.recent
 * @param {() => Promise<void>} deps.requestRestart - the SAME graceful shutdown server.js wires to SIGINT/SIGTERM
 * @param {import('./linkedin-login-controller.js').LinkedInLoginController} deps.loginController
 * @param {() => object} [deps.quotaStatus] - live LinkedIn search-quota state
 */
export function registerPanelRoutes(app, deps) {
    const statusDeps = () => ({
        bootInfo: deps.bootInfo,
        getLinkedInSession: deps.getLinkedInSession,
        orchestrator: deps.orchestrator,
        licensePool: deps.licensePool,
        proxyPool: deps.proxyPool,
        cooldownSnapshot: deps.cooldownSnapshot,
        spoolStats: deps.spoolStats,
        overrides: deps.overrides,
        recent: deps.recent,
        loginController: deps.loginController,
        quotaStatus: deps.quotaStatus,
    });

    app.get('/panel', panelAccessGuard, (_req, res) => {
        res.type('html').send(renderPage());
    });

    app.get('/panel/api/status', panelAccessGuard, async (_req, res) => {
        try {
            const status = await buildStatus(statusDeps());
            sendJson(res, 200, status);
        } catch (error) {
            log.error('Failed to build panel status', { err: error.message });
            sendJson(res, 500, { success: false, error: error.message });
        }
    });

    app.post('/panel/api/poll', panelAccessGuard, async (_req, res) => {
        if (!deps.orchestrator) {
            return sendJson(res, 503, { success: false, error: 'Blacklight API not configured on this host.' });
        }
        if (deps.orchestrator.mutex.isLocked) {
            return sendJson(res, 409, { success: false, error: 'A queue cycle is already in progress.' });
        }
        try {
            const result = await deps.orchestrator.runOnce();
            if (result.skipped) {
                return sendJson(res, 409, { success: false, error: 'A queue cycle is already in progress.' });
            }
            return sendJson(res, 200, { success: true, result });
        } catch (error) {
            log.error('Manual poll failed', { err: error.message });
            return sendJson(res, 500, { success: false, error: error.message });
        }
    });

    app.post('/panel/api/platform/:name/pause', panelAccessGuard, (req, res) => {
        try {
            const paused = deps.overrides.pause(req.params.name);
            return sendJson(res, 200, { success: true, paused });
        } catch (error) {
            if (error instanceof UnknownPlatformError) {
                return sendJson(res, 404, { success: false, error: error.message });
            }
            log.error('Failed to pause platform', { platform: req.params.name, err: error.message });
            return sendJson(res, 500, { success: false, error: error.message });
        }
    });

    app.post('/panel/api/platform/:name/resume', panelAccessGuard, (req, res) => {
        try {
            const paused = deps.overrides.resume(req.params.name);
            return sendJson(res, 200, { success: true, paused });
        } catch (error) {
            if (error instanceof UnknownPlatformError) {
                return sendJson(res, 404, { success: false, error: error.message });
            }
            log.error('Failed to resume platform', { platform: req.params.name, err: error.message });
            return sendJson(res, 500, { success: false, error: error.message });
        }
    });

    // Sweep cadence: how often a platform may start a fresh pass over the
    // queue. Body: { minutes: number } — 0/null clears it back to "every
    // cycle". Lives here so retuning Indeed's hourly sweep needs no deploy.
    app.post('/panel/api/platform/:name/interval', panelAccessGuard, (req, res) => {
        try {
            const raw = req.body?.minutes;
            if (raw !== null && raw !== undefined && raw !== 0 && !Number.isFinite(Number(raw))) {
                return sendJson(res, 400, { success: false, error: 'minutes must be a number, 0, or null' });
            }
            const intervals = deps.overrides.setInterval(req.params.name, raw);
            log.info('Sweep interval changed', { platform: req.params.name, minutes: raw });
            return sendJson(res, 200, { success: true, intervals });
        } catch (error) {
            if (error instanceof UnknownPlatformError) {
                return sendJson(res, 404, { success: false, error: error.message });
            }
            log.error('Failed to set sweep interval', { platform: req.params.name, err: error.message });
            return sendJson(res, 500, { success: false, error: error.message });
        }
    });

    app.post('/panel/api/restart', panelAccessGuard, (req, res) => {
        const force = req.body?.force === true;
        const sessions = activeSessions(deps.orchestrator);
        if (sessions.length > 0 && !force) {
            return sendJson(res, 409, {
                success: false,
                error: `${sessions.length} session(s) in flight — pass {"force": true} to restart anyway.`,
                activeSessions: sessions,
            });
        }
        // Respond BEFORE initiating shutdown — the caller's connection must
        // not hang waiting for a response the process is about to exit
        // without ever finishing (server.close() happens inside shutdown).
        sendJson(res, 200, { success: true, message: 'Restart initiated.' });
        log.info('Restart requested via control panel', { force });
        Promise.resolve(deps.requestRestart()).catch((error) => {
            log.error('Panel-initiated restart failed', { err: error.message });
        });
    });

    // The two-step LinkedIn login flow — see src/panel/linkedin-login-controller.js
    // for why this replaced the old fire-and-forget child_process spawn.
    app.post('/panel/api/linkedin/login/start', panelAccessGuard, async (req, res) => {
        const profileKey = req.body?.profileKey ? String(req.body.profileKey) : null;
        const proxy = req.body?.proxy ? String(req.body.proxy) : null;
        try {
            const result = await deps.loginController.start({ profileKey, proxy });
            return sendJson(res, 200, { success: true, ...result });
        } catch (error) {
            return sendLoginError(res, error, 'Failed to start LinkedIn login');
        }
    });

    app.post('/panel/api/linkedin/login/complete', panelAccessGuard, async (_req, res) => {
        try {
            const result = await deps.loginController.complete();
            return sendJson(res, 200, { success: true, ...result });
        } catch (error) {
            return sendLoginError(res, error, 'Failed to complete LinkedIn login');
        }
    });

    app.post('/panel/api/linkedin/login/cancel', panelAccessGuard, async (_req, res) => {
        try {
            const result = await deps.loginController.cancel();
            return sendJson(res, 200, { success: true, ...result });
        } catch (error) {
            return sendLoginError(res, error, 'Failed to cancel LinkedIn login');
        }
    });
}
