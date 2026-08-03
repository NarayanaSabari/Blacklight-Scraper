// HTML-escaping for values interpolated into the control panel's markup.
//
// This lives in its own module for two reasons: it is unit-testable from
// `node --test`, and page.js injects its SOURCE into the browser script via
// `escapeHtml.toString()` so there is exactly one definition of the rule
// rather than a server copy and a drifting client copy.
//
// Why it matters: the panel renders values that originate from REMOTE,
// attacker-influenced sources — submission error strings can carry remote
// HTTP response text, and a validation verdict's URL is chosen by the remote
// site via redirects. Those land in a page that holds restart, pause, and
// login-start buttons. The loopback guard does not help, because the payload
// would execute in the operator's browser at exactly the moment they open the
// panel to diagnose the failure that planted it.

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
