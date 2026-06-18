// Proxy-bandwidth saver: abort heavy subresources (images, media, fonts) at the
// network layer so a proxied scrape transfers a fraction of the bytes. We KEEP
// document/script/stylesheet/xhr/fetch/websocket so the JS-rendered job data
// still loads and anti-bot challenges (Cloudflare/DataDome) still run normally —
// only decorative payload is dropped. Applied at BrowserContext level so every
// page/tab in the context inherits it.
//
// NOTE: deliberately NOT wired into LinkedIn — that scraper runs on a logged-in
// persistent profile and is left exactly as-is.
//
// Toggle off entirely with SCRAPER_BLOCK_RESOURCES=0; override the blocked set
// with SCRAPER_BLOCK_RESOURCE_TYPES="image,media,font,stylesheet".

const DEFAULT_BLOCKED = Object.freeze(['image', 'media', 'font']);
const OFF_RE = /^(0|false|no|off)$/i;

export function blockingEnabled(env = process.env) {
    const raw = env?.SCRAPER_BLOCK_RESOURCES;
    if (raw === undefined || raw === null || raw === '') return true; // default ON
    return !OFF_RE.test(String(raw).trim());
}

export function blockedTypes(env = process.env) {
    const raw = env?.SCRAPER_BLOCK_RESOURCE_TYPES;
    if (!raw) return DEFAULT_BLOCKED;
    const types = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return types.length ? types : DEFAULT_BLOCKED;
}

export function shouldBlock(resourceType, env = process.env) {
    if (!blockingEnabled(env)) return false;
    return blockedTypes(env).includes(String(resourceType));
}

// Register the abort route on a Playwright/CloakBrowser BrowserContext (or Page).
// Returns true if a route was installed, false if blocking is disabled or the
// target can't route. Never throws — a routing failure must not break a scrape.
export async function applyResourceBlocking(target, env = process.env) {
    if (!target || typeof target.route !== 'function') return false;
    if (!blockingEnabled(env)) return false;
    const blocked = new Set(blockedTypes(env));
    try {
        await target.route('**/*', (route) => {
            let type;
            try { type = route.request().resourceType(); } catch { type = ''; }
            if (blocked.has(type)) return route.abort().catch(() => {});
            return route.continue().catch(() => {});
        });
        return true;
    } catch {
        return false;
    }
}
