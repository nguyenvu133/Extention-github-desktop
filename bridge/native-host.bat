@echo off
REM PixiJS GitHub Bridge - Native Messaging host wrapper (Windows)
REM v3.6.0 - CRLF + ASCII only.
REM Chrome native messaging "path" must point at an executable file,
REM and a .js file cannot run directly, so the manifest points here
REM and this wrapper hands over to Node.
REM stdout is reserved for the native messaging protocol - never echo here.
node "%~dp0native-host.js"
