#!/bin/sh
# bridge/register-native-host.sh - Register the Native Messaging host
# once (macOS / Linux + Chrome). v3.6.0 - LF + ASCII only.
#
# Usage:
#   1. Open Chrome, go to chrome://extensions, enable "Developer mode".
#   2. Copy the Extension ID (32 chars, e.g. abcdefghijklmnopabcdefghijklmnop).
#   3. Run:  sh bridge/register-native-host.sh
#      (or:  ./bridge/register-native-host.sh)
#      and paste the Extension ID when asked.
#
# This script:
#   - Writes ~/.config/google-chrome/NativeMessagingHosts/com.pixijs.github.bridge.json
#     (absolute path to native-host.js + your real extension ID)
#   - The generated manifest is local-only (gitignored, never pushed).
# For Chromium instead of Chrome, copy the same file to
# ~/.config/chromium/NativeMessagingHosts/ afterwards.
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.pixijs.github.bridge"
HOSTJS="$DIR/native-host.js"
MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
MANIFEST="$MANIFEST_DIR/$HOST_NAME.json"

echo "=== Register Native Messaging host (PixiJS GitHub Bridge) ==="
echo ""
if [ ! -f "$HOSTJS" ]; then
  echo "[ERROR] native-host.js not found in $DIR."
  echo "Did you extract the full bridge/ folder? Do not run this script alone."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed."
  echo "Install Node.js 16.13+ from https://nodejs.org/ and run this script again."
  exit 1
fi
chmod +x "$HOSTJS"

printf 'Extension ID from chrome://extensions (enable "Developer mode" first): '
read -r EXTID
case "$EXTID" in
  *[!a-p]*|'')
    echo ""
    echo "[ERROR] Invalid Extension ID."
    echo "The ID must be exactly 32 chars a-p (e.g. abcdefghijklmnopabcdefghijklmnop)."
    exit 1
    ;;
esac
if [ "${#EXTID}" -ne 32 ]; then
  echo ""
  echo "[ERROR] Invalid Extension ID: must be exactly 32 characters (got ${#EXTID})."
  exit 1
fi

echo ""
echo "Writing manifest: $MANIFEST"
mkdir -p "$MANIFEST_DIR"
# The host path has no backslashes on Mac/Linux, so plain printf is safe.
{
  printf '{\n'
  printf '  "name": "com.pixijs.github.bridge",\n'
  printf '  "description": "PixiJS GitHub Bridge native host (one-click bridge start)",\n'
  printf '  "path": "%s",\n' "$HOSTJS"
  printf '  "type": "stdio",\n'
  printf '  "allowed_origins": [\n'
  printf '    "chrome-extension://%s/"\n' "$EXTID"
  printf '  ]\n'
  printf '}\n'
} > "$MANIFEST"

echo ""
echo "=== DONE ==="
echo "Host name: $HOST_NAME"
echo "Manifest:  $MANIFEST"
echo ""
echo "Verify:"
echo "  1. cat \"$MANIFEST\""
echo "     Check \"path\" points at native-host.js and \"allowed_origins\""
echo "     has your Extension ID."
echo "  2. Quit Chrome completely, then reopen it."
echo "  3. Open the extension and click the start-bridge button - the"
echo "     lamp should turn green without running start-mac-linux.sh by hand."
echo ""
echo "If you reinstall the extension (new ID), run this script again."
echo "To unregister, delete $MANIFEST"
echo " (and the key is gone - no registry on Mac/Linux)."
