@echo off
REM bridge\unregister-native-host.bat - v3.6.0 - CRLF + ASCII only.
REM Go dang ky Native Messaging host (Windows + Chrome).
REM Xoa registry key + file manifest da sinh (neu co).
setlocal
cd /d "%~dp0"
set "HOST_NAME=com.pixijs.github.bridge"
set "MANIFEST=%~dp0native-host-manifest.json"

echo === Go dang ky Native Messaging host (PixiJS GitHub Bridge) ===
echo.
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
if errorlevel 1 (
  echo Registry key khong ton tai hoac da duoc xoa truoc do.
) else (
  echo Da xoa registry key.
)
if exist "%MANIFEST%" (
  del "%MANIFEST%"
  echo Da xoa %MANIFEST%
) else (
  echo Khong co file manifest de xoa.
)
echo.
echo Xong. Extension se khong mo duoc bridge bang 1 nut bam nua.
echo (Chay lai bridge\register-native-host.bat de dang ky lai.)
echo.
pause
endlocal
exit /b 0
