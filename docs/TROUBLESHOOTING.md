# Troubleshooting

Symptom-first diagnosis for a running scraper host.

`SETUP.md` covers standing a host up and `scraper-runbook.md` covers per-platform behaviour.
This file is for when a host is already running and something looks wrong.

Every entry below is a failure that actually happened and was measured, not a hypothetical.
The ordering is deliberate: the traps that waste the most time come first.

> All hosts, accounts and keys are written as placeholders.
> `scraper/` is force-mirrored to a public repository, so no real address, hostname, account
> name or key belongs anywhere in this directory.

## Read this before diagnosing anything

Two habits prevent most of the wasted effort in the entries below.

**A zero is not evidence of a block.** Several distinct faults all surface as "0 jobs", and the
scraper cannot tell them apart on its own. Always confirm against a query you know returns
results before concluding anything.

**A scrape that reports success can still be wrong.** Check what reached the backend, not what
the scraper logged. The two disagree more often than you would expect.

## "Suspected block / DOM change" that is not a block

**Symptom.** `Scrape returned 0 jobs with no confirmed-empty signal - suspected block / DOM
change`, `reason: blocked`.

This message is misleading by construction. It is what the scraper says whenever a scrape
produces nothing and cannot positively prove the query was genuinely empty. A parser that fails
to recognise the payload produces exactly the same message as a real block.

**Confirm before acting.** Capture the raw response and look at it:

- HTTP status. A real block is `403`, `429`, a challenge page, or a redirect to a login/checkpoint URL.
- Body size. A block page is small. A working payload is megabytes.
- Content markers. Search the body for the platform's post/job identifiers. If they are present
  in a `200` response, the site is serving you data and the problem is in the parser.

Measured on a Windows host: `HTTP 200`, 7.4 MB body, 1,330 activity identifiers present, zero
captcha or challenge markers, and the scraper still reported "suspected block". The cause was a
parser gap. Hours went into the account, the session, the licence key and the browser binary
before anyone looked at the payload.

**If the payload contains data, stop investigating access.** Go to the parser.

## LinkedIn returns 0 posts from a valid payload

**Cause.** LinkedIn renders content-search results in more than one card shape, and the extractor
has to handle all of them.

| Shape | Card row |
|---|---|
| inline | carries the post permalink itself |
| shell | a small skeleton row that *references* a large content row holding the permalink |

Which shape you get is decided by the LinkedIn web client version recorded in
`config/linkedin-rsc-template.json`, not by the host. Two hosts running identical code disagreed
purely because their templates were captured a day apart and pinned different client versions.

The extractor handles both shapes. If a future client introduces a third, the same
"suspected block" message will reappear.

**Diagnose.** Compare the client version in the template against a host that works:

```bash
node -e "const t=require('./config/linkedin-rsc-template.json'); \
  console.log(JSON.parse(t.headers['x-li-track']).clientVersion, t.capturedAt)"
```

A version difference between a working and a failing host points at the parser, not the account.

## LinkedIn: `session cookies missing (need li_at + JSESSIONID)` right after a successful login

**Cause.** The RSC transport needs both `li_at` and `JSESSIONID`; it echoes `JSESSIONID` as the
csrf-token header. LinkedIn sometimes issues `JSESSIONID` as a **session cookie**
(`expires = -1`), and Chromium discards session cookies when the browser closes. The headless
scraper then reads the profile and finds `li_at` present but `JSESSIONID` gone.

This is host-dependent and not a login mistake. The same account issued a persistent
`JSESSIONID` on one host and a session-only one on another.

**Confirm.** Read the profile jar cold, with no browser running:

```bash
node -e "import('./src/scrapers/linkedin-rsc/session.js').then(async m=>{ \
  const li=(await m.readProfileCookies({})).filter(c=>/linkedin/i.test(c.domain)); \
  console.log('li_at='+li.some(c=>c.name==='li_at'), \
              'JSESSIONID='+li.some(c=>c.name==='JSESSIONID')); process.exit(0)})"
```

**Fix.** Navigate the logged-in profile to the feed once, then re-add the same `JSESSIONID` value
with an explicit expiry before closing the context. Only the lifetime changes, not the value.
Verify by reopening the profile cold and reading the jar again.

## LinkedIn: search stops for a few hours, then comes back on its own

**Symptom.** Every LinkedIn scrape returns 0, on **both** accounts, starting within the same
minute. The template checks out as fresh. A few hours later it starts working again with no
intervention.

**This is a search quota, not a ban.** LinkedIn meters content search separately from the rest of
the site. Past some volume it stops serving search while leaving the account otherwise completely
functional. Confirm with `node scripts/linkedin-browser-check.js`: during a quota window the feed
and notifications render normally and the account is clearly logged in, but search shows
"No results found".

Measured 2026-08-18/19 (scrapes issued per hour, and posts returned):

| Hour (UTC) | Scrapes | Posts | |
|---|---|---|---|
| 19:00 | 135 | 1224 | serving |
| 20:00 | 231 | 781 | serving |
| 21-23 | ~285 | 0 | refusing |
| 00:00 | 208 | 5689 | serving, recovered by itself |
| 01:00 | 279 | 1106 | serving |
| 02:00 | 248 | 2457 | serving |
| 03-04 | ~288 | 0 | refusing |

Note the shape: the hours that returned the **most** are the ones that asked **least**. 208
scrapes returned 5,689 posts; 288 returned nothing. Pushing harder is not merely wasteful here,
it is counterproductive.

**How to tell it apart from the two lookalikes:**

| Template fresh? | Browser sees posts? | Both accounts at once? | Cause |
|---|---|---|---|
| no | yes | yes | stale template (see the section above) |
| yes | yes | no | that one account is restricted |
| yes | **no** | **yes** | **search quota - this section** |

**It handles itself now.** After 25 consecutive empty scrapes across all credentials, the scraper
writes the LinkedIn platform cooldown marker and stops claiming work for 30 minutes, doubling on
repeat trips up to 4 hours, decaying after a clean period. The control panel shows a warn alert
naming the accounts as fine, and `scraper_linkedin_quota_pauses_total` counts the trips.

**If it keeps tripping, lower the cadence — do not touch the accounts.** The sweep interval is the
control that matters: `linkedin` defaults to 30 minutes
(`DEFAULT_SWEEP_INTERVAL_MINUTES` in `src/panel/overrides.js`), but a stored value in
`config/platform-overrides.json` overrides it, and a stored `0` means "no cadence limit at all",
which is what produced the ~285 scrapes/hour above. Check that file first.

## LinkedIn: every query is empty and the accounts get "shadow-banned"

**This is the highest-cost failure in this file. Read it before you touch a credential.**

**Symptom.** Every LinkedIn scrape returns `posts: 0, emptyConfirmed: true`, including searches
that obviously have results. Shortly afterwards the canary reports one or both accounts as
shadow-banned and cools them for hours, and the pipeline goes to zero.

**It is almost certainly NOT a ban.** The captured RSC request template carries LinkedIn's client
build number (`x-li-application-version`). LinkedIn ships new builds continuously, and once the
captured one falls a few hundred builds behind, the pagination endpoint stops honouring the
request. It does not return an error: it returns `200` with a well-formed "No results found" page
carrying the positive no-results flag. That is byte-for-byte the shape of a genuine empty, so
every layer above it draws the wrong conclusion.

Measured 2026-08-18: template captured at `0.2.6546` on 07-31, LinkedIn live on `0.2.6815`, a lag
of 269 builds. Every query empty from 15:00 UTC. Both credentials falsely cooled for four hours
each. Five hours at zero ingest. A browser on the same profile, at the same moment, saw live
posts.

**Diagnose in one command:**

```bash
node scripts/linkedin-template-status.js     # captured vs live version + verdict
```

**If that is inconclusive, settle it definitively:**

```bash
node scripts/linkedin-browser-check.js       # what a REAL browser sees on this profile
```

The browser check is the tie-breaker, because it removes our request from the equation:

| Browser sees | HTTP transport sees | Meaning | Action |
|---|---|---|---|
| posts | nothing | our REQUEST is refused | re-capture the template |
| nothing | nothing | the ACCOUNT is restricted | quiet time; do not re-login |
| login wall | nothing | the SESSION is dead | `npm run linkedin:login` |

**Fix:**

```bash
npm run linkedin:rsc-template                # re-capture
# then restart via the control panel so the new template is loaded
```

Then clear any cooldown the canary applied, because it was a false positive: set the affected
`scraper_credentials` rows back to `available` with a null `cooldown_until`.

**This should now self-heal.** The daemon checks template freshness every four hours and
re-captures automatically, the canary refuses to report a ban while the template looks stale, and
the control panel raises an explicit alert naming both versions. The manual steps above are the
fallback for when that machinery itself fails - watch for
`scraper_alert: linkedin_template_recapture_failed`.

**Why the cost is asymmetric.** Re-capturing a healthy template costs one browser launch. Wrongly
cooling a healthy account costs four hours of that account's throughput and sends every
subsequent diagnosis in the wrong direction. When in doubt, re-capture first.

## Everything returns 0 and the profile looks logged in

Cookies can be *present* and still be dead. `li_at` in the jar proves nothing on its own.

**Confirm with a navigation, not a cookie check:**

```bash
# expect status 200 and a URL that is NOT /login, /checkpoint or /authwall
```

A redirect to a login or checkpoint URL means the session is dead even though the cookies are
still on disk. Re-run the login for that platform.

**Why this matters more than it looks.** A dead LinkedIn session makes every scrape return
`emptyConfirmed: true`, which is a *positive* assertion that the query genuinely had no results.
The backend trusts it, marks roles completed and never retries. Unattended, the pipeline looks
healthy while ingesting nothing. This falsely completed 15 queue rows before it was caught.

Always validate a suspicious zero against a query known to return results.

## Browser launches, then every navigation dies

**Symptom.** `page.goto: Target page, context or browser has been closed`, immediately after a
successful launch.

**Cause.** CloakBrowser licence seats, not a broken browser build.

A licence key allows a fixed number of concurrent sessions, enforced **server-side and globally
per key**. Two properties make this look like a browser defect:

- The **unlicensed** binary never validates the licence, so it ignores the cap and always
  appears to work.
- The **licensed** binary does validate, so it is the only one that gets killed.

Killing a process does **not** immediately release its server-side lease. A probe run inside that
window is killed; the identical probe later succeeds.

This was misdiagnosed once as "the licensed binary is broken on Windows". It is not. With the
seat verified idle, the licensed binary navigated fine on the same host, same profile, same
minute.

**Before concluding anything about the browser:**

1. Stop the scraper and confirm no `node` processes remain.
2. Remove the seat lock directory (`.blacklight-cloakbrowser-seats` under the host user's home).
3. Allow time for the server-side lease to lapse. Local process count is **not** sufficient
   evidence that a seat is free.
4. Run the probe detached or backgrounded. A blocking remote call that times out leaves the host
   not scraping.

**Also check for a stale interactive login.** `npm run linkedin:login` parks at a "press Enter"
prompt and holds a seat until it exits. One forgotten login held the only seat for 25 minutes and
made every later browser launch appear to close itself.

## `Platforms starved this cycle - excluded from claim`

**Not an error.** The backend reports zero leasable credentials for that platform, so the
orchestrator declines to claim work it cannot execute. Without this guard a starved platform
spins claim, fail, re-claim and burns thousands of empty sessions.

With a single credential per platform this is **normal** while a scrape is in flight.

**It is a problem only when it persists.** Then the credential is stranded (see next entry).

## Stranded credentials and queue rows after a restart

Stopping the scraper mid-scrape leaves backend state behind, because the process never got to
release it:

- the leased credential stays `in_use`
- the claimed queue rows stay `claimed`
- the sessions stay `in_progress`

The visible consequence is a platform stuck on "starved" and refusing to claim work.

There is a reaper with a grace window, so this self-heals. To clear it immediately, reset the
credential to `available`, the queue rows to `pending`, and stale in-progress sessions to
`failed`.

**Prefer a graceful stop.** The process handles a termination signal and uses that window to
finish the in-flight scrape and release its lease. A hard kill skips all of it.

## Low import counts are usually dedup, not failure

`jobs_found: 40, jobs_imported: 0` is normal and does not indicate a fault.

Measured across a 45-minute window on a saturated queue:

| Platform | Scraped | Imported | New |
|---|---|---|---|
| dice | 772 | 60 | 7.8% |
| indeed | 18,068 | 880 | 4.9% |
| linkedin | 1,983 | 35 | 1.8% |
| techfetch | 741 | 2 | 0.27% |

Every platform re-scrapes the same recency window, and many queued roles use overlapping
queries, so the same posting matches repeatedly. A low percentage means the window is already
harvested, not that extraction is broken.

`jobs_found` proves extraction works. Judge health by **new rows per hour**, not by scrape count.

A very low percentage on a small board also means polling it continuously spends browser seats on
a source with almost nothing new. That is a scheduling question, not a bug.

## Windows: the LinkedIn profile is silently wiped

**Cause.** Windows encrypts browser cookies with DPAPI, which is **per-identity**.

A service running as a system account cannot decrypt a profile created by an interactive user, so
the browser **discards the cookies** rather than failing loudly. A fresh login is destroyed the
moment the service starts on it, and the credential flips to needing re-login.

Verified this is destruction and not a file lock: with the service fully stopped, the profile
still read zero cookies.

**Setting `USERPROFILE` / `HOME` on the service is not sufficient.** That fixes which *path* is
used, not which *identity* decrypts it.

**The requirement:** whoever performs the login must be the same identity the scraper runs as.

Options that satisfy it:

- Run the scraper under a real local user account and perform the login as that user.
- Run it as a scheduled task triggered at that user's logon.

Options that do **not** work:

- A service account that is a Microsoft account. Windows service logon rejects it regardless of
  the password being correct.
- Performing the login as the system account. The browser launches but cannot navigate, and
  injected cookies do not persist.

A logon-triggered task has one tradeoff worth stating: after a reboot with nobody signed in,
nothing starts.

## `npm run linkedin:login` opens a blank browser

The login script swallows navigation failures, so the browser opens, fails to reach LinkedIn, and
still prints "log in now". An empty profile afterwards (no history entries, empty cookie
database) confirms navigation never happened.

Check the browser can navigate at all before blaming the login. The preflight in
`linkedin:login` verifies this and will roll back a licence key it applied if navigation breaks.

## Quick reference

| Symptom | Look at first |
|---|---|
| "suspected block", `reason: blocked` | The raw payload. Status, size, content markers. |
| 0 posts from a `200` payload with content | The parser and the captured client version. |
| `need li_at + JSESSIONID` after login | Whether `JSESSIONID` persisted to disk. |
| Cookies present but every scrape empty | Navigate. A redirect to login means a dead session. |
| Browser closes on navigate | Licence seats and stale leases, not the binary. |
| Persistent "starved" | Stranded credential or queue rows. |
| Low `jobs_imported` | Usually dedup. Confirm with `jobs_found`. |
| Profile wiped on Windows | Service identity vs login identity (DPAPI). |

## Related

- [SETUP.md](SETUP.md) - standing up a host
- [scraper-runbook.md](scraper-runbook.md) - per-platform behaviour and seat configuration
- [DEPLOYMENT.md](DEPLOYMENT.md) - production topology and observability
- [BACKEND_API.md](BACKEND_API.md) - the API this scraper talks to
