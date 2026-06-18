// GET /metrics — local Prometheus-format endpoint.
//
// This isn't what Prometheus-on-Hetzner scrapes (that happens via Pushgateway
// pull). It exists so a developer can `curl localhost:3001/metrics` to verify
// counters without needing any remote infrastructure.

import { getMetrics } from '../metrics/registry.js';

export function registerMetricsRoute(app) {
    app.get('/metrics', async (_req, res) => {
        try {
            const metrics = getMetrics();
            const body = await metrics.snapshot();
            res.set('Content-Type', metrics.contentType);
            res.send(body);
        } catch (error) {
            res.status(500).type('text/plain').send(`# metrics snapshot failed: ${error.message}\n`);
        }
    });
}
