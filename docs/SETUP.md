# Scraper setup

One guide for every host. Follow it top to bottom; the only per-OS differences
are marked 🐧 Linux / 🍎 macOS / 🪟 Windows.

**What a host is.** The scraper is one Node process that polls the Blacklight
backend, claims a role, scrapes the platforms its API key allows, submits the
jobs back, and completes the session. Which platforms a host handles is set by
its API key's `platform_allowlist` in the dashboard, not by config here. Adding
a host means registering a new key.

## Prerequisites

| Software | Why |
|---|---|
| **Node.js ≥ 22.19.0** | Runtime |
| **Git** | Clone + pull |
| A **desktop session** | Only for the two one-time LinkedIn steps (§6). Day-to-day running is headless. |

🐧 `sudo apt install -y nodejs npm git` (or NodeSource for 22.19.0+)
🍎 Install Node.js 22.19.0+ and Git with Homebrew or from nodejs.org.
🪟 Install Node.js from nodejs.org (tick *Tools for Native Modules*) and Git for
   Windows. Use **PowerShell** for every command below.

Node 20.x is not supported: the directly imported `undici` 8 transport requires
Node 22.19.0 or newer. Upgrade a Node 20 host before deploying the scraper.

Verify:

```bash
node --version   # v22.19.0 or higher
npm --version
git --version
```

CloakBrowser downloads its own stealth Chromium on first launch, so there is no
separate browser install. Pre-warm it once to get the download out of the way:

```bash
node -e "import('cloakbrowser').then(m=>m.ensureBinary()).then(()=>console.log('ok'))"
```

## 0. Remote access (if the host is not in front of you)

Skip this if you are sitting at the machine. A residential scraper host usually
lives somewhere else, so you need a way in that does **not** disturb the one
thing that makes it valuable.

> ### ⚠️ Never change the host's egress IP
>
> The whole point of a residential host is its residential IP: Indeed needs a
> clean one, and LinkedIn's transport has no proxy support so it always exits on
> the host's own address.
>
> On that machine: **no commercial VPN**, **no Tailscale exit node**, and no
> accepted subnet routes that would carry its outbound traffic elsewhere. Plain
> Tailscale only carries traffic *to* tailnet addresses; normal internet egress
> stays on the home ISP, which is what you want.
>
> If scrapes start getting challenged right after a networking change, check
> this first.

### Why a mesh VPN rather than port forwarding

A home connection is often behind **CGNAT**, where port forwarding is simply
impossible. A mesh VPN (Tailscale, or equivalent) also avoids exposing SSH to
the internet and avoids dynamic-DNS plumbing for a changing residential IP.

Install it on the host and on your own machine, sign both into the same account,
then confirm they can see each other:

```bash
tailscale status                       # both machines listed
tailscale ping <host>                  # expect "pong ... via <ip>:port"
```

A `pong ... via <ip>:<port>` is a **direct** connection. `via DERP` means it is
relaying through Tailscale's servers — still works, just slower.

### Enable OpenSSH Server

This is the one step that must be run **at the host** (or through whatever
remote tool you used to install the mesh VPN). Afterwards you never need local
access again. 🪟 PowerShell **as Administrator**:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# Land in PowerShell rather than cmd.exe
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -PropertyType String -Force
```

🐧🍎 `sshd` is already present; enable it (`systemctl enable --now ssh`, or
System Settings → General → Sharing → Remote Login).

### Key-based auth, and the Windows gotcha

Generate a key on your own machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/scraper_host -C "me->scraper-host"
cat ~/.ssh/scraper_host.pub
```

> 🪟 **If the Windows account is an administrator, `sshd` ignores
> `~/.ssh/authorized_keys`.** It reads only
> `C:\ProgramData\ssh\administrators_authorized_keys`, and it silently ignores
> that file too unless its ACL is locked down. This is the single most common
> reason key auth "just doesn't work".

```powershell
$akf = "C:\ProgramData\ssh\administrators_authorized_keys"
Add-Content -Path $akf -Value "<paste your public key>"
icacls $akf /inheritance:r
icacls $akf /grant "Administrators:F" /grant "SYSTEM:F"
```

Then disable password auth in `C:\ProgramData\ssh\sshd_config`
(`PasswordAuthentication no`, `PubkeyAuthentication yes`) and
`Restart-Service sshd`. Diagnose failures with
`Get-Content C:\ProgramData\ssh\logs\sshd.log`.

Save a host entry on your own machine so it is one word thereafter:

```
Host scraper-host
    HostName <tailnet-ip-or-name>
    User <host-user>
    IdentityFile ~/.ssh/scraper_host
    ServerAliveInterval 30
    ServerAliveCountMax 6
```

### You also need a desktop session

SSH covers everything day to day — installing, running, logs, restarts. It does
**not** cover the two one-time LinkedIn steps in §6, which open a real browser
window: a GUI app cannot render into an SSH session.

Enable remote desktop as well, and reach it **over the tailnet only** — never
expose RDP to the internet:

```powershell
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
  -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
```

### Stop the host sleeping

A sleeping host silently stops scraping, and the failure looks like "no jobs"
rather than an error.

```powershell
powercfg /change standby-timeout-ac 0     # 🪟
powercfg /change hibernate-timeout-ac 0
```

🐧 `sudo systemctl mask sleep.target suspend.target`
🍎 System Settings → Battery → Options → *Prevent sleeping when display is off*

Also set the BIOS/UEFI to restore power state after an outage, so the host comes
back on its own and the service (§8) restarts with it.

### Verify before moving on

From your own machine:

```bash
ssh scraper-host "node --version; git --version"
```

Both must satisfy the versions in Prerequisites. If `node` is missing or older
than 22.19.0, install it now — the rest of this guide assumes it.

## 1. Clone and install

There are two valid sources. Pick by whether the host needs to build or only
run.

### A deploy host — clone the mirror (simplest)

```bash
git clone https://github.com/NarayanaSabari/Blacklight-Scraper.git /path/to/scraper
cd /path/to/scraper
npm ci
```

`Blacklight-Scraper` is a **public, scraper-only mirror** of the monorepo's
`scraper/` directory, re-published by CI within a minute or two of every `main`
push that touches it (`.github/workflows/mirror-scraper.yml`). For a host that
only ever pulls, this is the better source: it is public, so the host needs **no
GitHub credentials at all**, and it carries only the scraper rather than the
whole monorepo.

The tradeoff is that CI **force-pushes** it, so its history is rewritten and
`git pull` will eventually fail. Update a mirror clone with:

```bash
git fetch origin
git reset --hard origin/main
```

Never commit here — the next mirror run overwrites it.

### A development host — clone the monorepo

```bash
git clone https://github.com/NarayanaSabari/Blacklight.git
cd Blacklight/scraper
npm ci
```

Use this if you intend to change the scraper. The monorepo is **private**, so
this host needs GitHub credentials (a PAT via the credential helper, or an SSH
key). Update it with `git pull origin main`.

## 2. Get an API key for this host

In the central dashboard (**Dashboard → API Keys**): create a key, name it after
the host, and set its **platform allowlist** to the platforms this host should
scrape. The backend only ever hands this host roles for those platforms.

Current split:

| Host type | Platforms | Why |
|---|---|---|
| Linux VM with an ISP/residential proxy pool | `monster`, `dice`, `techfetch` | Monster needs the pool for DataDome; Dice and TechFetch run fine headless |
| Residential machine (Windows/macOS) | `linkedin`, `glassdoor`, `indeed` | Indeed needs a clean residential IP; LinkedIn needs a warm logged-in profile |

## 3. `config/credentials.json`

Copy the example and fill in the backend URL and the key from §2:

```bash
cp config/credentials.example.json config/credentials.json
```

```json
{
  "blacklight": {
    "apiUrl": "https://api.qpeakhire.com",
    "apiKey": "<the key from step 2>"
  },
  "scraperCredentials": {
    "apiUrl": "https://api.qpeakhire.com",
    "apiKey": "<same key>"
  }
}
```

This file is git-ignored. **Never commit it.**

With `blacklight.apiUrl` + `apiKey` set, platform logins are fetched from the
dashboard on demand, and metrics/logs are proxied to Grafana through the same
API — no extra telemetry config.

Omitting them puts the credentials client in **local mode**, where it reads
platform logins from this same file instead (useful for a laptop). Local mode
hands out the same credential to every concurrent caller, so it does **not**
model production lease behaviour.

## 4. `.env` (optional)

```bash
cp .env.example .env
```

Every value has a working default; `.env.example` documents what each knob does.
The ones that actually matter per host:

| Variable | Use |
|---|---|
| `SCRAPER_MODE` | `daemon` on always-on hosts (enables offline alerts), `interactive` on laptops |
| `SCRAPER_DEFAULT_LOCATION` | Search location, default `United States` |
| `SCRAPER_STRICT_EMPTY` | Fallback for callers without a registry override; active platform entries already treat unexplained 0-job scrapes as failures. |
| `LINKEDIN_RSC_COUNT` | Results per LinkedIn request (default 10, hard cap 50) |

## 5. Proxies

Only needed on hosts scraping **Monster, Glassdoor detail enrichment, Indeed, or
TechFetch**. LinkedIn and Dice always run direct.

```bash
cp config/proxies.example.txt config/proxies.txt
```

One proxy per line, in your provider's format:

```
host:port:username:password
```

`config/proxies.txt` is git-ignored. Alternatively set `PROXY_LIST` (comma or
newline separated) or point `PROXY_LIST_FILE` elsewhere. With neither, every
platform runs direct.

Two knobs worth knowing:

- `PROXY_EXCLUDE_PLATFORMS` — platforms that must never be proxied. Defaults to
  `glassdoor`, whose discovery API rejects proxied requests while its detail
  enrichment is happy to use them.
- `PROXY_BLOCK_COOLDOWN_MS` — how long a proxy IP is benched after a block
  (default 10 min). A scrape that gets blocked cools its own exit IP so the next
  one rotates.

**LinkedIn ignores the proxy pool entirely.** Its transport is plain HTTP with no
proxy support, so a LinkedIn host's own IP is what LinkedIn sees. That is
deliberate: the residential IP is the asset. Do not put a VPN on that host.

## 6. LinkedIn: two one-time steps

Only on hosts whose allowlist includes `linkedin`. **Both need a real desktop
session** — over SSH alone they cannot render. Everything after this is headless.

### 6a. Log in

```bash
npm run linkedin:login
```

Opens a headed browser on a persistent profile
(`~/.blacklight-linkedin-profile`, or `%USERPROFILE%\.blacklight-linkedin-profile`;
override with `LINKEDIN_PROFILE_DIR`). Sign in, clear any *"confirm it's you"* /
2FA prompt, wait for the feed, then press Enter in the terminal to save.

The session lives in that directory and survives restarts. **Keep it intact.**
Re-run this whenever LinkedIn invalidates the session.

To start a profile over (wrong account keeps opening), `npm run linkedin:reset`
lists the on-disk profiles and deletes the ones you pick. It refuses to run while
the scraper is up, since a profile an open Chromium holds cannot be deleted.

### 6b. Capture the request template

```bash
npm run linkedin:rsc-template
```

LinkedIn's content search is a React-Server-Components app. The scraper replays
one of its requests, and that request's client-version headers and body shape
cannot be invented — so they are captured once per host into
`config/linkedin-rsc-template.json` (git-ignored).

Cookies and csrf-token are stripped before writing, so the file holds no
credentials; the scraper derives those per request from the profile's live jar.

Re-run this if LinkedIn ships a client version that breaks the saved template.
That surfaces as an auth/DOM failure, never as a silent empty result. Until it
exists the scraper fails fast with `NEEDS_TEMPLATE` naming this command.

## 7. Run

```bash
npm start
```

The process starts an Express server on `PORT` (default 3001) and begins polling
the queue every 30s. Check it:

```bash
curl http://localhost:3001/healthz
```

Confirm the host shows as `running` under **Scraper → Active Sessions** in the
dashboard.

For a manual one-off scrape:

```bash
curl -X POST http://localhost:3001/scrape \
  -H 'content-type: application/json' \
  -d '{"platform":"dice","jobTitle":"Data Engineer"}'
```

## 8. Keep it running

`npm start` dies with the terminal. On an always-on host, wrap it.

### 🪟 Windows — NSSM

Download NSSM from https://nssm.cc/download, extract to `C:\Tools\nssm\`:

```powershell
C:\Tools\nssm\nssm.exe install qp-scraper "C:\Program Files\nodejs\node.exe" "C:\scraper\server.js"
C:\Tools\nssm\nssm.exe set qp-scraper AppDirectory C:\scraper
C:\Tools\nssm\nssm.exe set qp-scraper AppEnvironmentExtra NODE_ENV=production SCRAPER_MODE=daemon
C:\Tools\nssm\nssm.exe set qp-scraper AppStdout C:\scraper\logs\stdout.log
C:\Tools\nssm\nssm.exe set qp-scraper AppStderr C:\scraper\logs\stderr.log
C:\Tools\nssm\nssm.exe set qp-scraper Start SERVICE_AUTO_START
C:\Tools\nssm\nssm.exe start qp-scraper
```

Manage via `services.msc` or `nssm restart|stop|status qp-scraper`.

### 🍎 macOS — launchd

Create `~/Library/LaunchAgents/com.qpeakhire.scraper.plist`. Replace
`YOUR_USERNAME` and the repo path, and note the node path differs by
architecture: `/opt/homebrew` on Apple Silicon, `/usr/local` on Intel.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.qpeakhire.scraper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOUR_USERNAME/Blacklight/scraper/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USERNAME/Blacklight/scraper</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>SCRAPER_MODE</key>
    <string>daemon</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/Blacklight/scraper/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/Blacklight/scraper/logs/stderr.log</string>
</dict>
</plist>
```

```bash
sed -i '' "s|YOUR_USERNAME|$(whoami)|g" ~/Library/LaunchAgents/com.qpeakhire.scraper.plist
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.qpeakhire.scraper.plist
launchctl list | grep qpeakhire
```

Reload after a code change with `launchctl unload` then `load`.

### 🐧 Linux — systemd

A unit with `ExecStart=/usr/bin/node /srv/scraper/server.js`,
`WorkingDirectory=/srv/scraper`, `Environment=SCRAPER_MODE=daemon`,
`Restart=always`, then `systemctl enable --now qp-scraper`.

### Do not let the host sleep

A sleeping host silently stops scraping.

🪟 `powercfg /change standby-timeout-ac 0` and `hibernate-timeout-ac 0`
🍎 System Settings → Battery → Options → *Prevent sleeping when display is off*
🐧 `sudo systemctl mask sleep.target suspend.target`

Also set the BIOS/UEFI to restore power state after an outage, so scraping
resumes unattended.

## 9. Updating

**Quickest path — one command:**

```bash
C:\scraper\deploy\update-scraper.cmd     # Windows; double-clicking works too
```

It detects which clone style this host uses, applies the right git command,
runs `npm ci` only when the lockfile actually changed, and tells you how to
restart. Safe to run when already current: it stops early and changes nothing.

It deliberately does **not** restart the process — the control panel's restart
button exits cleanly first, releasing credential leases and flushing telemetry,
whereas killing the process mid-scrape abandons a live lease.

<details>
<summary>Doing it by hand</summary>

Use the command that matches how this host was cloned (§1):

```bash
# mirror clone (deploy host) — history is force-pushed, so pull will fail
git fetch origin && git reset --hard origin/main

# monorepo clone (development host)
git pull origin main
```

then:

```bash
npm ci               # only if package.json or the lockfile changed
# then restart the service
```

</details>

> **Node does not hot-reload. After updating you MUST restart.**
>
> Skipping it is silent: the running process keeps executing the old code while
> `git log` shows the new commit. Confirm what is actually live by comparing
> `/healthz`'s `gitSha` against `git rev-parse --short HEAD`. If they differ, the
> process is stale.

Restart between sessions rather than mid-scrape. Killing a running scrape leaves
the backend session open and the orchestrator reports *"Active session already
exists"* until an admin terminates it in the dashboard.

## Troubleshooting

**`NEEDS_TEMPLATE` / LinkedIn RSC template not found**
Run `npm run linkedin:rsc-template` (§6b) on this host. Needs a desktop session.

**LinkedIn returns nothing, or `/healthz` reports no cached session jar**
The profile's session died. Re-run `npm run linkedin:login` (§6a).

**CloakBrowser fails to launch**
Re-run the pre-warm command from Prerequisites. On a licence-key host, confirm
`CLOAKBROWSER_LICENSE_KEYS` is set — seats are capped per key **globally, across
processes**, so concurrent platform scrapes need one key each or they queue.
A free-plan key starts killing sessions after a handful of rapid launches.

**Glassdoor fails at warm-up with HTTP 403**
Its discovery API is challenging this IP. Confirm `glassdoor` is in
`PROXY_EXCLUDE_PLATFORMS` (proxied warm-ups get rejected). This happens before
any browser launches, so browser settings cannot fix it.

**`Loaded 0 cookies` (Indeed)**
The credential's `credential_type` is not `json_blob`. Dashboard → Platforms →
the platform → set **Requires Credentials** to `JSON / Cookies` → Save.

**`addCookies: Invalid parameters`**
One pasted cookie has a malformed field. The per-cookie retry skips it and
continues; the log line `skipped cookie name=X domain=Y` names the offender.

**A scrape reports 0 jobs and you are not sure why**
With `SCRAPER_STRICT_EMPTY=true` an unexplained empty becomes a classified
failure with a cooldown instead of a silent success. Turn it on before trusting
a zero.

## Related

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — symptom-first diagnosis for a host that is already running (blocks that are not blocks, dead sessions, seat exhaustion, dedup)
- [DEPLOYMENT.md](DEPLOYMENT.md) — per-platform behaviour, observability, prod topology
- [scraper-runbook.md](scraper-runbook.md) — performance knobs, CloakBrowser seats
- [BACKEND_API.md](BACKEND_API.md) — the backend API this scraper talks to
