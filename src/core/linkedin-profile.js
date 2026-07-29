// Pure helpers for LinkedIn persistent-profile paths and CloakBrowser
// fingerprint pinning. Extracted from scrapers/linkedin.js so callers that need
// only these (the RSC transport, boot-info, the login/reset scripts) do not pull
// in the browser packages. scrapers/linkedin.js re-exports them, so existing
// import sites are unchanged.

import os from 'os';
import path from 'path';

// On-disk persistent stealth profile directory. The operator logs in ONCE
// via `npm run linkedin:login`; the session (cookies, localStorage) lives
// here and rotates organically across runs — no per-run cookie injection.
export function linkedInProfileDir() {
    return process.env.LINKEDIN_PROFILE_DIR
        || path.join(os.homedir(), '.blacklight-linkedin-profile');
}

// Resolve the on-disk persistent-profile directory for a given account.
// Pure + deterministic. A falsy profileKey (null/undefined/'') → the legacy
// single fixed dir (byte-identical to the pre-rotation behavior). A truthy
// profileKey → a sibling per-account dir derived from the base
// (`<base>-<sanitized key>`). The key is sanitized so it can never inject a
// path separator or `..` traversal into the resolved path.
export function profileDirFor(profileKey) {
    const base = linkedInProfileDir();
    if (!profileKey) return base;
    const safe = String(profileKey).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '__');
    return `${base}-${safe}`;
}

// Deterministic CloakBrowser fingerprint seed per account. Same profile_key
// always maps to the same synthetic device, so the one-time login and every
// scrape present an IDENTICAL device to LinkedIn (CloakBrowser otherwise
// randomizes --fingerprint per launch — see config.js:184).
export function fingerprintSeedFor(profileKey) {
    const s = String(profileKey ?? 'default');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 10000 + (h % 90000);
}

// Which OS the fingerprint should present. Default to the HOST OS — macos on a
// Mac, windows elsewhere (mirrors CloakBrowser's own getDefaultStealthArgs). A
// host-matched platform keeps GPU/UA consistent; spoofing windows on Mac
// hardware leaks the real Apple GPU and gets flagged. Since the warm profile is
// machine-local (login + scrape on the SAME host), the host OS is self-consistent.
// Override with LINKEDIN_FINGERPRINT_PLATFORM (macos|windows|linux) if a host
// must spoof a different OS.
export function fingerprintPlatform(env = process.env, platform = process.platform) {
    const override = env?.LINKEDIN_FINGERPRINT_PLATFORM;
    if (override && String(override).trim()) return String(override).trim().toLowerCase();
    return platform === 'darwin' ? 'macos' : 'windows';
}

export function hasLiAt(jar) {
    return Array.isArray(jar) && jar.some(
        c => c && c.name === 'li_at' && typeof c.value === 'string' && c.value.length > 0
    );
}

// Pull the numeric activity id out of any blob containing
// `urn:li:activity:<digits>` (a post element's markup, a data-urn attr, a
// link). Returns '' when absent. Mirrors the in-page extractor regex so the
// contract is unit-tested.
