// Quick post-setup auth check. Browser/network are injected so the
// decision logic is unit-testable; the live path reuses cloakbrowser.
const LOGIN_RE = /\/login|\/uas\/login|\/checkpoint|\/authwall|session_redirect/;

export function classifyLinkedinUrl(url) {
    const u = String(url || '');
    if (LOGIN_RE.test(u)) return 'login';
    if (/linkedin\.com\/(feed|in\/|mynetwork|jobs|search\/results)/.test(u)) return 'authed';
    return 'unknown';
}

// Mirrors scrapers/linkedin.js loadCookies sameSite + expiry policy
// (no passthrough; '' = session). See scrapers/linkedin.js lines 56-89.
export function cookieToPlaywright(c) {
    // sameSite: only lowercase keys map to Playwright values; everything else
    // (including already-capitalised 'None'/'Strict'/'Lax', 'unspecified',
    // missing) falls back to 'Lax'. Mirrors scrapers/linkedin.js:86-89.
    const s = c.sameSite;
    const sameSite = s === 'no_restriction' ? 'None'
        : s === 'strict' ? 'Strict'
        : s === 'lax' ? 'Lax'
        : 'Lax';
    const out = {
        name: c.name, value: c.value, domain: c.domain,
        path: c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite,
    };
    // expiry: mirrors scrapers/linkedin.js::parseExpiry (lines 56-66).
    // null/undefined/'' → omit; number → floor; numeric string (>0) → floor;
    // ISO string → Date.parse()/1000 floored; anything else → omit.
    const raw = c.expirationDate;
    let exp;
    if (raw === null || raw === undefined || raw === '') {
        exp = undefined;
    } else if (typeof raw === 'number' && isFinite(raw)) {
        exp = Math.floor(raw);
    } else if (typeof raw === 'string') {
        const asNum = Number(raw);
        if (isFinite(asNum) && asNum > 0) {
            exp = Math.floor(asNum);
        } else {
            const ms = Date.parse(raw);
            if (!isNaN(ms)) exp = Math.floor(ms / 1000);
        }
    }
    if (exp !== undefined) out.expires = exp;
    return out;
}

export async function verifyLocal({ launch, cookies, headless, timeoutMs = 30000 }) {
    let browser;
    try {
        browser = await launch({ headless: !!headless, humanize: true });
        const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York' });
        const mapped = (cookies || []).map(cookieToPlaywright);
        try { await context.addCookies(mapped); }
        catch { for (const c of mapped) { try { await context.addCookies([c]); } catch { /* skip */ } } }
        const page = await context.newPage();
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const cls = classifyLinkedinUrl(page.url());
        if (cls === 'authed') return { status: 'ok', message: '✅ LinkedIn cookies valid — ready. Run: npm start' };
        return { status: 'bad', message: '❌ LinkedIn cookies invalid/expired — re-run `npm run setup` with a fresh cookie export.' };
    } catch (e) {
        return { status: 'warn', message: `⚠️ Could not verify (browser/network): ${String(e.message).split('\n')[0]}. Config written; try \`npm start\`.` };
    } finally {
        if (browser) { try { await browser.close(); } catch { /* noop */ } }
    }
}

export async function verifyRemote({ fetchFn, blacklight, scraperCredentials }) {
    const hit = async (label, base, apiKey, p) => {
        const r = await fetchFn(`${String(base).replace(/\/$/, '')}${p}`, { headers: { 'X-Scraper-API-Key': apiKey } });
        return { label, status: r.status };
    };
    try {
        const a = await hit('credentials', scraperCredentials.apiUrl, scraperCredentials.apiKey, '/api/scraper-credentials/queue/availability');
        const b = await hit('blacklight', blacklight.apiUrl, blacklight.apiKey, '/api/scraper/queue/current-session');
        const denied = [a, b].find((x) => x.status === 401 || x.status === 403);
        if (denied) return { status: 'bad', message: `❌ ${denied.label} API rejected the key (${denied.status}) — check the apiKey.` };
        return { status: 'ok', message: '✅ APIs reachable & key accepted — ready. Run: npm start' };
    } catch (e) {
        return { status: 'warn', message: `⚠️ Could not reach an API (${String(e.message).split('\n')[0]}); config written.` };
    }
}
