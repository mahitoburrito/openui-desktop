#!/bin/zsh
# Swap the freshly packed OpenUI.app into release-staged and relaunch.
# Run this OUTSIDE OpenUI (Terminal.app or double-click in Finder) —
# it quits OpenUI, which ends any in-app agent sessions.
set -e

ROOT="$HOME/Downloads/openui-desktop"
FRESH="$ROOT/release/mac-arm64/OpenUI.app"
STAGED_DIR="$ROOT/release-staged/mac-arm64"

[ -d "$FRESH" ] || { echo "No packed app at $FRESH — run 'npm run pack' first."; exit 1; }

echo "Quitting OpenUI…"
osascript -e 'quit app "OpenUI"' 2>/dev/null || true
sleep 2

echo "Backing up current staged app…"
BACKUP="$STAGED_DIR/OpenUI.backup-$(date +%Y%m%d-%H%M%S).app"
[ -d "$STAGED_DIR/OpenUI.app" ] && mv "$STAGED_DIR/OpenUI.app" "$BACKUP" && echo "  → $BACKUP"

echo "Installing fresh build…"
cp -R "$FRESH" "$STAGED_DIR/OpenUI.app"

echo "Relaunching…"
open "$STAGED_DIR/OpenUI.app"
echo "Done."
