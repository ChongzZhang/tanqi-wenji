@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo Tanqi Online - Local Server
echo Dir: %ROOT%
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
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

start "Tanqi-Server" /D "%ROOT%server" cmd /k "set BIND_HOST=0.0.0.0&& node server.js"

echo Waiting for server...
set WAIT_COUNT=0
:wait_loop
set /a WAIT_COUNT+=1
curl.exe -s -m 2 http://127.0.0.1:8080/api/health 2>nul | findstr /C:"\"ok\":true" >nul 2>&1
if not errorlevel 1 goto server_ok
if %WAIT_COUNT% geq 25 goto server_fail
timeout /t 1 /nobreak >nul
goto wait_loop

:server_fail
echo [ERROR] Server did not start. Check Tanqi-Server window.
pause
exit /b 1

:server_ok
echo Server ready.
echo.
echo Local:  http://127.0.0.1:8080/
echo LAN:    http://^<your-IP^>:8080/
echo WS:     ws://127.0.0.1:8080/ws
echo.
echo Open the URL above in your browser manually.
echo For public play run serve-public.bat
echo.
pause
