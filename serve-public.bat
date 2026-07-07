@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo ========================================
echo   Tanqi Online - Public Host
echo ========================================
echo.
echo Friends open your HTTPS link in a browser.
echo Install cloudflared: winget install Cloudflare.cloudflared
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

where cloudflared >nul 2>&1
if errorlevel 1 (
    echo [ERROR] cloudflared not found in PATH
    pause
    exit /b 1
)

if not exist "%ROOT%server\node_modules\matter-js" (
    echo Installing server dependencies...
    pushd "%ROOT%server"
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed
        popd
        pause
        exit /b 1
    )
    popd
)

echo Stopping old listeners on port 8080...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

netstat -ano | findstr ":8080" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [ERROR] Port 8080 is still in use:
    netstat -ano | findstr ":8080" | findstr "LISTENING"
    pause
    exit /b 1
)

echo Starting game server...
start "Tanqi-Server" /D "%ROOT%server" cmd /k node server.js

echo Waiting for http://127.0.0.1:8080/api/health ...
set WAIT_COUNT=0
:wait_loop
set /a WAIT_COUNT+=1
curl.exe -s -m 2 http://127.0.0.1:8080/api/health 2>nul | findstr /C:"\"ok\":true" >nul 2>&1
if not errorlevel 1 goto server_ok
if %WAIT_COUNT% geq 30 goto server_fail
timeout /t 1 /nobreak >nul
goto wait_loop

:server_fail
echo.
echo [ERROR] Server did not start. Check the Tanqi-Server window.
pause
exit /b 1

:server_ok
echo.
echo Local OK:  http://127.0.0.1:8080/
echo Open the URL above manually to confirm before sharing public link.
echo.
echo Starting Cloudflare tunnel. Copy the NEW https URL shown below.
echo Old trycloudflare links stop working after you close this window.
echo Press Ctrl+C to stop tunnel. Close Tanqi-Server window to stop game.
echo.

cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate
pause
