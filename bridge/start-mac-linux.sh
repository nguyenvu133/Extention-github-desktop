#!/usr/bin/env sh
# PixiJS GitHub Desktop Sync - bridge launcher (macOS / Linux)
# Starts the local bridge on http://127.0.0.1:17321
# Set BRIDGE_PORT to use another port, e.g.:
#   BRIDGE_PORT=17322 ./start-mac-linux.sh
cd "$(dirname "$0")"
echo "Starting PixiJS GitHub Bridge v3.6.0 ..."
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[ERROR] Node.js chua duoc cai dat (Node.js is not installed)."
  echo "Cai Node.js 16.13+ tai https://nodejs.org/ roi chay lai file nay."
  echo ""
  # Keep the window open so the user can actually read the error
  # (double-clicking the script used to close the window at once).
  if [ -t 0 ]; then
    read -r -p "Nhan Enter de dong cua so... " _dummy
  fi
  exit 1
fi
echo "Neu cong 17321 da co bridge khac chay, cua so nay se bao 'Port 17321 is already in use' - chi can dung bridge dang chay do."
echo "Giu cua so nay mo trong luc dung extension."
node bridge-server.js
echo ""
echo "Bridge da dung. Dong cua so nay se tat bridge."
