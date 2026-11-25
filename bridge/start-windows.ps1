# PixiJS GitHub Desktop Sync - bridge launcher (Windows, PowerShell)
# v3.7.1 - Phuong an 2 khi start-windows.bat bi SmartScreen hoac
# antivirus chan. Cach chay: chuot phai file -> Run with PowerShell,
# hoac mo PowerShell roi go:
#   powershell -ExecutionPolicy Bypass -File .\start-windows.ps1
# Neu PowerShell bao loi ve ExecutionPolicy, dung lenh tren (Bypass).
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
if (-not $env:BRIDGE_PORT) { $env:BRIDGE_PORT = '17321' }
$port = $env:BRIDGE_PORT
$log = Join-Path $PSScriptRoot 'bridge-start.log'

function Write-Log($msg) {
  Write-Host $msg
  Add-Content -Path $log -Value $msg
}
function Write-Blank {
  Write-Host ''
  Add-Content -Path $log -Value ''
}
function Fail($msg) {
  Write-Blank
  Write-Log "[LOI] $msg"
  Write-Log 'Nhan Enter de dong cua so nay.'
  Read-Host | Out-Null
  exit 1
}

Write-Log '=== PixiJS GitHub Bridge v3.7.1 (PowerShell) ==='
Write-Log "Thu muc bridge: $PSScriptRoot"
Write-Log "Cong: $port"
Write-Blank
Write-Log '[1/5] Kiem tra Node.js...'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Blank
  Write-Log '[LOI] Node.js chua duoc cai dat tren may nay.'
  Write-Log 'Cach sua: cai Node.js 12.0 tro len tai https://nodejs.org/'
  Write-Log 'Sau khi cai xong, dong cua so nay va chay lai start-windows.ps1'
  Write-Log 'Nhan Enter de dong cua so nay.'
  Read-Host | Out-Null
  exit 1
}
$nodeVer = (node -v).Trim()
$major = 0
if ($nodeVer -match '^v(\d+)\.') { $major = [int]$Matches[1] }
if ($major -eq 0) {
  Fail 'Khong doc duoc phien ban Node.js (node -v khong tra ve ket qua). Cai lai Node.js 12.0 tro len tai https://nodejs.org/ roi chay lai file nay.'
}
$minor = 0
if ($nodeVer -match '^v\d+\.(\d+)\.') { $minor = [int]$Matches[1] }
if ($major -lt 12) {
  Fail "Node.js qua cu: $nodeVer - bridge can Node.js 12.0 tro len. Cai Node.js 12.0 tro len tai https://nodejs.org/ roi chay lai file nay."
}
Write-Log "Node.js OK: $nodeVer"
Write-Blank
Write-Log '[2/5] Kiem tra file bridge-server.js...'
if (-not (Test-Path 'bridge-server.js')) {
  Fail 'Khong tim thay file bridge-server.js trong thu muc nay. Ban da giai nen day du thu muc bridge chua? Dung chay file rieng le. Giai nen toan bo file ZIP ra mot thu muc, roi chay lai start-windows.ps1'
}
Write-Log 'Tim thay bridge-server.js.'
Write-Blank
Write-Log "[3/5] Kiem tra cong $port..."
$already = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
  if ($r.StatusCode -eq 200) { $already = $true }
} catch {}
if ($already) {
  Write-Blank
  Write-Log "Bridge da chay san o cong $port - dung luon, khong can chay lai."
  Write-Log 'Mo extension len, den phai chuyen xanh.'
  Write-Log 'Nhan Enter de dong cua so nay.'
  Read-Host | Out-Null
  exit 0
}
$tcpBusy = $false
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $ar = $tcp.BeginConnect('127.0.0.1', [int]$port, $null, $null)
  if ($ar.AsyncWaitHandle.WaitOne(1000)) { $tcp.EndConnect($ar); $tcpBusy = $true }
  $tcp.Close()
} catch {}
if ($tcpBusy) {
  Fail "Cong $port bi chiem boi chuong trinh khac, khong phai bridge. Tat chuong trinh do, hoac chay bridge o cong khac: `$env:BRIDGE_PORT=17322; .\start-windows.ps1"
}
Write-Log "Cong $port dang trong."
Write-Blank
Write-Log '[4/5] Dang khoi dong bridge...'
Write-Log "Bridge se chay o http://127.0.0.1:$port"
Start-Process cmd.exe -ArgumentList '/c "node bridge-server.js >> bridge-start.log 2>&1"' -NoNewWindow -WorkingDirectory $PSScriptRoot
Write-Log '[5/5] Doi bridge tra loi /health (toi da 10 lan thu)...'
$ok = $false
for ($i = 1; $i -le 10; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}
if (-not $ok) {
  Fail 'Bridge da khoi dong nhung khong tra loi /health sau 10 lan thu. Mo file bridge-start.log xem loi cuoi cung, roi gui file do lai de duoc giup.'
}
Write-Blank
Write-Log "Bridge da chay: http://127.0.0.1:$port"
$tokenLine = Select-String -Path $log -Pattern 'TOKEN:' | Select-Object -Last 1
if ($tokenLine) { Write-Host $tokenLine.Line }
Write-Log 'Buoc tiep theo: mo Chrome, mo extension, dan TOKEN o tren vao o Bridge token neu chua dan, den phai xanh.'
Write-Log 'Sau do bam CONNECT GITHUB de dang nhap bang tai khoan GitHub that.'
Write-Log 'Giu cua so nay mo trong luc dung extension. Dong cua so se tat bridge.'
Write-Blank
Write-Log 'Nhan Enter de dong cua so nay.'
Read-Host | Out-Null
exit 0
