# Setting up the scraper on a Mac

This guide walks a fresh macOS host through running the LinkedIn,
Glassdoor, and Indeed scrapers in production. It mirrors
[`WINDOWS_SETUP.md`](WINDOWS_SETUP.md) — pick whichever OS you have
spare residential bandwidth on.

## Why a Mac for these three platforms

The Hetzner VM (Linux, datacenter IP) handles **Monster, Dice, TechFetch**
fine — those use HTTP-only or cookie-only flows that the platforms accept
from a hosting IP.

LinkedIn, Glassdoor, and Indeed are different:

| Platform | Why VM doesn't work |
|---|---|
| **LinkedIn** | Requires a real Chrome with a logged-in session (CDP-based scraper). VM is headless and can't host an interactive login. |
| **Glassdoor** | Visible-window Chromium (`headless: false`) needed to pass anti-bot. VM has no display. |
| **Indeed** | Cloudflare bot management blocks the VM IP at the edge (`HTTP 403`, `cf-mitigated: challenge`). Cookies don't help — IP reputation is the gate. |

A residential Mac sidesteps all three: it's headed, display-attached,
and has a residential IP that the platforms trust. Apple Silicon (M1/M2/M3)
or Intel both work — Playwright ships native arm64 Chromium since v1.40.

## Prerequisites

Install these on the Mac once. Easiest path is **Homebrew**:

```bash
# 1. Homebrew (skip if already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Node 20 LTS + Git + Google Chrome
brew install node@20 git
brew install --cask google-chrome
```

Verify after install:

```bash
node --version    # v20.x.x or higher
npm --version
git --version
ls -la "/Applications/Google Chrome.app"   # exists
```

If `node` resolves to a different version, force the Homebrew one:

```bash
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

(Use `/usr/local/opt/...` instead of `/opt/homebrew/opt/...` on Intel Macs.)

## 1. Clone and install

```bash
mkdir -p ~/scraper && cd ~/scraper
git clone https://github.com/NarayanaSabari/Blacklight-Scraper.git .
npm install
npx playwright install chromium
```

`npm install` takes ~2 minutes; `playwright install` adds ~1 minute of
Chromium download.

## 2. Get a scraper API key for this host

Each scraper host needs its own API key. The VM uses one key
(`vm-monster-dice`); your Mac needs a separate one with a different
platform allowlist.

In **central.qpeakhire.com**:

1. Go to **Dashboard → API Keys → + New API Key**
2. Name it something obvious — e.g. `mac-mini-jgli` (job-board, glassdoor, linkedin, indeed = `jgli`)
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

```bash
cp config/credentials.example.json config/credentials.json
nano config/credentials.json    # or `code config/credentials.json` if you use VS Code
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
`scraperCredentials` controls the per-platform credential fetch
(LinkedIn email/password, Glassdoor cookies, Indeed cookies).

`config/credentials.json` is **gitignored**. Don't commit it.

> **Note:** unlike legacy local-mode setups, you don't keep
> platform-specific credentials in this file. They live in the central
> dashboard (Dashboard → Credentials) and are pulled on demand. The
> local file holds only the scraper API key.

## 4. Add platform credentials in the central dashboard

The scraper fetches per-platform credentials from the backend. Add them
once via central.qpeakhire.com:

### LinkedIn
- **Dashboard → Credentials → LinkedIn → + Add Credential**
- Name: any label (e.g. `linkedin-mac-1`)
- Email + password of the LinkedIn account to scrape from
- The first scrape after this key starts running will trigger an
  interactive login (see step 5)

### Glassdoor
- **Dashboard → Credentials → Glassdoor → + Add Credential**
- Solve the Glassdoor captcha in your real Chrome / Brave / Safari
- DevTools → Application → Cookies → `glassdoor.com` → export as JSON
  (any cookie-export extension — e.g. [Cookie-Editor](https://chromewebstore.google.com/search/cookie%20editor))
- Paste the exported JSON array into the dialog

### Indeed
- **Dashboard → Credentials → Indeed → + Add Credential**
- Same flow as Glassdoor: solve any Indeed captcha, export cookies, paste

> The cookie format expected is the **array-of-objects** shape produced
> by Cookie-Editor / EditThisCookie / Brave's built-in cookie export.
> The scraper accepts both Unix-seconds and ISO 8601 expiration dates,
> so any common export tool works.

## 5. LinkedIn — one-time interactive login

LinkedIn scraping uses Chrome DevTools Protocol against a real Chrome
with a persistent profile. This needs a one-time human login per host.

```bash
npm run chrome:login
```

That:
- Launches Chrome with `--remote-debugging-port=9222 --user-data-dir=~/chrome-debug-profile`
- Opens `linkedin.com/feed`
- Picks the standard Chrome path on macOS automatically
  (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
  Override with the `CHROME_PATH` env var if Chrome is installed elsewhere.

In that Chrome window:
1. Sign in with the LinkedIn email/password you added in step 4
2. Solve any *"Confirm it's you"* / SMS / 2FA prompt
3. Wait until the feed loads
4. Leave the window open in the background; don't close it

After this, cookies persist in `~/chrome-debug-profile`, so the scraper
can connect over CDP and run searches without further logins until
LinkedIn invalidates the session (typically weeks).

If `npm run chrome:login` reports *"Chrome already running with debug port"*,
you're already set — skip ahead.

## 6. Start the scraper

```bash
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
your Mac host appears with `running` status.

## 7. Run as a launchd service (so it stays up)

`npm start` keeps running until you close Terminal. For an always-on
Mac, wrap it as a launchd LaunchAgent:

Create `~/Library/LaunchAgents/com.qpeakhire.scraper.plist`:

```bash
cat > ~/Library/LaunchAgents/com.qpeakhire.scraper.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.qpeakhire.scraper</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/YOUR_USERNAME/scraper/server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/scraper</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>SCRAPER_MODE</key>
        <string>daemon</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/scraper/logs/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/scraper/logs/stderr.log</string>
</dict>
</plist>
PLIST
```

Then:

```bash
# Replace YOUR_USERNAME with the actual macOS user
sed -i '' "s|YOUR_USERNAME|$(whoami)|g" ~/Library/LaunchAgents/com.qpeakhire.scraper.plist

# Make sure the log dir exists
mkdir -p ~/scraper/logs

# On Intel Macs, swap /opt/homebrew → /usr/local in the plist
# (or just set node path explicitly: `which node` shows the right one)

# Load it
launchctl load -w ~/Library/LaunchAgents/com.qpeakhire.scraper.plist

# Verify it's running
launchctl list | grep qpeakhire
ps aux | grep "node.*server.js" | grep -v grep
```

Manage afterwards via:

```bash
launchctl unload ~/Library/LaunchAgents/com.qpeakhire.scraper.plist   # stop
launchctl load -w ~/Library/LaunchAgents/com.qpeakhire.scraper.plist  # start
launchctl kickstart -k gui/$(id -u)/com.qpeakhire.scraper             # restart
```

Tail logs with:

```bash
tail -f ~/scraper/logs/stdout.log ~/scraper/logs/stderr.log
```

> **Heads up:** the LinkedIn CDP flow needs a real desktop session.
> launchd's GUI agent runs as your user, so this works as long as
> you're logged in. If you log out, Chrome closes and LinkedIn scrapes
> fail. For a true headless Mac, leave the user logged in (System
> Settings → Users & Groups → Login Options → enable auto-login).

## 8. Updating the code

```bash
cd ~/scraper
git pull origin main
npm install      # only if package.json changed
launchctl kickstart -k gui/$(id -u)/com.qpeakhire.scraper
```

Restart between sessions to avoid leaving zombies in the backend queue
(restart mid-scrape kills the session and the orchestrator reports
"Active session already exists" until an admin terminates it via the
dashboard).

## Troubleshooting

**`Chrome failed to start within 10 seconds`** (LinkedIn)
- Chrome is installed at a non-default path. Set `CHROME_PATH`:
  ```bash
  export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ```
- Or kill any running Chrome (must be fully closed for `--remote-debugging-port` to bind):
  ```bash
  pkill -f "Google Chrome"
  ```

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
  IP got flagged. Solve the captcha in your real browser (same Mac,
  same IP), re-export cookies, update the credential in the dashboard.
  Hot-reload picks it up within a few seconds.

**`Active session already exists` for many minutes**
- A previous scrape session is stuck `in_progress` in the DB (zombie).
  Open Dashboard → Scraper → Active Sessions → find the stuck row →
  click **Terminate**. The auto-checker will claim a fresh role within
  30 seconds.

**Scraper can't reach the backend (`api.qpeakhire.com`)**
- Test from Terminal:
  ```bash
  curl -I https://api.qpeakhire.com/healthz
  ```
- If that fails: check Wi-Fi, VPN, DNS, or any system-wide proxy
  (`networksetup -getwebproxy "Wi-Fi"`).

**Memory pressure / Chromium crash**
- LinkedIn (Chrome) + Glassdoor (Chromium) + Indeed (Chromium) running
  in parallel takes ~1 GB peak. On an 8 GB Mac you're fine; on 4 GB
  you may swap. Close other apps or set `MaxOldSpaceSize` lower:
  ```bash
  NODE_OPTIONS="--max-old-space-size=512" npm start
  ```

**Mac goes to sleep and the scraper stops**
- System Settings → Battery → "Prevent automatic sleeping when display
  is off" (when on power adapter). For a dedicated host, also disable
  display sleep. Or run `caffeinate -i` in a side terminal.

**`xcrun: error: invalid active developer path`**
- Xcode CLI tools missing. Install with `xcode-select --install` and
  click through the dialog.

**Apple Silicon — `bad CPU type in executable`**
- Some old npm package shipped Intel-only binaries. Reinstall with
  `npm install --arch=arm64` or wipe `node_modules` and reinstall.

## Architecture recap

| Host | Allowlist | Why |
|---|---|---|
| Hetzner VM (Linux, headless) | `monster, dice, techfetch` | HTTP/cookie-only flows; no display required; tolerates datacenter IP |
| **Mac (residential)** | `linkedin, glassdoor, indeed` | Headed Chrome required + clean residential IP for anti-bot |

Both hosts share the same code, the same backend, the same queue. The
only thing that differs is the API key and its allowlist — the backend
silently routes each role to the right host.

To take a host out of rotation: set its API key to `Inactive` in the
dashboard (the scraper will keep polling but get an empty queue
response and idle indefinitely). Re-activate to resume.

## Related docs

- [`WINDOWS_SETUP.md`](WINDOWS_SETUP.md) — same workflow, on Windows
- `README.md` — top-level scraper overview + manual API endpoints
- `Complete API.md` — Blacklight backend API reference for the queue + credential endpoints
- Dashboard → Scraper → Active Sessions / Recent Activity — runtime visibility
