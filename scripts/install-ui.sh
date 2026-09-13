#!/usr/bin/env bash
# Deploys a UI build without touching the manager process: swaps the static
# directory the installed manager serves (~/.local/lib/agent-manager/ui) for
# ../agent-manager-ui/dist. Express reads files per request, so the new build
# is live at once; open tabs offer a reload when they next check build.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${AGENT_MANAGER_INSTALL_DIR:-$HOME/.local/lib/agent-manager}"
UI_DIST="${AGENT_MANAGER_UI_DIST:-$ROOT/../agent-manager-ui/dist}"

if [ ! -e "$UI_DIST/index.html" ]; then
  echo "no UI build at $UI_DIST (run npm run build in agent-manager-ui first)" >&2
  exit 1
fi
if [ ! -d "$INSTALL_DIR/dist" ]; then
  echo "no manager installed at $INSTALL_DIR (run npm run install:service first)" >&2
  exit 1
fi
rm -rf "$INSTALL_DIR/ui.new"
cp -r "$UI_DIST" "$INSTALL_DIR/ui.new"
rm -rf "$INSTALL_DIR/ui.old"
[ -d "$INSTALL_DIR/ui" ] && mv "$INSTALL_DIR/ui" "$INSTALL_DIR/ui.old"
mv "$INSTALL_DIR/ui.new" "$INSTALL_DIR/ui"
rm -rf "$INSTALL_DIR/ui.old"
echo "installed UI from $UI_DIST ($(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$INSTALL_DIR/ui/build.json")); manager not restarted"
