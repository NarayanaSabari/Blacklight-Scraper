// Egress control for the LinkedIn RSC transport.
//
// THE PROBLEM THIS SOLVES
// A LinkedIn session cookie is issued to whatever IP logged in. The login path
// can route through a per-account proxy (linkedin-browser.js threads
// `lease.credential.proxy` into Playwright), but the RSC transport calls plain
// global `fetch`, which always egresses on the host's own IP. An account whose
// cookie was minted on a residential proxy and is then used from a datacenter
// IP is one of the loudest automation signals available to LinkedIn.
//
// Production 2026-08-18 had exactly that split:
//   Link1  proxy set, profile_key EMPTY, cookies from 2026-06-25, 174,834
//          successes, 9 failures, hardest-hit account
//   Link2  no proxy, profile_key set, cookies fresh, far healthier
//
// scripts/linkedin-login.js gates its proxy prompt behind a profile key and
// documents why: "logging in through a proxy IP and then scraping from the
// host IP trips LinkedIn's 'confirm it's you' challenge (login IP != scrape
// IP)". It points at `linkedin-session.js: perAccount = !!profile_key` — a
// module that no longer exists. The RSC rewrite dropped the per-account proxy
// application and the guard was left pointing at nothing, so Link1 has been
// running split-IP ever since.
//
// THE FIX
// Requests carry the credential's proxy through an undici ProxyAgent, so the
// cookie and the request share an IP. Agents are cached per proxy string: a
// new pool per request would defeat connection reuse and make TLS churn its
// own signal.
//
// No proxy on the credential means direct egress, which is correct and
// unchanged for accounts that also logged in direct (Link2).

import { ProxyAgent } from 'undici';
import { createLogger } from '../../logger/index.js';
import { parseProxyLine } from '../../core/proxy-pool.js';

const log = createLogger('linkedin-rsc:egress');

// One agent per proxy string. Keyed by the raw credential value so two
// credentials sharing a proxy share its pool.
const agents = new Map();

/**
 * Build an undici proxy URL from a stored credential proxy value.
 *
 * Pool proxies are stored "host:port:user:pass" (the format ISP providers like
 * Decodo hand out, and what `parseProxyLine` already understands). A full URL
 * (`http://user:pass@host:port`) is passed through as-is.
 *
 * @param {string|null|undefined} proxy
 * @returns {string|null} a proxy URL, or null for direct egress
 */
export function proxyUrlFor(proxy) {
    const raw = String(proxy ?? '').trim();
    if (!raw) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
    const rec = parseProxyLine(raw);
    if (!rec) return null;
    if (!rec.username) return rec.server;
    // Credentials belong in the URL userinfo for undici's ProxyAgent. They are
    // encoded because ISP passwords routinely contain ':' and '@'.
    const user = encodeURIComponent(rec.username);
    const pass = encodeURIComponent(rec.password ?? '');
    return rec.server.replace('://', `://${user}:${pass}@`);
}

/**
 * Cached ProxyAgent for a credential's proxy, or null for direct egress.
 * @param {string|null|undefined} proxy
 */
export function agentFor(proxy, { factory = (url) => new ProxyAgent(url) } = {}) {
    const url = proxyUrlFor(proxy);
    if (!url) return null;
    if (!agents.has(url)) {
        // A malformed proxy value must not take the scrape down with it.
        // parseProxyLine accepts anything with a numeric port, so a typo like
        // `host:99999:u:p` produces a syntactically fine string that
        // `new ProxyAgent()` rejects as an Invalid URL — thrown from inside the
        // scrape, after the credential is leased, turning a config typo into a
        // failed session and a platform marked failed.
        //
        // Falling back to direct egress is the right degradation: the account
        // keeps working, and the operator gets a loud log line naming the
        // credential rather than a mystery crash.
        let agent;
        try {
            agent = factory(url);
        } catch (error) {
            log.error('Credential proxy is unusable — falling back to direct egress', {
                proxy: redactProxy(proxy),
                err: error?.message,
                scraper_alert: 'linkedin_proxy_invalid',
            });
            return null;
        }
        agents.set(url, agent);
        // The URL carries credentials, so only the host is ever logged.
        let host = 'unknown';
        try { host = new URL(url).host; } catch { /* keep 'unknown' */ }
        log.info('LinkedIn egress bound to credential proxy', { host });
    }
    return agents.get(url);
}

// host:port only — never the user or password, which share the same string in
// BOTH supported forms:
//   host:port:user:pass        (pool format)
//   scheme://user:pass@host:port  (URL format)
// Stripping only the scheme left "u:p@host" for the URL form, which defeats
// the point; the userinfo segment has to go too.
export function redactProxy(proxy) {
    const raw = String(proxy ?? '').trim();
    if (!raw) return '(none)';
    const noScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const noUserinfo = noScheme.slice(noScheme.lastIndexOf('@') + 1);
    const [host, port] = noUserinfo.split(':');
    return port ? `${host}:${port}` : host;
}

/**
 * A `fetch` bound to a credential's egress path.
 *
 * Returns global fetch untouched when the credential has no proxy, so the
 * direct path stays byte-identical to before this module existed.
 *
 * @param {{proxy?: string|null}|null|undefined} credential
 */
export function fetchForCredential(credential, { baseFetch = fetch, ...opts } = {}) {
    // A proxy is only honoured when the credential ALSO carries a profile_key.
    //
    // This mirrors the login path exactly, and the asymmetry is not cosmetic:
    // openLoginBrowser() sends a keyed account to launchPersistentProfile()
    // (which applies `proxy`) and an UNKEYED one to the legacy launcher, which
    // takes no proxy argument at all. So a credential with a proxy but no
    // profile_key — production's Link1 — authenticated DIRECT, whatever its
    // proxy column says.
    //
    // Honouring the column here would therefore create the very mismatch this
    // module exists to remove, only mirrored: a cookie minted on the host IP,
    // replayed through Decodo. Egress follows where the cookie was actually
    // minted, and the profile_key is the only honest record of that.
    //
    // Fixing Link1 means giving it a profile_key and re-logging in, so the
    // cookie is minted through the proxy it will then scrape through. Until
    // that happens this correctly leaves it direct.
    const usesProxy = Boolean(credential?.profile_key) && Boolean(credential?.proxy);
    const agent = usesProxy ? agentFor(credential.proxy, opts) : null;
    if (!agent) return baseFetch;
    return (url, init = {}) => baseFetch(url, { ...init, dispatcher: agent });
}

/** Test seam: drop cached agents. */
export function __resetEgressAgentsForTest() {
    agents.clear();
}
