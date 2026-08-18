#!/bin/zsh
# Install the freshly packed OpenUI.app (July 6 build) from
# ~/openui-desktop/release-next/mac-arm64 into /Applications and relaunch.
# Runs in Terminal.app so it survives OpenUI quitting.
set -e

FRESH="$HOME/openui-desktop/release-next/mac-arm64/OpenUI.app"
LIVE="/Applications/OpenUI.app"

[ -d "$FRESH" ] || { echo "No packed app at $FRESH"; exit 1; }

echo "Swapping in the July 6 build — OpenUI will quit in 10 seconds…"
sleep 10

echo "Quitting OpenUI…"
osascript -e 'quit app "OpenUI"' 2>/dev/null || true

# Wait for it to fully exit (up to 20s), then force if needed
for i in {1..20}; do
  pgrep -xq OpenUI || break
  sleep 1
done
pgrep -xq OpenUI && { echo "Force-quitting…"; pkill -x OpenUI; sleep 2; }

echo "Backing up current app…"
BACKUP="/Applications/OpenUI.backup-$(date +%Y%m%d-%H%M%S).app"
[ -d "$LIVE" ] && mv "$LIVE" "$BACKUP" && echo "  → $BACKUP"

echo "Installing fresh build…"
if ! mv "$FRESH" "$LIVE" 2>/dev/null; then
  ditto "$FRESH" "$LIVE"
fi

echo "Relaunching…"
open "$LIVE"
echo "Done — OpenUI is now the July 6 build. You can close this Terminal window."
