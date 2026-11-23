@echo off
REM PixiJS GitHub Desktop Sync - bridge launcher (Windows)
REM v3.1.0 - CRLF + ASCII only. cmd.exe expects CRLF line endings;
REM a UTF-8 / LF-only .bat can be misparsed, so the window flashes
REM and closes without showing the error. Keep this file ASCII + CRLF.
setlocal EnableDelayedExpansion
title PixiJS GitHub Bridge
cd /d "%~dp0"
if not defined BRIDGE_PORT set BRIDGE_PORT=17321
set LOG=bridge-start.log
call :log "=== PixiJS GitHub Bridge v3.1.0 ==="
call :log "Thu muc bridge: %CD%"
call :log "Cong: %BRIDGE_PORT%"
call :logblank
call :log "[1/5] Kiem tra Node.js..."
where node >nul 2>nul
if errorlevel 1 goto :err_no_node
for /f %%a in ('node -v') do set NODEVER=%%a
REM v3.1.0: "v16.13.0" with delims "v." -> token 1 = 16 (major), token 2 = 13.
REM (v3.0.2 read token 2, i.e. the MINOR number, so Node 22.11 looked "too old".)
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  set NODEMAJOR=%%a
  set NODEMINOR=%%b
)
if not defined NODEMAJOR goto :err_node_ver
if not defined NODEMINOR set NODEMINOR=0
if %NODEMAJOR% LSS 16 goto :err_node_old
if %NODEMAJOR% EQU 16 if %NODEMINOR% LSS 13 goto :err_node_old
call :log "Node.js OK: %NODEVER%"
call :logblank
call :log "[2/5] Kiem tra file bridge-server.js..."
if not exist bridge-server.js goto :err_no_file
call :log "Tim thay bridge-server.js."
call :logblank
call :log "[3/5] Kiem tra cong %BRIDGE_PORT%..."
netstat -ano | findstr /C:":%BRIDGE_PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto :port_busy
call :log "Cong %BRIDGE_PORT% dang trong."
call :logblank
call :log "[4/5] Dang khoi dong bridge..."
call :log "Bridge se chay o http://127.0.0.1:%BRIDGE_PORT%"
start "PixiJS GitHub Bridge" /b cmd /c "node bridge-server.js >> bridge-start.log 2>&1"
call :log "[5/5] Doi bridge tra loi /health (toi da 10 lan thu)..."
set HEALTH_OK=0
for /L %%i in (1,1,10) do (
  call :tryhealth
  if "!HEALTH_OK!"=="1" goto :health_ok
  timeout /t 1 /nobreak >nul
)
goto :err_health

:health_ok
call :logblank
call :log "Bridge da chay: http://127.0.0.1:%BRIDGE_PORT%"
set LASTTOKEN=
for /f "tokens=*" %%t in ('findstr /C:"TOKEN:" "%LOG%"') do set LASTTOKEN=%%t
if defined LASTTOKEN echo %LASTTOKEN%
call :log "Buoc tiep theo: mo Chrome, mo extension, dan TOKEN o tren vao o Bridge token neu chua dan, den phai xanh."
call :log "Sau do bam CONNECT GITHUB de dang nhap bang tai khoan GitHub that."
call :log "Giu cua so nay mo trong luc dung extension. Dong cua so se tat bridge."
call :logblank
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 0

:port_busy
call :logblank
call :log "[CANH BAO] Cong %BRIDGE_PORT% da co chuong trinh khac dang nghe."
call :tryhealth
if "%HEALTH_OK%"=="1" goto :already_running
call :log "[LOI] Cong %BRIDGE_PORT% bi chiem boi chuong trinh khac, khong phai bridge."
call :log "Cach sua: tat chuong trinh do, hoac chay bridge o cong khac:"
call :log "  set BRIDGE_PORT=17322"
call :log "  start-windows.bat"
call :log "Xem chi tiet trong bridge-start.log"
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 1

:already_running
call :log "Bridge da chay san o cong %BRIDGE_PORT% - dung luon, khong can chay lai."
call :log "Mo extension len, den phai chuyen xanh."
call :logblank
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 0

:err_no_node
call :logblank
call :log "[LOI] Node.js chua duoc cai dat tren may nay."
call :log "Cach sua: cai Node.js 16.13 tro len tai https://nodejs.org/"
call :log "Sau khi cai xong, dong cua so nay va chay lai start-windows.bat"
call :log "Kiem tra: mo cmd roi go: node -v"
call :log "Xem chi tiet trong bridge-start.log"
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 1

:err_node_ver
call :logblank
call :log "[LOI] Khong doc duoc phien ban Node.js (node -v khong tra ve ket qua)."
call :log "Cai lai Node.js 16.13 tro len tai https://nodejs.org/ roi chay lai file nay."
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 1

:err_node_old
call :logblank
call :log "[LOI] Node.js qua cu: %NODEVER% - bridge can Node.js 16.13 tro len."
call :log "Cach sua: cai Node.js 16.13 tro len tai https://nodejs.org/"
call :log "Sau khi cai xong, dong cua so nay va chay lai start-windows.bat"
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 1

:err_no_file
call :logblank
call :log "[LOI] Khong tim thay file bridge-server.js trong thu muc nay."
call :log "Ban da giai nen day du thu muc bridge chua? Dung chay file .bat rieng le."
call :log "Cach sua: giai nen toan bo file ZIP ra mot thu muc, roi chay lai:"
call :log "  bridge\start-windows.bat"
call :log "Xem chi tiet trong bridge-start.log"
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 1

:err_health
call :logblank
call :log "[LOI] Bridge da khoi dong nhung khong tra loi /health sau 10 lan thu."
call :log "Mo file bridge-start.log xem loi cuoi cung, roi gui file do lai de duoc giup."
call :log "Co the do cong %BRIDGE_PORT% bi chuong trinh khac chiem, hoac Node.js loi."
call :log "Nhan phim bat ky de dong cua so nay."
pause >nul
exit /b 1

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

:log
echo %~1
echo %~1 >> "%LOG%"
exit /b 0

:logblank
echo.
echo.>> "%LOG%"
exit /b 0
