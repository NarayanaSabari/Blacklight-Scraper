@echo off
REM One-command update for this scraper host.
REM
REM WHY THIS EXISTS
REM Updating meant remembering which clone style this host uses (mirror vs
REM monorepo — they need DIFFERENT commands, and `git pull` silently fails on
REM the mirror because CI force-pushes it), whether npm ci is needed, and how
REM to restart. Four steps, each easy to get subtly wrong, performed rarely and
REM usually under pressure while the pipeline is down.
REM
REM Run this instead. Double-click it, or from a shell:
REM     C:\scraper\deploy\update-scraper.cmd
REM
REM It is safe to run when already up to date: it stops early and changes
REM nothing.
REM
REM It does NOT restart the process. The supervise loop in run-scraper.cmd
REM does that on the next exit, and the control panel's restart button
REM (http://<tailnet-ip>:3001/panel) exits cleanly for exactly this purpose —
REM releasing credential leases and flushing telemetry first. Killing the
REM process here instead would abandon a live lease mid-scrape.

setlocal
cd /d C:\scraper || (echo ERROR: C:\scraper not found & exit /b 1)

echo.
echo === Scraper update ===
for /f %%i in ('git rev-parse --short HEAD') do set BEFORE=%%i
echo current: %BEFORE%

REM Which clone is this?
REM
REM Mirror  (docs/SETUP.md §1A): Blacklight-Scraper, the scraper/ subtree only.
REM         CI FORCE-PUSHES it, so `git pull` eventually fails on rewritten
REM         history — reset is the documented update.
REM Monorepo (§1B): the host sits at <repo>/scraper, so a sibling `server/`
REM         directory exists one level up. Here `git pull` is correct.
REM
REM The mirror has no sibling server/, which is what distinguishes them.
if exist "..\server\" (
    echo clone   : monorepo
    REM Run from the repo ROOT: `git pull` inside a subdirectory still works,
    REM but the later `git diff` for the lockfile compares paths relative to
    REM the root, so stay consistent about where commands execute.
    pushd ..
    git pull origin main || (popd & echo ERROR: pull failed & exit /b 1)
    popd
) else (
    echo clone   : mirror ^(force-pushed by CI, so reset rather than pull^)
    git fetch origin || (echo ERROR: fetch failed & exit /b 1)
    git reset --hard origin/main || (echo ERROR: reset failed & exit /b 1)
)

for /f %%i in ('git rev-parse --short HEAD') do set AFTER=%%i
echo updated : %AFTER%

if "%BEFORE%"=="%AFTER%" (
    echo.
    echo Already up to date — nothing to do.
    exit /b 0
)

REM Only reinstall when the dependency set actually moved. `npm ci` wipes and
REM rebuilds node_modules, which on this host means re-fetching Playwright and
REM CloakBrowser binaries — minutes of downtime for no reason if nothing changed.
REM `git diff` here is run from C:\scraper, so on a monorepo clone the paths
REM come back as `scraper/package.json`. findstr matches on substring, so the
REM same pattern covers both clone styles.
git diff --name-only %BEFORE% %AFTER% | findstr /r "package.json package-lock.json" > NUL
if %ERRORLEVEL%==0 (
    echo deps    : changed, running npm ci
    call npm ci || (echo ERROR: npm ci failed & exit /b 1)
) else (
    echo deps    : unchanged, skipping npm ci
)

echo.
echo Updated %BEFORE% -^> %AFTER%
echo.
echo NEXT: restart to pick it up.
echo   - control panel  http://100.111.192.88:3001/panel  ^(Restart button^)
echo   - or just wait for the next natural exit; the supervise loop relaunches.
echo.
echo Confirm afterwards with:
echo   curl http://100.111.192.88:3001/panel/api/status
echo and check "gitSha" reads %AFTER%.
endlocal
