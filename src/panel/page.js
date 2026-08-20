// Server-rendered control panel page. One static HTML string — no build
// step, no template engine, no external assets (the host may have no
// internet egress). All interactivity is inline vanilla JS polling the
// JSON API registered in src/panel/router.js.
//
// escapeHtml is imported from its own module (src/panel/escape-html.js) so
// it is unit-testable from Node, then its literal source is spliced into
// the browser-side SCRIPT below via `escapeHtml.toString()` — there is no
// build step to share a module between server and browser here, so this is
// the one definition of the escaping rule, not a server copy that a client
// copy can drift from. EVERY value interpolated into an innerHTML template
// below must go through it, including values that look local-only
// (profileDir, gitSha, platform names) — several fields are remote,
// attacker-influenced (submission error text, a validation redirect's final
// URL, a queued role name), and reasoning per-field about provenance is
// exactly the kind of judgment call that gets it wrong once.

import { escapeHtml } from './escape-html.js';

const STYLE = `
:root {
    color-scheme: dark;
    --bg: #0f1115;
    --panel: #161922;
    --border: #2a2f3a;
    --text: #e4e7ec;
    --muted: #8b93a3;
    --accent: #4f8cff;
    --ok: #3ecf8e;
    --warn: #e8b339;
    --error: #e8555a;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
header {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
}
header h1 { font-size: 16px; margin: 0; }
header .muted { color: var(--muted); font-size: 12px; }
#alerts { display: flex; flex-direction: column; gap: 6px; padding: 0 20px; margin-top: 12px; }
.alert {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    border: 1px solid transparent;
}
.alert.error { background: rgba(232, 85, 90, 0.12); border-color: var(--error); color: #ffb0b3; }
.alert.warn { background: rgba(232, 179, 57, 0.12); border-color: var(--warn); color: #f2cd7c; }
main {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 14px;
    padding: 16px 20px 40px;
}
section.card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
}
section.card h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 0 0 10px;
}
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; text-align: right; word-break: break-all; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; }
.pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
}
.pill.ok { background: rgba(62, 207, 142, 0.15); color: var(--ok); }
.pill.warn { background: rgba(232, 179, 57, 0.15); color: var(--warn); }
.pill.error { background: rgba(232, 85, 90, 0.15); color: var(--error); }
.pill.muted { background: rgba(139, 147, 163, 0.15); color: var(--muted); }
.platform-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; gap: 8px; }
.platform-row .name { font-family: ui-monospace, monospace; }
button {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
button.danger:hover:not(:disabled) { border-color: var(--error); }
#actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 20px; margin-top: 12px; }
#actionError {
    padding: 0 20px;
    margin-top: 8px;
    color: var(--error);
    font-size: 13px;
    display: none;
}
`;

const SCRIPT = `
${escapeHtml.toString()}
// Every value interpolated into innerHTML below goes through esc(). The rule
// is applied WITHOUT per-field reasoning about provenance — including fields
// that look purely local — so it cannot rot as new fields are added.
const esc = escapeHtml;

const el = (id) => document.getElementById(id);
let inFlight = false;

function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function pill(text, level) {
    return '<span class="pill ' + esc(level) + '">' + esc(text) + '</span>';
}

function showActionError(message) {
    const box = el('actionError');
    box.textContent = message;
    box.style.display = message ? 'block' : 'none';
}

function setButtonsDisabled(disabled) {
    document.querySelectorAll('button[data-action]').forEach((b) => { b.disabled = disabled; });
}

async function callAction(path, opts) {
    if (inFlight) return;
    inFlight = true;
    setButtonsDisabled(true);
    showActionError('');
    try {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts && opts.body || {}),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            showActionError((body && body.error) || (res.status + ' ' + res.statusText));
        }
    } catch (err) {
        showActionError(String(err));
    } finally {
        inFlight = false;
        setButtonsDisabled(false);
        refresh();
    }
}

function renderAlerts(alerts) {
    const box = el('alerts');
    if (!alerts || alerts.length === 0) { box.innerHTML = ''; return; }
    box.innerHTML = alerts.map((a) =>
        '<div class="alert ' + esc(a.level) + '">' + esc(a.message) + '</div>'
    ).join('');
}

function renderIdentity(identity, uptimeSec) {
    el('identity').innerHTML =
        '<dt>Instance</dt><dd>' + esc(identity.instance || '—') + '</dd>' +
        '<dt>Git SHA</dt><dd>' + esc(identity.gitSha) + '</dd>' +
        '<dt>Version</dt><dd>' + esc(identity.pkgVersion) + '</dd>' +
        '<dt>Node</dt><dd>' + esc(identity.nodeVersion) + '</dd>' +
        '<dt>PID</dt><dd>' + esc(identity.pid) + '</dd>' +
        '<dt>Booted</dt><dd>' + esc(fmtDate(identity.bootedAt)) + '</dd>' +
        '<dt>Uptime</dt><dd>' + esc(Math.round(uptimeSec)) + 's</dd>' +
        '<dt>Headless</dt><dd>' + esc(identity.headless) + '</dd>' +
        '<dt>Strict</dt><dd>' + esc(identity.strict) + '</dd>';
}

function renderPoll(poll) {
    el('poll').innerHTML =
        '<dt>Enabled</dt><dd>' + esc(poll.enabled) + '</dd>' +
        '<dt>Running</dt><dd>' + (poll.running ? pill('running', 'ok') : pill('stopped', 'error')) + '</dd>' +
        '<dt>Mutex</dt><dd>' + (poll.mutexLocked ? pill('locked', 'warn') : pill('free', 'ok')) + '</dd>' +
        '<dt>Last poll</dt><dd>' + esc(fmtDate(poll.lastPollAt)) + '</dd>' +
        '<dt>Outcome</dt><dd>' + esc(poll.lastPollOutcome || '—') + '</dd>' +
        '<dt>Next tick</dt><dd>' + (poll.secondsUntilNextTick == null ? '—' : esc(poll.secondsUntilNextTick) + 's') + '</dd>';
}

function renderSession(session) {
    const box = el('session');
    if (!session) { box.innerHTML = '<span class="muted">No session in flight.</span>'; return; }
    const platforms = Object.entries(session.platforms || {}).map(([name, state]) => {
        const level = state === 'success' ? 'ok' : state === 'failed' ? 'error' : 'warn';
        return pill(name + ':' + state, level);
    }).join(' ');
    box.innerHTML =
        '<dt>Session</dt><dd>' + esc(session.sessionId) + '</dd>' +
        '<dt>Role</dt><dd>' + esc(session.role) + '</dd>' +
        '<dt>Started</dt><dd>' + esc(fmtDate(session.startedAt)) + '</dd>' +
        '<dt>Platforms</dt><dd>' + platforms + '</dd>';
}

function renderPlatforms(status) {
    const paused = new Set(status.pausedPlatforms || []);
    const cooldowns = status.cooldowns || {};
    const box = el('platforms');
    box.innerHTML = (status.identity.knownPlatforms || []).map((name) => {
        const isPaused = paused.has(name);
        const cd = cooldowns[name];
        let badge = isPaused ? pill('paused', 'muted') : pill('active', 'ok');
        if (cd && cd.onCooldown) badge += ' ' + pill('cooldown → ' + fmtDate(cd.until), 'warn');
        const action = isPaused
            ? '<button data-action="resume" data-platform="' + esc(name) + '">Resume</button>'
            : '<button data-action="pause" data-platform="' + esc(name) + '">Pause</button>';
        return '<div class="platform-row"><span class="name">' + esc(name) + '</span><span>' + badge + '</span>' + action + '</div>';
    }).join('');
    box.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const platform = btn.dataset.platform;
            const action = btn.dataset.action;
            callAction('/panel/api/platform/' + encodeURIComponent(platform) + '/' + action);
        });
    });
}

function renderLicenses(licenses, proxies) {
    el('licenses').innerHTML =
        '<dt>Seats</dt><dd>' + esc(licenses.total) + '</dd>' +
        '<dt>Leased</dt><dd>' + esc(licenses.leased) + '</dd>' +
        '<dt>Free</dt><dd>' + esc(licenses.free) + '</dd>' +
        '<dt>Waiting</dt><dd>' + esc(licenses.waiting) + '</dd>' +
        '<dt>Leased keys</dt><dd>' + esc((licenses.leasedKeys || []).join(', ')) + '</dd>' +
        '<dt>Proxies</dt><dd>' + esc(proxies.total) + ' total, ' + esc(proxies.leased) + ' assigned</dd>' +
        '<dt>Cooling</dt><dd>' + esc((proxies.cooling || []).map((p) => p.id).join(', ')) + '</dd>';
}

const LOGIN_BUSY_STATES = ['opening', 'awaiting_operator', 'capturing', 'validating'];

function loginStatePill(state) {
    if (LOGIN_BUSY_STATES.indexOf(state) !== -1) return pill(state, 'warn');
    if (state === 'done') return pill(state, 'ok');
    if (state === 'failed') return pill(state, 'error');
    return pill(state, 'muted');
}

function startLinkedInLogin() {
    const profileKey = (window.prompt('Account / profile key (blank = default single profile):', '') || '').trim();
    let proxy = '';
    if (profileKey) {
        proxy = (window.prompt('Proxy host:port:user:pass (blank = direct):', '') || '').trim();
    }
    const body = {};
    if (profileKey) body.profileKey = profileKey;
    if (proxy) body.proxy = proxy;
    callAction('/panel/api/linkedin/login/start', { body });
}

function renderLinkedin(linkedin) {
    const login = linkedin.login || { state: 'idle' };
    const state = login.state || 'idle';
    const busy = LOGIN_BUSY_STATES.indexOf(state) !== -1;

    let verdict = '—';
    if (login.lastVerdict) {
        verdict = login.lastVerdict.ok
            ? pill('validated OK', 'ok')
            : pill('FAILED: ' + (login.lastVerdict.reason || 'unknown reason'), 'error');
    }

    // Template freshness. Three distinct states an operator must be able to
    // tell apart:
    //
    //   1. checked AND healthy (stale: false, liveUnknown: false)
    //      -> green pill, show lag and live version
    //   2. checked but BLIND   (stale: false, liveUnknown: true)
    //      -> amber pill, age is the only guard
    //   3. stale               (stale: true)
    //      -> red pill, re-capture needed
    //   4. never checked yet   (template === null)
    //      -> muted pill
    //
    // State 2 is the one that caused the 2026-08-20 production confusion: it
    // looked identical to state 1 in the old rendering (both showed "fresh").
    let templatePill;
    let templateDetail = '';
    const t = linkedin.template;
    if (!t) {
        templatePill = pill('not yet checked', 'muted');
    } else if (t.stale) {
        templatePill = pill('STALE', 'error');
        templateDetail = esc(t.captured || '?') + ' vs live ' + esc(t.live || '?')
            + ' (' + esc(t.lag != null ? t.lag + ' builds behind' : 'unknown lag') + ')';
    } else if (t.liveUnknown) {
        templatePill = pill('blind — cannot measure', 'warn');
        templateDetail = 'captured ' + esc(t.captured || '?')
            + ', age ' + (t.ageMs != null ? esc(Math.round(t.ageMs / 3_600_000) + 'h') : '?')
            + ' (live version unavailable)';
    } else {
        templatePill = pill('current', 'ok');
        templateDetail = 'captured ' + esc(t.captured || '?')
            + ', live ' + esc(t.live || '?')
            + (t.lag != null ? ', ' + esc(t.lag) + ' builds behind' : '');
    }

    el('linkedin').innerHTML =
        '<dt>Session</dt><dd>' + (linkedin.sessionAlive ? pill('alive', 'ok') : pill('dead', 'error')) + '</dd>' +
        '<dt>Profile dir</dt><dd>' + esc(linkedin.profileDir || '—') + '</dd>' +
        '<dt>Profile exists</dt><dd>' + esc(linkedin.profileDirExists) + '</dd>' +
        '<dt>Needs relogin</dt><dd>' + (linkedin.needsRelogin ? pill('yes', 'error') : pill('no', 'ok')) + '</dd>' +
        '<dt>Login state</dt><dd>' + loginStatePill(state) + '</dd>' +
        '<dt>Login profile</dt><dd>' + esc(login.profileDir || '—') + (login.profileKey ? ' (' + esc(login.profileKey) + ')' : '') + '</dd>' +
        '<dt>Last verdict</dt><dd>' + verdict + '</dd>' +
        '<dt>Last error</dt><dd>' + esc(login.lastError || '—') + '</dd>' +
        '<dt>Template</dt><dd>' + templatePill + (templateDetail ? ' ' + templateDetail : '') + '</dd>' +
        '<dt>Template checked</dt><dd>' + esc(t ? fmtDate(t.checkedAt) : '—') + '</dd>';

    const actions = el('linkedinActions');
    let html = '';
    if (!busy) {
        html += '<button data-action="login-start">Start login</button>';
    } else if (state === 'awaiting_operator') {
        // NB: this whole script is a template literal, so a backslash escape
        // here is consumed at build time and the browser would receive a bare
        // apostrophe that terminates the string — breaking the ENTIRE script.
        // Use the HTML entity so no escaping is involved at either layer.
        html += '<button data-action="login-complete">I&#39;m logged in — capture</button>';
        html += '<button data-action="login-cancel" class="danger">Cancel</button>';
    } else {
        html += '<button disabled>Working… (' + esc(state) + ')</button>';
    }
    actions.innerHTML = html;

    const startBtn = actions.querySelector('[data-action="login-start"]');
    if (startBtn) startBtn.addEventListener('click', startLinkedInLogin);
    const completeBtn = actions.querySelector('[data-action="login-complete"]');
    if (completeBtn) completeBtn.addEventListener('click', () => callAction('/panel/api/linkedin/login/complete'));
    const cancelBtn = actions.querySelector('[data-action="login-cancel"]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => callAction('/panel/api/linkedin/login/cancel'));

    const note = el('linkedinNote');
    if (state === 'done' && login.lastVerdict && login.lastVerdict.ok) {
        note.style.display = 'block';
        note.className = 'alert warn';
        note.textContent = 'Captured + validated locally. This does NOT flip the backend credential — '
            + 'mark it "available" in centralD (Credentials) to put it back in rotation.';
    } else if (state === 'failed') {
        note.style.display = 'block';
        note.className = 'alert error';
        note.textContent = 'Validation failed — the profile is still dead. Start again once you have actually reached the feed.';
    } else {
        note.style.display = 'none';
    }
}

function renderSpool(spool) {
    el('spool').innerHTML =
        '<dt>Count</dt><dd>' + esc(spool.count) + '</dd>' +
        '<dt>Oldest</dt><dd>' + esc(fmtDate(spool.oldest)) + '</dd>';
}

function renderRecent(entries) {
    const rows = (entries || []).map((e) =>
        '<tr><td>' + esc(fmtDate(e.timestamp)) + '</td><td>' + esc(e.platform) + '</td><td>' + esc(e.jobsSent) +
        '</td><td>' + esc(e.outcome) + '</td><td>' + esc(e.error || '') + '</td></tr>'
    ).join('');
    el('recent').innerHTML =
        '<table><thead><tr><th>Time</th><th>Platform</th><th>Jobs</th><th>Outcome</th><th>Error</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="5" class="muted">No submissions yet.</td></tr>') + '</tbody></table>';
}

async function refresh() {
    let status;
    try {
        const res = await fetch('/panel/api/status');
        status = await res.json();
    } catch (err) {
        renderAlerts([{ level: 'error', message: 'Could not reach /panel/api/status: ' + err }]);
        return;
    }
    renderAlerts(status.alerts);
    renderIdentity(status.identity, status.identity.uptimeSec);
    renderPoll(status.poll);
    renderSession(status.session);
    renderPlatforms(status);
    renderLicenses(status.licenses, status.proxies);
    renderLinkedin(status.linkedin);
    renderSpool(status.spool);
    renderRecent(status.recentSubmissions);
}

el('pollBtn').addEventListener('click', () => callAction('/panel/api/poll'));
el('restartBtn').addEventListener('click', () => {
    if (!confirm('Restart this scraper process now?')) return;
    callAction('/panel/api/restart');
});
el('restartForceBtn').addEventListener('click', () => {
    if (!confirm('FORCE restart even with a session in flight? In-flight work will be interrupted.')) return;
    callAction('/panel/api/restart', { body: { force: true } });
});

refresh();
setInterval(refresh, 3000);
`;

export function renderPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scraper Control Panel</title>
<style>${STYLE}</style>
</head>
<body>
<header>
    <h1>Scraper Control Panel</h1>
    <span class="muted">address-allowlisted · polls every 3s</span>
</header>
<div id="alerts"></div>
<div id="actions">
    <button id="pollBtn" data-action="poll">Trigger poll</button>
    <button id="restartBtn" data-action="restart">Restart</button>
    <button id="restartForceBtn" data-action="restart-force" class="danger">Force restart</button>
</div>
<div id="actionError"></div>
<main>
    <section class="card"><h2>Identity</h2><dl class="kv" id="identity"></dl></section>
    <section class="card"><h2>Poll loop</h2><dl class="kv" id="poll"></dl></section>
    <section class="card"><h2>Current session</h2><dl class="kv" id="session"></dl></section>
    <section class="card"><h2>Platforms</h2><div id="platforms"></div></section>
    <section class="card"><h2>Licenses &amp; proxies</h2><dl class="kv" id="licenses"></dl></section>
    <section class="card">
        <h2>LinkedIn</h2>
        <dl class="kv" id="linkedin"></dl>
        <div id="linkedinActions" style="margin-top: 10px; display: flex; gap: 8px;"></div>
        <div id="linkedinNote" style="margin-top: 10px; display: none;"></div>
    </section>
    <section class="card"><h2>Submission spool</h2><dl class="kv" id="spool"></dl></section>
    <section class="card" style="grid-column: 1 / -1;"><h2>Recent submissions</h2><div id="recent"></div></section>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
