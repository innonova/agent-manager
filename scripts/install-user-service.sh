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

# The harness note every agent gets at session start. The config copy is
# what runs; the shipped text goes there when there is no copy, or when the
# copy is still the text the previous install shipped (unchanged by the
# operator: the previous shipped text is the one in the install dir, read
# before it is replaced below). An edited copy is kept and pointed out.
# The models file rides along on the same terms: the house view of which
# model suits which work, rendered into every note at {{models}}.
seed_config_file() {
  local what="$1" src="$2" target="$3"
  if [ ! -e "$target" ]; then
    mkdir -p "$(dirname "$target")"
    cp "$src" "$target"
    echo "$what seeded at $target"
  elif cmp -s "$src" "$target"; then
    : # already the shipped text
  elif [ -e "$INSTALL_DIR/$(basename "$src")" ] && cmp -s "$INSTALL_DIR/$(basename "$src")" "$target"; then
    cp "$src" "$target"
    echo "$what updated at $target (it was the previously shipped text, unchanged)"
  else
    echo "$what at $target is edited; kept (the UI shows the shipped text too)"
  fi
}

HARNESS="${AGENT_MANAGER_HARNESS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-manager/harness.md}"
MODELS="${AGENT_MANAGER_MODELS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-manager/models.md}"
seed_config_file "harness note" "$ROOT/harness.md" "$HARNESS"
seed_config_file "models file" "$ROOT/models.md" "$MODELS"

rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/fixtures"
cp -r "$ROOT/dist" "$ROOT/fixtures" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/harness.md" "$ROOT/models.md" "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 && npm rebuild better-sqlite3 argon2 >/dev/null 2>&1)
if [ -e "$UI_DIST/index.html" ]; then
  rm -rf "$INSTALL_DIR/ui"
  cp -r "$UI_DIST" "$INSTALL_DIR/ui"
  echo "installed UI from $UI_DIST"
else
  echo "no UI build at $UI_DIST; API only (build agent-manager-ui and re-run)"
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
