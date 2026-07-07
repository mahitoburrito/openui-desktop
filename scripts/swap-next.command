#!/bin/zsh
# Swap the freshly packed OpenUI.app from release-next/ into release/mac-arm64
# (the copy you actually launch) and relaunch.
# Run this OUTSIDE OpenUI (Terminal.app or double-click in Finder) —
# it quits OpenUI, which ends any in-app agent sessions.
set -e

ROOT="$HOME/Downloads/openui-desktop"
FRESH="$ROOT/release-next/mac-arm64/OpenUI.app"
LIVE_DIR="$ROOT/release/mac-arm64"

[ -d "$FRESH" ] || { echo "No packed app at $FRESH — run 'npx electron-builder --dir -c.directories.output=release-next' first."; exit 1; }

echo "Quitting OpenUI…"
osascript -e 'quit app "OpenUI"' 2>/dev/null || true
sleep 2

echo "Backing up current live app…"
BACKUP="$LIVE_DIR/OpenUI.backup-$(date +%Y%m%d-%H%M%S).app"
[ -d "$LIVE_DIR/OpenUI.app" ] && mv "$LIVE_DIR/OpenUI.app" "$BACKUP" && echo "  → $BACKUP"

echo "Installing fresh build…"
mv "$FRESH" "$LIVE_DIR/OpenUI.app"

echo "Relaunching…"
open "$LIVE_DIR/OpenUI.app"
echo "Done."
