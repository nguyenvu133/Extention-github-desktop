@echo off
REM bridge\register-native-host.bat - v3.6.0 - CRLF + ASCII only.
REM Dang ky Native Messaging host 1 lan duy nhat (Windows + Chrome).
REM Sau buoc nay, extension co the mo bridge bang 1 nut bam
REM (khong can mo start-windows.bat bang tay nua).
REM
REM Cach dung:
REM   1. Mo Chrome, vao chrome://extensions, bat "Developer mode".
REM   2. Copy Extension ID (32 ky tu, vd abcdefghijklmnopabcdefghijklmnop).
REM   3. Double-click file nay, dan Extension ID vao khi duoc hoi.
REM
REM File nay se:
REM   - Sinh bridge\native-host-manifest.json (duong dan tuyet doi + ID that)
REM   - Ghi HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pixijs.github.bridge
REM     tro toi file manifest do.
REM Manifest that KHONG duoc day len GitHub (.gitignore da chan).
setlocal
cd /d "%~dp0"
set "HOST_NAME=com.pixijs.github.bridge"
set "MANIFEST=%~dp0native-host-manifest.json"
set "HOSTBAT=%~dp0native-host.bat"
set "HOSTJS=%~dp0native-host.js"

echo === Dang ky Native Messaging host (PixiJS GitHub Bridge) ===
echo.
if not exist "%HOSTJS%" goto :err_no_host
if not exist "%HOSTBAT%" goto :err_no_host

where node >nul 2>nul
if errorlevel 1 goto :err_no_node

echo Lay Extension ID tu chrome://extensions
echo (bat "Developer mode", copy ID 32 ky tu cua extension).
echo.
set "EXTID="
set /p "EXTID=Extension ID: "
if "%EXTID%"=="" goto :err_bad_id
powershell -NoProfile -Command "if ($env:EXTID -notmatch '^[a-p]{32}$') { exit 1 }"
if errorlevel 1 goto :err_bad_id

echo.
echo Dang sinh manifest: %MANIFEST%
powershell -NoProfile -Command "$o = [ordered]@{ name='com.pixijs.github.bridge'; description='PixiJS GitHub Bridge native host (one-click bridge start)'; path=$env:HOSTBAT; type='stdio'; allowed_origins=@('chrome-extension://' + $env:EXTID + '/') }; ($o | ConvertTo-Json) | Out-File -Encoding ascii -FilePath $env:MANIFEST"
if errorlevel 1 goto :err_manifest
if not exist "%MANIFEST%" goto :err_manifest

echo Dang ghi registry...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 goto :err_reg

echo.
echo === XONG ===
echo Host name: %HOST_NAME%
echo Manifest:  %MANIFEST%
echo Registry:  HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%
echo.
echo Kiem chung:
echo   1. Mo cmd roi go:
echo        reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
echo      Phai thay duong dan manifest o tren.
echo   2. Mo file manifest bang Notepad, kiem tra "path" tro toi
echo      native-host.bat va "allowed_origins" chua dung Extension ID.
echo   3. Tat het cua so Chrome (thoat han), mo lai Chrome.
echo   4. Mo extension, bam nut mo bridge - den phai chuyen xanh
echo      ma khong can chay start-windows.bat bang tay.
echo.
echo Neu doi Extension ID (cai lai extension), chay lai file nay.
echo De go dang ky, chay bridge\unregister-native-host.bat.
echo.
pause
endlocal
exit /b 0

:err_no_host
echo.
echo [LOI] Khong tim thay native-host.js / native-host.bat trong thu muc nay.
echo Ban da giai nen day du thu muc bridge chua? Dung chay file .bat rieng le.
echo Nhan phim bat ky de dong cua so nay.
pause >nul
endlocal
exit /b 1

:err_no_node
echo.
echo [LOI] Node.js chua duoc cai dat tren may nay.
echo Cai Node.js 16.13 tro len tai https://nodejs.org/ roi chay lai file nay.
echo Nhan phim bat ky de dong cua so nay.
pause >nul
endlocal
exit /b 1

:err_bad_id
echo.
echo [LOI] Extension ID khong hop le.
echo ID phai gom dung 32 ky tu a-p (vd: abcdefghijklmnopabcdefghijklmnop).
echo Lay ID tu chrome://extensions (bat "Developer mode" truoc).
echo Nhan phim bat ky de dong cua so nay.
pause >nul
endlocal
exit /b 1

:err_manifest
echo.
echo [LOI] Khong sinh duoc file manifest.
echo Kiem tra quyen ghi trong thu muc bridge roi chay lai file nay.
echo Nhan phim bat ky de dong cua so nay.
pause >nul
endlocal
exit /b 1

:err_reg
echo.
echo [LOI] Khong ghi duoc registry.
echo Thu chay file nay bang "Run as administrator" roi thu lai.
echo Nhan phim bat ky de dong cua so nay.
pause >nul
endlocal
exit /b 1
