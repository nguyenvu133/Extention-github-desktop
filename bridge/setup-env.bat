@echo off
REM bridge\setup-env.bat - v3.5.1 - CRLF + ASCII only.
REM Tao bridge\.env mot lan duy nhat (Windows).
REM Hoi 3 gia tri (PAT GitHub, OAuth Client ID, OAuth Client Secret) +
REM duong dan repo mac dinh, roi ghi vao bridge\.env.
REM Chay: double-click file nay trong thu muc bridge, hoac
REM   bridge\setup-env.bat
REM Sau do chay bridge nhu binh thuong - no tu doc .env, khong can dan
REM lai gi trong dashboard nua.
setlocal
cd /d "%~dp0"
set "ENV_FILE=.env"
if exist "%ENV_FILE%" (
  echo bridge\.env da co. Ghi de se XOA cau hinh cu.
  set /p "OVERWRITE=Ghi de? (y/N): "
  if /i not "%OVERWRITE%"=="y" (
    echo Huy - giu nguyen bridge\.env cu.
    goto :done
  )
)
echo === Tao bridge\.env (chi chay 1 lan) ===
echo De trong neu khong co gia tri do (co the dien sau).
echo Chu y: khong bao gio gui file .env cho ai, khong day len GitHub.
set /p "PAT=GitHub PAT (ghp_... hoac github_pat_...): "
set /p "CID=OAuth Client ID (vd Ov23...): "
set /p "CSEC=OAuth Client Secret: "
set /p "REPO=Duong dan repo mac dinh (vd C:\Users\ban\MyRepo, de trong neu chua co): "
REM Sinh bridge token on dinh (64 ky hex) bang PowerShell; neu loi thi de trong.
set "BTOKEN="
for /f "delims=" %%T in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')" 2^>nul') do set "BTOKEN=%%T"
if "%BTOKEN%"=="" (
  echo Khong sinh duoc bridge token - bridge se tu sinh va luu vao .bridge-token.
)
(
  echo # bridge/.env - TU DONG TAO BOI setup-env.bat. KHONG DAY LEN GITHUB.
  echo # Chi may nay duoc doc file nay. Ai co file nay se dang nhap GitHub duoc nhu ban.
  echo BRIDGE_TOKEN=%BTOKEN%
  echo BRIDGE_PORT=17321
  echo GITHUB_PAT=%PAT%
  echo GITHUB_OAUTH_CLIENT_ID=%CID%
  echo GITHUB_OAUTH_CLIENT_SECRET=%CSEC%
  echo DEFAULT_REPO_PATH=%REPO%
) > "%ENV_FILE%"
echo.
echo Xong: bridge\.env da duoc tao.
if not "%BTOKEN%"=="" (
  echo Bridge token cua ban (dan 1 lan vao extension, muc LOCAL BRIDGE):
  echo %BTOKEN%
)
echo Bay gio chay bridge nhu binh thuong - no tu dang nhap GitHub tu .env.
:done
pause
endlocal
exit /b 0
