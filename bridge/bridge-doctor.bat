@echo off
REM PixiJS GitHub Desktop Sync - bridge doctor (Windows)
REM v3.1.1 - CRLF + ASCII only. Kiem tra moi truoc khi chay bridge
REM va ghi bao cao ra bridge-doctor-report.txt (gui file do lai khi nho giup).
setlocal EnableDelayedExpansion
title PixiJS GitHub Bridge Doctor
cd /d "%~dp0"
if not defined BRIDGE_PORT set BRIDGE_PORT=17321
set REPORT=bridge-doctor-report.txt
echo PixiJS GitHub Bridge Doctor v3.1.1 - %DATE% %TIME% > "%REPORT%"
call :r "=== PixiJS GitHub Bridge Doctor v3.1.1 ==="
call :r "Ngay gio: %DATE% %TIME%"
call :r "Thu muc: %CD%"
call :r "Cong kiem tra: %BRIDGE_PORT%"
ver
ver >> "%REPORT%"
call :rblank
call :r "1. Node.js:"
where node >nul 2>nul
if errorlevel 1 goto :doc_no_node
for /f %%a in ('node -v') do set NODEVER=%%a
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  set NODEMAJOR=%%a
  set NODEMINOR=%%b
)
if not defined NODEMAJOR goto :doc_node_ver
if not defined NODEMINOR set NODEMINOR=0
call :r "   Node.js: %NODEVER%"
set NODEOLD=0
if %NODEMAJOR% LSS 16 set NODEOLD=1
if %NODEMAJOR% EQU 16 if %NODEMINOR% LSS 13 set NODEOLD=1
if "%NODEOLD%"=="1" (
  call :r "   [LOI] Node.js qua cu, can 16.13 tro len."
) else (
  call :r "   Node.js OK (16.13 tro len)."
)
goto :doc_after_node
:doc_no_node
call :r "   [LOI] Node.js KHONG co tren may nay."
call :r "   Cai Node.js 16.13 tro len tai https://nodejs.org/"
goto :doc_after_node
:doc_node_ver
call :r "   [LOI] Khong doc duoc phien ban Node.js."
:doc_after_node
call :rblank
call :r "2. File bridge-server.js:"
if exist bridge-server.js (
  call :r "   Tim thay bridge-server.js."
) else (
  call :r "   [LOI] Khong tim thay bridge-server.js - ban da giai nen day du thu muc bridge chua?"
)
call :rblank
call :r "3. File start-windows.bat:"
if exist start-windows.bat (
  call :r "   Tim thay start-windows.bat."
) else (
  call :r "   [LOI] Khong tim thay start-windows.bat."
)
call :rblank
call :r "4. Cong %BRIDGE_PORT%:"
netstat -ano | findstr /C:":%BRIDGE_PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto :doc_port_busy
call :r "   Cong %BRIDGE_PORT% dang trong."
goto :doc_after_port
:doc_port_busy
call :r "   Cong %BRIDGE_PORT% dang co chuong trinh nghe."
call :tryhealth
if "!HEALTH_OK!"=="1" (
  call :r "   /health tra loi OK - day la bridge dang chay."
) else (
  call :r "   /health KHONG tra loi - cong bi chuong trinh khac chiem."
)
:doc_after_port
call :rblank
call :r "5. Quyen ghi thu muc:"
echo doctor-write-test > "%CD%\doctor-write-test.tmp" 2>nul
if exist "%CD%\doctor-write-test.tmp" (
  del "%CD%\doctor-write-test.tmp" >nul 2>nul
  call :r "   Ghi file trong thu muc bridge: OK."
) else (
  call :r "   [LOI] Khong ghi duoc file trong thu muc bridge - thu chay bang quyen admin hoac doi thu muc khac."
)
call :rblank
call :r "6. Danh sach file trong thu muc bridge:"
dir /b
dir /b >> "%REPORT%"
call :rblank
call :r "Bao cao da ghi ra bridge-doctor-report.txt"
call :r "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 0

:tryhealth
set HEALTH_OK=0
set CODE=0
where curl >nul 2>nul
if not errorlevel 1 goto :tryhealth_curl
goto :tryhealth_ps
:tryhealth_curl
for /f %%c in ('curl.exe -s -o nul -w "%%{http_code}" http://127.0.0.1:%BRIDGE_PORT%/health 2^>nul') do set CODE=%%c
goto :tryhealth_done
:tryhealth_ps
for /f %%c in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%BRIDGE_PORT%/health -TimeoutSec 2).StatusCode } catch { 0 }" 2^>nul') do set CODE=%%c
:tryhealth_done
if "%CODE%"=="200" set HEALTH_OK=1
exit /b 0

:r
echo %~1
echo %~1 >> "%REPORT%"
exit /b 0

:rblank
echo.
echo.>> "%REPORT%"
exit /b 0
