#!/usr/bin/env bash
# Builds the manager, copies a production install to ~/.local/lib/agent-manager
# (with the UI build from ../agent-manager-ui/dist if present), makes sure the
# daemon has the `fake` profile, and installs + (re)starts the systemd user
# service. Restarting the manager does not affect running agents.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${AGENT_MANAGER_INSTALL_DIR:-$HOME/.local/lib/agent-manager}"
UI_DIST="${AGENT_MANAGER_UI_DIST:-$ROOT/../agent-manager-ui/dist}"
DAEMON_CONFIG_DIR="${AGENT_DAEMON_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-daemon}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE="$(command -v node)"

echo "building in $ROOT"
(cd "$ROOT" && npm run build >/dev/null)

echo "installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/fixtures"
cp -r "$ROOT/dist" "$ROOT/fixtures" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/harness.md" "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 && npm rebuild better-sqlite3 argon2 >/dev/null 2>&1)
if [ -e "$UI_DIST/index.html" ]; then
  rm -rf "$INSTALL_DIR/ui"
  cp -r "$UI_DIST" "$INSTALL_DIR/ui"
  echo "installed UI from $UI_DIST"
else
  echo "no UI build at $UI_DIST; API only (build agent-manager-ui and re-run)"
fi

# The harness note every agent gets at session start: the shipped text is
# seeded into the config directory once; an edited copy is never overwritten.
HARNESS="${AGENT_MANAGER_HARNESS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-manager/harness.md}"
if [ ! -e "$HARNESS" ]; then
  mkdir -p "$(dirname "$HARNESS")"
  cp "$ROOT/harness.md" "$HARNESS"
  echo "harness note seeded at $HARNESS"
elif ! cmp -s "$ROOT/harness.md" "$HARNESS"; then
  echo "harness note at $HARNESS differs from the shipped one (kept; the UI's harness page shows both)"
fi

# The fake profile lets the UI be used without spending tokens.
mkdir -p "$DAEMON_CONFIG_DIR/profiles"
FAKE="$DAEMON_CONFIG_DIR/profiles/fake.json"
printf '{\n  "description": "fake agent for development and tests (agent-manager)",\n  "command": "%s",\n  "args": ["%s/fixtures/fake-agent.mjs"]\n}\n' "$NODE" "$INSTALL_DIR" > "$FAKE"
systemctl --user reload agent-daemon 2>/dev/null && echo "daemon profiles reloaded" || echo "note: agent-daemon not running; profile written to $FAKE"

mkdir -p "$UNIT_DIR"
sed -e "s#@NODE@#$NODE#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" -e "s#@PATH@#$PATH#g" \
  "$ROOT/systemd/agent-manager.service" > "$UNIT_DIR/agent-manager.service"
if [ -n "${AGENT_MANAGER_ADMIN_PASSWORD:-}" ]; then
  mkdir -p "$UNIT_DIR/agent-manager.service.d"
  # systemd Environment= quoting: backslash and double quote are escaped, % is doubled (specifier syntax).
  ESCAPED="$(printf '%s' "$AGENT_MANAGER_ADMIN_PASSWORD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
  printf '[Service]\nEnvironment="AGENT_MANAGER_ADMIN_PASSWORD=%s"\n' "$ESCAPED" > "$UNIT_DIR/agent-manager.service.d/admin.conf"
  chmod 600 "$UNIT_DIR/agent-manager.service.d/admin.conf"
fi
if [ -n "${AGENT_MANAGER_HUB_TOKEN:-}" ]; then
  # Lets a hub (another manager) act here with this token; kept out of the unit file like the admin password.
  mkdir -p "$UNIT_DIR/agent-manager.service.d"
  ESCAPED="$(printf '%s' "$AGENT_MANAGER_HUB_TOKEN" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
  printf '[Service]\nEnvironment="AGENT_MANAGER_HUB_TOKEN=%s"\n' "$ESCAPED" > "$UNIT_DIR/agent-manager.service.d/hub.conf"
  chmod 600 "$UNIT_DIR/agent-manager.service.d/hub.conf"
fi
if [ -n "${AGENT_MANAGER_HOST_NAME:-}" ]; then
  mkdir -p "$UNIT_DIR/agent-manager.service.d"
  printf '[Service]\nEnvironment="AGENT_MANAGER_HOST_NAME=%s"\n' "$AGENT_MANAGER_HOST_NAME" > "$UNIT_DIR/agent-manager.service.d/host.conf"
fi
echo "installed unit $UNIT_DIR/agent-manager.service"

systemctl --user daemon-reload
systemctl --user enable agent-manager.service >/dev/null 2>&1 || true
systemctl --user restart agent-manager.service
sleep 1
systemctl --user --no-pager --lines=3 status agent-manager.service || true
echo
echo "add a user with:   npm run user:add -- <name>"
echo "logs with:         journalctl --user -u agent-manager -f"
