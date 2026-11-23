@echo off
REM PixiJS GitHub Desktop Sync — bridge launcher (Windows)
REM Starts the local bridge on http://127.0.0.1:17321
REM Set BRIDGE_PORT to use another port, e.g.:
REM   set BRIDGE_PORT=17322
cd /d "%~dp0"
echo Starting PixiJS GitHub Bridge v2.0.0 ...
node bridge-server.js
pause
