@echo off
REM Launcher for the qp-scraper Scheduled Task.
REM
REM Runs the scraper as the INTERACTIVE user (black) rather than LocalSystem.
REM Windows encrypts Chromium cookies with DPAPI, which is per-identity: a
REM LocalSystem service opening a profile created by `black` cannot decrypt it
REM and SILENTLY WIPES the session. That destroyed a fresh LinkedIn login on
REM 2026-07-30. Running as `black` means the login and the scrape share one
REM identity, which is what LinkedIn's persistent profile requires.
REM
REM Env mirrors the old NSSM AppEnvironmentExtra exactly.
REM
REM SUPERVISE LOOP: the Scheduled Task trigger fires at logon and never again,
REM so without this loop ANY exit leaves the host silently not scraping until
REM a human notices - which is exactly how it was found stopped on 2026-08-01.
REM It also makes the control panel's restart button work: that button exits 0
REM on purpose, after releasing credential leases and flushing telemetry, and
REM relies on the supervisor to bring the process back. The 10s delay keeps a
REM crash-loop from hammering the backend API.
cd /d C:\scraper
set NODE_ENV=production
set SCRAPER_MODE=daemon
REM Panel access: loopback is always allowed; this admits Tailscale peers
REM (100.64.0.0/10 is the CGNAT range tailscaled assigns) so the panel is
REM reachable at http://<tailnet-ip>:3001/panel without an SSH tunnel. The
REM LAN (192.168.x / 10.x) and everything else still get 403. This is an
REM address allowlist, not auth - it trusts every device on the tailnet.
set PANEL_ALLOWED_CIDRS=100.64.0.0/10
REM LinkedIn meters CONTENT SEARCH separately from the rest of the site, and the
REM PACER - not the sweep interval - is what actually caps our request rate.
REM
REM 20s floor + 10s jitter, across 2 credentials running concurrently, is a
REM ceiling of 288 scrapes/hour. That is EXACTLY the rate measured when LinkedIn
REM cut content search off on 2026-08-18/19: both accounts, simultaneously, for
REM 2-5 hours at a time, recovering on their own. The hours that yielded most
REM were the ones that asked least (208 scrapes -> 5689 posts; 288 -> 0).
REM
REM Raising the sweep interval alone does NOT fix this: 154 queue rows coming
REM due every 30 minutes still demands ~308/hour, so the pacer stays the binding
REM constraint. 45s + 15s puts the real ceiling near 137/hour.
REM
REM ⚠️ Do NOT raise these further without raising the backend's
REM INFLIGHT_GRACE_SECONDS first. Worst-case lease hold is
REM spacing + jitter + the 420s candidate budget, and
REM test/scrapers/linkedin-acceptance.test.js asserts >=120s of margin under the
REM 600s orphan window. 45s+15s sits exactly at that limit; anything larger
REM starts handing live sessions to a second scraper, which double-scrapes and
REM doubles the load this setting exists to reduce.
set LINKEDIN_MIN_REQUEST_SPACING_MS=45000
set LINKEDIN_REQUEST_SPACING_JITTER_MS=15000
if not exist C:\scraper\logs mkdir C:\scraper\logs
:run
"C:\Program Files\nodejs\node.exe" server.js >> C:\scraper\logs\stdout.log 2>> C:\scraper\logs\stderr.log
echo [%date% %time%] scraper exited (code %ERRORLEVEL%); restarting in 10s >> C:\scraper\logs\supervisor.log
timeout /t 10 /nobreak > NUL
goto run
