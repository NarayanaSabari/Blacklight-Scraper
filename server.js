// Unified Job Scraper API — HTTP entry point.
//
// Everything of substance lives under src/:
//   - src/config         environment + credentials loading
//   - src/logger         structured logging (+ Loki side-sink)
//   - src/metrics        prom-client registry, Pushgateway push, heartbeat
//   - src/http           retrying fetch client
//   - src/api            Blacklight + Credentials API clients
//   - src/core           shared helpers, error types, browser lifecycle
//   - src/scrapers       platform scraper registry
//   - src/queue          queue orchestrator + mutex
//   - src/routes         Express route handlers
//   - src/validation     zod request schemas
//
// This file only: loads config, builds the orchestrator, wires routes,
// starts telemetry, starts listening, and handles graceful shutdown.

import express from 'express';
import { getConfig } from './src/config/env.js';
import { createLogger, attachLokiSink, attachMetricsSink } from './src/logger/index.js';
import { initializeCredentialsClient, getCredentialsClient } from './src/api/credentials.js';
import { getLinkedInSession } from './src/scrapers/linkedin-session.js';
import { QueueOrchestrator } from './src/queue/orchestrator.js';
import { getMetrics } from './src/metrics/registry.js';
import { getPusher } from './src/metrics/push.js';
import { Heartbeat } from './src/metrics/heartbeat.js';
import { initializeLokiTransport } from './src/logger/loki-transport.js';
import { resolveBootInfo } from './src/config/boot-info.js';
import { linkedInProfileDir } from './scrapers/linkedin.js';
import { registerHealthRoute } from './src/routes/health.js';
import { registerScrapeRoute } from './src/routes/scrape.js';
import { registerScrapeQueueRoute } from './src/routes/scrape-queue.js';
import { registerMetricsRoute } from './src/routes/metrics.js';

const log = createLogger('server');

function buildOrchestrator(config) {
    if (!config.blacklight) {
        log.warn('Blacklight API not configured — /scrape-queue and auto checker disabled');
        return null;
    }
    return new QueueOrchestrator({
        blacklightConfig: config.blacklight,
        queueConfig: config.queue,
        defaultLocation: config.queue.defaultLocation,
    });
}

function bootTelemetry(config) {
    // Registry must exist before the logger emits its first line, otherwise
    // the metrics sink tap would drop counts. Instantiating it eagerly keeps
    // the wiring simple.
    const metrics = getMetrics();
    attachMetricsSink(metrics);

    // Loki — optional; initialize always so attachLokiSink has something to
    // point at, but only start() when telemetry is configured.
    const lokiTransport = initializeLokiTransport({
        baseUrl: config.telemetry.baseUrl,
        apiKey: config.telemetry.apiKey,
        intervalMs: config.telemetry.logsPushIntervalMs,
        batchMax: config.telemetry.logsBatchMax,
        instance: config.telemetry.instance,
        mode: config.telemetry.mode,
    });
    attachLokiSink(lokiTransport);
    lokiTransport.start();

    // Pushgateway push loop (no-op if PUSHGATEWAY_URL is unset).
    const pusher = getPusher();
    pusher.start();

    // Heartbeat — always on, runs purely in-memory.
    const heartbeat = new Heartbeat();
    heartbeat.start();

    return { metrics, lokiTransport, pusher, heartbeat };
}

async function main() {
    if (process.argv.slice(2).includes('--setup')) {
        const { runSetupWizard } = await import('./src/setup/wizard.js');
        process.exit(await runSetupWizard());
    }
    const config = getConfig();

    const bootInfo = resolveBootInfo({ profileDir: () => linkedInProfileDir() });

    log.info('boot', {
        ...bootInfo,
        nodeEnv: config.nodeEnv,
        port: config.port,
        logLevel: config.logLevel,
        instance: config.telemetry.instance,
        mode: config.telemetry.mode,
        telemetryEnabled: Boolean(config.telemetry.baseUrl && config.telemetry.apiKey),
    });

    const telemetry = bootTelemetry(config);
    telemetry.metrics.recordBuildInfo({
        nodeVersion: bootInfo.nodeVersion,
        gitSha: bootInfo.gitSha,
        pkgVersion: bootInfo.pkgVersion,
        headless: bootInfo.headless,
        strict: bootInfo.strict,
    });
    initializeCredentialsClient();
    const orchestrator = buildOrchestrator(config);

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    registerHealthRoute(app, config.port, { bootInfo, getLinkedInSession });
    registerMetricsRoute(app);
    registerScrapeRoute(app);
    registerScrapeQueueRoute(app, orchestrator);

    const server = app.listen(config.port, () => {
        log.info('Server listening', { port: config.port, ...bootInfo });
        if (orchestrator && !config.isDevelopment) {
            orchestrator.startAutoChecker();
        } else if (config.isDevelopment) {
            log.info('Auto queue checker disabled in development mode');
        }
    });

    // Hard-exit budget: regardless of what goes wrong in shutdown, the
    // process WILL exit within SHUTDOWN_BUDGET_MS of receiving the
    // signal. This is the outer safety net — individual stop calls
    // each have their own tighter timeouts below.
    const SHUTDOWN_BUDGET_MS = 8_000;
    const STOP_STEP_TIMEOUT_MS = 2_000;

    // Race `promise` against a timeout, and ALWAYS clear the timer when
    // the race settles so we don't leak a pending setTimeout into the
    // event loop (which would keep the process alive for up to
    // STOP_STEP_TIMEOUT_MS past the last step's completion).
    const withTimeout = (label, promise) => {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`${label} timed out after ${STOP_STEP_TIMEOUT_MS}ms`)),
                STOP_STEP_TIMEOUT_MS,
            );
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;

        // Start the outer budget IMMEDIATELY — whatever happens below,
        // we exit in SHUTDOWN_BUDGET_MS. Must be the first thing so
        // slow awaits can't push us past our SIGKILL grace window.
        setTimeout(() => {
            log.warn('Hard-exit budget exhausted; forcing exit');
            process.exit(0);
        }, SHUTDOWN_BUDGET_MS).unref();

        log.info('Shutdown initiated', { signal, budgetMs: SHUTDOWN_BUDGET_MS });
        orchestrator?.stopAutoChecker();
        telemetry.heartbeat.stop();

        const steps = [
            ['pusher', telemetry.pusher.stop({ finalPush: true })],
            ['loki', telemetry.lokiTransport.stop({ finalFlush: true })],
            // Persistent LinkedIn session: close the warm browser + release
            // its held lease before the catch-all releaseAll() below.
            ['linkedin-session', getLinkedInSession().shutdown()],
            ['credentials', getCredentialsClient().releaseAll()],
        ];
        for (const [label, promise] of steps) {
            try {
                await withTimeout(label, promise);
            } catch (error) {
                log.error(`shutdown step '${label}' failed`, { err: error.message });
            }
        }

        server.close(() => {
            log.info('Server closed');
            process.exit(0);
        });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        log.error('Unhandled promise rejection', { reason: String(reason) });
    });
}

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', error);
    process.exit(1);
});
