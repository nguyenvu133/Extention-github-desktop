#!/usr/bin/env sh
# PixiJS GitHub Desktop Sync — bridge launcher (macOS / Linux)
# Starts the local bridge on http://127.0.0.1:17321
# Set BRIDGE_PORT to use another port, e.g.:
#   BRIDGE_PORT=17322 ./start-mac-linux.sh
cd "$(dirname "$0")"
echo "Starting PixiJS GitHub Bridge v2.0.0 ..."
node bridge-server.js
