@echo off
REM PixiJS GitHub Desktop Sync — bridge launcher (Windows)
REM Starts the local bridge on http://127.0.0.1:17321
REM Set BRIDGE_PORT to use another port, e.g.:
REM   set BRIDGE_PORT=17322
cd /d "%~dp0"
echo Starting PixiJS GitHub Bridge v3.0.1 ...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js chua duoc cai dat (Node.js is not installed).
  echo Cai Node.js 18+ tai https://nodejs.org/ roi chay lai file nay.
  echo.
  pause
  exit /b 1
)
echo Neu cong 17321 da co bridge khac chay, cua so nay se bao "Port 17321 is already in use" - chi can dung bridge dang chay do.
echo Giu cua so nay mo trong luc dung extension.
node bridge-server.js
echo.
echo Bridge da dung. Dong cua so nay se tat bridge.
pause
