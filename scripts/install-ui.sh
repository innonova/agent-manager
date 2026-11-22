#!/usr/bin/env bash
# Deploys a UI build without touching the manager process: swaps the static
# directory the installed manager serves (~/.local/lib/agent-manager/ui) for
# ../agent-manager-ui/dist. Express reads files per request, so the new build
# is live at once; open tabs offer a reload when they next check build.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${AGENT_MANAGER_INSTALL_DIR:-$HOME/.local/lib/agent-manager}"
# Which of the two: `ui`, served at /, or `ui-next`, the UI being built for
# streams, served under /next/ (npm run install:ui-next).
UI_NAME="${AGENT_MANAGER_UI_NAME:-ui}"
case "$UI_NAME" in
  ui) UI_REPO=agent-manager-ui ;;
  ui-next) UI_REPO=agent-streams-ui ;;
  *) echo "AGENT_MANAGER_UI_NAME is ui or ui-next, not $UI_NAME" >&2; exit 1 ;;
esac
UI_DIST="${AGENT_MANAGER_UI_DIST:-$ROOT/../$UI_REPO/dist}"

if [ ! -e "$UI_DIST/index.html" ]; then
  echo "no UI build at $UI_DIST (run npm run build in $UI_REPO first)" >&2
  exit 1
fi
if [ ! -d "$INSTALL_DIR/dist" ]; then
  echo "no manager installed at $INSTALL_DIR (run npm run install:service first)" >&2
  exit 1
fi
rm -rf "$INSTALL_DIR/$UI_NAME.new"
cp -r "$UI_DIST" "$INSTALL_DIR/$UI_NAME.new"
rm -rf "$INSTALL_DIR/$UI_NAME.old"
[ -d "$INSTALL_DIR/$UI_NAME" ] && mv "$INSTALL_DIR/$UI_NAME" "$INSTALL_DIR/$UI_NAME.old"
mv "$INSTALL_DIR/$UI_NAME.new" "$INSTALL_DIR/$UI_NAME"
rm -rf "$INSTALL_DIR/$UI_NAME.old"
echo "installed $UI_NAME from $UI_DIST ($(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$INSTALL_DIR/$UI_NAME/build.json" 2>/dev/null)); manager not restarted"
