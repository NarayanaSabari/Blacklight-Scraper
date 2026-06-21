// Aggregates the per-platform local cooldown markers (Cloudflare/DataDome
// back-off) so the orchestrator can exclude a cooled-down platform from the
// claim — instead of claiming work that instant-fails at scrape time and
// churns 0-result sessions. Prod 2026-06-14: with Glassdoor (cloudflare) +
// Monster (datadome) both on local cooldown, the orchestrator kept claiming
// them and burned ~185 zero-result sessions/min.

import * as monster from './monster-cooldown.js';
import * as indeed from './indeed-cooldown.js';
import * as glassdoor from './glassdoor-cooldown.js';
import * as techfetch from './techfetch-cooldown.js';
import * as linkedin from './linkedin-cooldown.js';

// Platform name → its cooldown module. Only platforms with a cooldown marker
// appear here; others (dice) are never cooled-down. LinkedIn cools down on
// auth/cookie-expiry (set in scrapers/linkedin.js) so the orchestrator stops
// claiming it while the session is dead, instead of storming concurrent
// re-establish failures until the operator re-runs `npm run linkedin:login`.
const MODULES = Object.freeze({ monster, indeed, glassdoor, techfetch, linkedin });

// Returns the platform names whose local cooldown marker is currently active.
// Each check is isolated — a cooldown-read failure must never break the claim.
export function platformsOnCooldown(now = new Date(), modules = MODULES) {
    const cooled = [];
    for (const [platform, mod] of Object.entries(modules)) {
        try {
            const marker = mod.readCooldownMarker({
                readFile: mod.defaultReadFile(),
                now,
                path: mod.cooldownPath(),
            });
            if (mod.isOnCooldown(marker, now)) cooled.push(platform);
        } catch { /* never let a cooldown check break the claim cycle */ }
    }
    return cooled;
}
