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
if not exist C:\scraper\logs mkdir C:\scraper\logs
:run
"C:\Program Files\nodejs\node.exe" server.js >> C:\scraper\logs\stdout.log 2>> C:\scraper\logs\stderr.log
echo [%date% %time%] scraper exited (code %ERRORLEVEL%); restarting in 10s >> C:\scraper\logs\supervisor.log
timeout /t 10 /nobreak > NUL
goto run
