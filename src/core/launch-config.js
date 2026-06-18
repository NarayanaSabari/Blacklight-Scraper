// Browser launch tuning shared by the anti-bot-gated scrapers.
//
// headless:true is a strong Cloudflare/DataDome detection signal — running
// headful (a real visible Chromium) is a well-documented evasion lever. We keep
// the default headless (true) so nothing changes unless opted in, but expose a
// SCRAPER_HEADLESS=false / 0 toggle so we can A/B headful on the tough sites
// (and flip prod without a code change if it measurably helps).
//
// NOTE: headful needs a display/desktop session on the host (the prod box has
// one; CI/headless servers would need xvfb).
export function scraperHeadless(env = process.env) {
    const raw = env?.SCRAPER_HEADLESS;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
    return true; // default: headless (unchanged)
}

// Shared CloakBrowser launch() options for the anti-bot-gated scrapers. Bundles
// the research-backed evasion levers so every scraper gets them consistently:
//   • headless toggle (SCRAPER_HEADLESS)
//   • geoip: match timezone+locale to the proxy exit AND spoof the WebRTC IP to
//     it (CloakBrowser resolves --fingerprint-webrtc-ip via geoip → closes the
//     #1-overlooked WebRTC real-IP leak). Needs mmdb-lib (installed).
//   • timezone/locale as TOP-LEVEL binary flags (undetectable) — explicit
//     US-East matches our US residential proxies; geoip still resolves exit IP
//     for WebRTC even with explicit values.
//   • humanize: human-like mouse/keyboard/scroll.
// Pass the per-scrape proxy in; omit for direct.
export function stealthLaunchOptions({ proxy = null, timezone = 'America/New_York', locale = 'en-US', humanize = true } = {}, env = process.env) {
    return {
        headless: scraperHeadless(env),
        geoip: true,
        timezone,
        locale,
        humanize,
        ...(proxy ? { proxy } : {}),
    };
}
