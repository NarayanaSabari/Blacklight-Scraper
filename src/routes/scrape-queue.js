// POST /scrape-queue — Blacklight queue orchestration entry point.
// The heavy lifting lives in QueueOrchestrator; this route is a thin adapter.

import { createLogger } from '../logger/index.js';

const log = createLogger('route:scrape-queue');

export function registerScrapeQueueRoute(app, orchestrator) {
    app.post('/scrape-queue', async (_req, res) => {
        if (!orchestrator) {
            return res.status(503).json({
                success: false,
                error: 'Blacklight API not configured — set blacklight section in credentials.json',
            });
        }

        try {
            log.info('Received queue run request');
            const result = await orchestrator.runOnce();

            if (result.skipped) {
                return res.status(202).json({
                    success: true,
                    message: 'Queue run already in progress; skipped',
                });
            }
            if (result.error) {
                return res.status(409).json({ success: false, error: result.error });
            }
            if (result.message) {
                return res.status(200).json({ success: true, message: result.message });
            }
            return res.json({ success: true, message: 'Blacklight queue workflow completed', results: result });
        } catch (error) {
            log.error('Queue run failed', { err: error.message });
            return res.status(500).json({ success: false, error: error.message });
        }
    });
}
