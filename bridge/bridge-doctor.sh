#!/usr/bin/env sh
# PixiJS GitHub Desktop Sync - bridge doctor (macOS / Linux)
# v3.6.0 - Kiem tra moi truoc khi chay bridge va ghi bao cao ra
# bridge-doctor-report.txt (gui file do lai khi nho giup).
cd "$(dirname "$0")"
PORT="${BRIDGE_PORT:-17321}"
REPORT="bridge-doctor-report.txt"
{
echo "=== PixiJS GitHub Bridge Doctor v3.6.0 ==="
echo "Ngay gio: $(date)"
echo "Thu muc: $(pwd)"
echo "He dieu hanh: $(uname -s) $(uname -r)"
echo "Cong kiem tra: $PORT"
echo ""
echo "1. Node.js:"
if command -v node >/dev/null 2>&1; then
  echo "   Node.js: $(node -v)"
  MAJOR=$(node -v 2>/dev/null | tr -dc '0-9.' | cut -d. -f1)
  MINOR=$(node -v 2>/dev/null | tr -dc '0-9.' | cut -d. -f2)
  [ -z "$MINOR" ] && MINOR=0
  if [ -z "$MAJOR" ]; then
    echo "   [LOI] Khong doc duoc phien ban Node.js."
  elif [ "$MAJOR" -lt 16 ] || { [ "$MAJOR" -eq 16 ] && [ "$MINOR" -lt 13 ]; }; then
    echo "   [LOI] Node.js qua cu, can 16.13 tro len."
  else
    echo "   Node.js OK (16.13 tro len)."
  fi
else
  echo "   [LOI] Node.js KHONG co tren may nay."
  echo "   Cai Node.js 16.13 tro len tai https://nodejs.org/"
fi
echo ""
echo "2. File bridge-server.js:"
if [ -f bridge-server.js ]; then
  echo "   Tim thay bridge-server.js."
else
  echo "   [LOI] Khong tim thay bridge-server.js - ban da giai nen day du thu muc bridge chua?"
fi
echo ""
echo "3. File start-mac-linux.sh:"
if [ -f start-mac-linux.sh ]; then
  echo "   Tim thay start-mac-linux.sh."
else
  echo "   [LOI] Khong tim thay start-mac-linux.sh."
fi
echo ""
echo "4. Cong $PORT:"
if curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q "^200$"; then
  echo "   /health tra loi OK - bridge dang chay."
else
  echo "   /health KHONG tra loi - bridge chua chay (hoac cong bi chiem)."
fi
echo ""
echo "5. Quyen ghi thu muc:"
if echo doctor-write-test > doctor-write-test.tmp 2>/dev/null; then
  rm -f doctor-write-test.tmp
  echo "   Ghi file trong thu muc bridge: OK."
else
  echo "   [LOI] Khong ghi duoc file trong thu muc bridge."
fi
echo ""
echo "6. Danh sach file trong thu muc bridge:"
ls -1
echo ""
echo "Bao cao da ghi ra bridge-doctor-report.txt"
} | tee "$REPORT"
echo ""
echo "Nhan Enter de dong cua so..."
if [ -t 0 ]; then
  read -r _dummy
fi
