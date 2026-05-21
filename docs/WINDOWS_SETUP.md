# Setting up the scraper on a Windows machine

This guide walks a fresh Windows host through running the LinkedIn,
Glassdoor, and Indeed scrapers in production.

## Why a Windows machine for these three platforms

The Hetzner VM (Linux, datacenter IP) handles **Monster, Dice, TechFetch**
fine — those use HTTP-only or cookie-only flows that the platforms accept
from a hosting IP.

LinkedIn, Glassdoor, and Indeed are different:

| Platform | Why VM doesn't work |
|---|---|
| **LinkedIn** | Requires a real Chrome with a logged-in session (CDP-based scraper). VM is headless and can't host an interactive login. |
| **Glassdoor** | Visible-window Chromium (`headless: false`) needed to pass anti-bot. VM has no display. |
| **Indeed** | Cloudflare bot management blocks the VM IP at the edge (`HTTP 403`, `cf-mitigated: challenge`). Cookies don't help — IP reputation is the gate. |

A residential Windows machine sidesteps all three: it's headed,
display-attached, and has a residential IP that the platforms trust.

## Prerequisites

Install these on the Windows host once:

| Software | Why | Install |
|---|---|---|
| **Node.js** ≥ 20 LTS | Runtime | https://nodejs.org/ — pick "LTS" |
| **Git for Windows** | Clone + pull | https://git-scm.com/download/win |
| **Google Chrome** | LinkedIn CDP target | https://www.google.com/chrome/ |
| **Microsoft Build Tools** | Native deps for Playwright | Comes with Node.js installer if you tick *"Tools for Native Modules"* during install |

Verify after install (open **PowerShell**):

```powershell
node --version    # should print v20.x.x or higher
npm --version
git --version
```

## 1. Clone and install

Open PowerShell in any directory you like (`C:\scraper\` is fine):

```powershell
cd C:\
git clone https://github.com/NarayanaSabari/Blacklight-Scraper.git scraper
cd scraper
npm install
npx playwright install chromium
```

`npm install` takes ~2 minutes, `playwright install` adds another ~1 minute
of Chromium download.

## 2. Get a scraper API key for this host

Each scraper host needs its own API key. The VM uses one key
(`vm-monster-dice`); your Windows host needs a separate one with a
different platform allowlist.

In **central.qpeakhire.com**:

1. Go to **Dashboard → API Keys → + New API Key**
2. Name it something obvious — e.g. `windows-laptop-jglc` (job-board, glass, linkedin, indeed = `jgli`)
3. Copy the key value — you'll only see it once
4. Open the key's row → set **Platform Allowlist** to:
   ```
   ["linkedin", "glassdoor", "indeed"]
   ```
5. Confirm **Active** is on

This is the only thing that decides which platforms this host scrapes.
Anything not in the allowlist is silently filtered out by the backend's
queue endpoint.

## 3. Configure credentials.json

Create `config\credentials.json` (copy the template):

```powershell
copy config\credentials.example.json config\credentials.json
notepad config\credentials.json
```

Edit it to look like this (replace `<PASTE_YOUR_KEY>` with the value
from step 2):

```json
{
  "blacklight": {
    "apiUrl": "https://api.qpeakhire.com",
    "apiKey": "<PASTE_YOUR_KEY>"
  },
  "scraperCredentials": {
    "apiUrl": "https://api.qpeakhire.com",
    "apiKey": "<PASTE_YOUR_KEY>"
  }
}
```

Both blocks are needed — `blacklight` controls queue + telemetry, and
`scraperCredentials` controls the per-platform credential fetch (LinkedIn
email/password, Glassdoor cookies, Indeed cookies).

`config\credentials.json` is **gitignored**. Don't commit it.

> **Note:** unlike the VM, you don't keep platform-specific credentials
> in this file. They live in the central dashboard (Dashboard →
> Credentials) and are pulled on demand. The local file holds only the
> scraper API key.

## 4. Add platform credentials in the central dashboard

The scraper fetches per-platform credentials from the backend. Add them
once via central.qpeakhire.com:

### LinkedIn
- **Dashboard → Credentials → LinkedIn → + Add Credential**
- Name: any label (e.g. `linkedin-windows-1`)
- Email + password of the LinkedIn account to scrape from
- The first scrape after this key starts running will trigger an
  interactive login (see step 5 below)

### Glassdoor
- **Dashboard → Credentials → Glassdoor → + Add Credential**
- Solve the Glassdoor captcha in your real browser
- DevTools → Application → Cookies → `glassdoor.com` → export as JSON
  (any cookie-export extension works — see [Brave/Chrome cookie editor extension](https://chromewebstore.google.com/search/cookie%20editor))
- Paste the exported JSON array into the dialog

### Indeed
- **Dashboard → Credentials → Indeed → + Add Credential**
- Same flow as Glassdoor: solve any Indeed captcha, export cookies, paste

> The cookie format expected is the **array-of-objects** shape produced
> by Cookie-Editor / EditThisCookie / Brave's built-in cookie export.
> The scraper accepts both Unix-seconds and ISO 8601 expiration dates,
> so any common export tool works.

## 5. LinkedIn — one-time interactive login

LinkedIn scraping uses a long-lived CloakBrowser stealth profile on disk.
This needs a one-time human login per host.

```powershell
npm run linkedin:login
```

That:
- Opens a **headed** CloakBrowser on the scraper's persistent profile dir
  (`%USERPROFILE%\.blacklight-linkedin-profile`; override with `LINKEDIN_PROFILE_DIR`)
- Navigates to `linkedin.com/login`

In that browser window:
1. Sign in to LinkedIn
2. Solve any *"Confirm it's you"* / SMS / 2FA prompt
3. Wait until the feed loads
4. Return to the terminal and press Enter to save + close

After this, the session persists in the profile dir, so the scraper
reuses your logged-in session without further logins until LinkedIn
invalidates it. Re-run `npm run linkedin:login` whenever the session dies.

## 6. Start the scraper

```powershell
npm start
```

You should see, within a few seconds:

```
INFO [SERVER] Starting Unified Job Scraper API
INFO [CREDENTIALS] Using REMOTE credentials API
INFO [SERVER] Server listening {"port":3001}
INFO [ORCHESTRATOR] Auto queue checker enabled {"checkIntervalMs":30000}
INFO [ORCHESTRATOR] Starting queue cycle
INFO [ORCHESTRATOR] Queue item acquired {"sessionId":"...","platforms":["linkedin","glassdoor","indeed"]}
```

That last line is the success signal — the backend handed your host a
role with the three platforms in its allowlist. From there:

- LinkedIn, Glassdoor, Indeed all run **in parallel** within each session
- Wall-clock = max(LinkedIn ~6 min, Glassdoor ~75s, Indeed ~85s) ≈ 6 min
- The slowest scraper is LinkedIn (`maxPosts: 100` with 2s scroll delay)

Confirm in central.qpeakhire.com → **Scraper → Active Sessions** that
your Windows host appears with `running` status.

## 7. Run as a Windows Service (so it stays up)

`npm start` keeps running until you close PowerShell. For an always-on
host, wrap it as a Windows service using **NSSM** (the Non-Sucking
Service Manager):

```powershell
# 1. Download NSSM from https://nssm.cc/download — extract nssm.exe to C:\Tools\nssm\

# 2. Install the service
C:\Tools\nssm\nssm.exe install qp-scraper "C:\Program Files\nodejs\node.exe" "C:\scraper\server.js"

# 3. Configure it
C:\Tools\nssm\nssm.exe set qp-scraper AppDirectory C:\scraper
C:\Tools\nssm\nssm.exe set qp-scraper AppEnvironmentExtra NODE_ENV=production SCRAPER_MODE=daemon
C:\Tools\nssm\nssm.exe set qp-scraper AppStdout C:\scraper\logs\stdout.log
C:\Tools\nssm\nssm.exe set qp-scraper AppStderr C:\scraper\logs\stderr.log
C:\Tools\nssm\nssm.exe set qp-scraper Start SERVICE_AUTO_START

# 4. Start it
C:\Tools\nssm\nssm.exe start qp-scraper
```

Manage afterwards via the standard Services app (`services.msc`) or:

```powershell
C:\Tools\nssm\nssm.exe restart qp-scraper
C:\Tools\nssm\nssm.exe stop qp-scraper
C:\Tools\nssm\nssm.exe status qp-scraper
```

> **Heads up:** `npm run linkedin:login` opens a HEADED browser, so the
> one-time login needs a real desktop session. The scraper itself
> (`npm start`) can run headless (`LINKEDIN_HEADLESS=true`). The logged-in
> session lives in the persistent profile dir (`%USERPROFILE%\.blacklight-linkedin-profile`)
> — keep that directory intact across restarts.

## 8. Updating the code

```powershell
cd C:\scraper
git pull origin main
npm install                # only if package.json changed
C:\Tools\nssm\nssm.exe restart qp-scraper
```

Restart between sessions to avoid leaving zombies in the backend queue
(restart mid-scrape kills the session and the orchestrator reports
"Active session already exists" until an admin terminates it via the
dashboard).

## Troubleshooting

**`Chrome failed to start within 10 seconds`** (LinkedIn)
- Chrome is installed at a non-default path. Set `CHROME_PATH`:
  ```powershell
  $env:CHROME_PATH = "C:\Users\you\AppData\Local\Google\Chrome\Application\chrome.exe"
  ```
- Or kill any running Chrome (must be fully closed for `--remote-debugging-port` to bind)

**`Loaded 0 cookies`** (Glassdoor or Indeed)
- The credential's `credential_type` in the DB isn't `json_blob`. Open
  Dashboard → Platforms → click the platform → set **Requires
  Credentials** to `JSON / Cookies` → Save.

**`browserContext.addCookies: Protocol error (Storage.setCookies): Invalid parameters`**
- One of your pasted cookies has a malformed field. The scraper's
  per-cookie retry will skip it and continue with the rest. Check the
  log line `skipped cookie name=X domain=Y` for the offender — usually
  a session cookie with a weird value.

**`Page 1: Found 0 jobs`** finishing in <10 seconds (Indeed or Glassdoor)
- Page is showing a security/captcha challenge instead of results. The
  IP got flagged. Solve the captcha in your real browser (same machine,
  same IP), re-export cookies, update the credential in the dashboard.
  Hot-reload picks it up within a few seconds.

**`Active session already exists` for many minutes**
- A previous scrape session is stuck `in_progress` in the DB (zombie).
  Open Dashboard → Scraper → Active Sessions → find the stuck row →
  click **Terminate**. The auto-checker will claim a fresh role within
  30 seconds.

**Scraper can't reach the backend (`api.qpeakhire.com`)**
- Test from PowerShell:
  ```powershell
  curl -I https://api.qpeakhire.com/healthz
  ```
- If that fails: check Windows Firewall, corporate VPN, or DNS

**Memory pressure / Chromium crash**
- LinkedIn (Chrome) + Glassdoor (Chromium) + Indeed (Chromium) running
  in parallel takes ~1 GB peak. On a 4 GB Windows host you may hit
  swap. Either close other apps or set `MaxOldSpaceSize` lower per
  scraper:
  ```powershell
  $env:NODE_OPTIONS = "--max-old-space-size=512"
  npm start
  ```

## Architecture recap

| Host | Allowlist | Why |
|---|---|---|
| Hetzner VM (Linux, headless) | `monster, dice, techfetch` | HTTP/cookie-only flows; no display required; tolerates datacenter IP |
| **Windows machine (residential)** | `linkedin, glassdoor, indeed` | Headed Chrome required + clean residential IP for anti-bot |

Both hosts share the same code, the same backend, the same queue. The
only thing that differs is the API key and its allowlist — the backend
silently routes each role to the right host.

To take a host out of rotation: set its API key to `Inactive` in the
dashboard (the scraper will keep polling but get an empty queue
response and idle indefinitely). Re-activate to resume.

## Related docs

- `README.md` — top-level scraper overview + manual API endpoints
- `Complete API.md` — Blacklight backend API reference for the queue + credential endpoints
- Dashboard → Scraper → Active Sessions / Recent Activity — runtime visibility
