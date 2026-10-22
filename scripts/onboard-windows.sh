#!/usr/bin/env bash
# Onboards a Windows machine as a spoke of this hub, from the hub, over SSH:
#
#   scripts/onboard-windows.sh <ssh host> <spoke name> [description...]
#
# What the machine needs first: an OpenSSH server with PowerShell as the
# default shell (Windows' own, `ssh <host>` landing in a PowerShell), Node 24
# and git on PATH, and a user who is an administrator (for the firewall
# rule). What this script does: copies the daemon, manager, UI and CLI trees
# as they are in these checkouts (HEAD), builds and installs them there as
# scheduled tasks in the user's interactive session (install.md 3c), installs
# Claude Code's native build if it is missing, writes the spoke into this
# hub's spokes.json with a fresh token, and reinstalls the hub's manager so
# it connects. Re-running updates everything and keeps the token.
#
# What is left for a person, printed at the end: log the user on at the
# machine's console (auto-logon keeps it so), and run `claude` there once to
# log in. The hub shows the host connected the moment the tasks are up.
set -euo pipefail
HOST="${1:?ssh host}"
NAME="${2:?spoke name}"
shift 2
DESC="${*:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECTS="$(dirname "$ROOT")"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/agent-manager"
SPOKES="$STATE/spokes.json"
for r in agent-daemon agent-manager agent-manager-ui agent-manager-cli; do
  [ -d "$PROJECTS/$r" ] || { echo "missing checkout $PROJECTS/$r" >&2; exit 1; }
done

# the token: kept per spoke beside spokes.json, reused on a re-run
mkdir -p "$STATE"
TOKEN_FILE="$STATE/spoke-$NAME.token"
if [ ! -s "$TOKEN_FILE" ]; then openssl rand -hex 32 > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; fi
TOKEN="$(cat "$TOKEN_FILE")"
ADMIN_FILE="$STATE/spoke-$NAME.admin"
if [ ! -s "$ADMIN_FILE" ]; then openssl rand -hex 12 > "$ADMIN_FILE"; chmod 600 "$ADMIN_FILE"; fi
ADMIN="$(cat "$ADMIN_FILE")"

echo "== $HOST: checking the machine"
REMOTE_USER="$(ssh -T -o ConnectTimeout=15 "$HOST" 'node --version; git --version; $env:USERNAME; ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)' | tr -d '\r')"
echo "$REMOTE_USER" | sed 's/^/   /'
USERNAME="$(echo "$REMOTE_USER" | sed -n 3p)"
ADDR="$(ssh -G "$HOST" | awk '/^hostname /{print $2}')"

echo "== copying the four trees"
for r in agent-daemon agent-manager agent-manager-ui agent-manager-cli; do
  git -C "$PROJECTS/$r" archive --format=tar.gz --prefix="$r/" HEAD > "/tmp/onboard-$r.tgz"
done
scp -q /tmp/onboard-agent-daemon.tgz /tmp/onboard-agent-manager.tgz /tmp/onboard-agent-manager-ui.tgz /tmp/onboard-agent-manager-cli.tgz "$HOST:" 
rm -f /tmp/onboard-agent-*.tgz

echo "== installing on $HOST (this takes a few minutes: npm ci four times, three builds)"
# A script file rather than a long -c line: PowerShell quoting over ssh is a trap.
cat > /tmp/onboard-remote.ps1 <<PS
\$ErrorActionPreference = 'Stop'
\$base = Join-Path \$env:USERPROFILE 'agent'
New-Item -ItemType Directory -Force \$base | Out-Null
foreach (\$r in 'agent-daemon','agent-manager','agent-manager-ui','agent-manager-cli') {
  \$tgz = Join-Path \$env:USERPROFILE "onboard-\$r.tgz"
  # keep node_modules across re-runs: replace everything else
  Get-ChildItem (Join-Path \$base \$r) -ErrorAction SilentlyContinue | Where-Object { \$_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force
  tar -xzf \$tgz -C \$base
  Remove-Item \$tgz
  Push-Location (Join-Path \$base \$r)
  # through cmd, so npm's stderr (deprecation notes) stays text rather than becoming PowerShell error records;
  # no install scripts: the native modules ship prebuilt binaries, and a compile needs build tools
  cmd /c "npm ci --no-audit --no-fund --ignore-scripts 2>&1" | Select-Object -Last 1 | Out-String | Write-Host
  if (\$LASTEXITCODE) { throw "npm ci failed in \$r" }
  Pop-Location
}
if (-not (Test-Path "\$env:USERPROFILE\\.local\\bin\\claude.exe")) {
  Write-Host '== installing Claude Code (native)'
  irm https://claude.ai/install.ps1 | iex | Out-Null
}
Push-Location (Join-Path \$base 'agent-daemon');     powershell -ExecutionPolicy Bypass -File scripts\\install-windows.ps1 | Out-String | Write-Host; Pop-Location
Push-Location (Join-Path \$base 'agent-manager-ui'); cmd /c "npm run build 2>&1" | Select-Object -Last 1 | Out-String | Write-Host; if (\$LASTEXITCODE) { throw 'UI build failed' }; Pop-Location
Push-Location (Join-Path \$base 'agent-manager');    powershell -ExecutionPolicy Bypass -File scripts\\install-windows.ps1 -AdminPassword '$ADMIN' -HubToken '$TOKEN' -HostName '$NAME' | Out-String | Write-Host; Pop-Location
Push-Location (Join-Path \$base 'agent-manager-cli'); powershell -ExecutionPolicy Bypass -File scripts\\install-windows.ps1 | Out-String | Write-Host; Pop-Location
Get-ScheduledTask agent-daemon, agent-manager | Select-Object TaskName, State | Format-Table -HideTableHeaders | Out-String | Write-Host
cmd /c "query user 2>nul" | Out-String | Write-Host
PS
scp -q /tmp/onboard-remote.ps1 "$HOST:onboard-remote.ps1"
rm -f /tmp/onboard-remote.ps1
# the remote script's own exit code decides; the cleanup after it must not mask it
ssh -T "$HOST" 'powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\onboard-remote.ps1"; $rc = $LASTEXITCODE; Remove-Item "$env:USERPROFILE\onboard-remote.ps1"; exit $rc' | tr -d '\r' | sed 's/^/   /'

echo "== registering the spoke on this hub"
python3 - "$SPOKES" "$NAME" "http://$ADDR:4268" "$TOKEN" "$DESC" <<'PY'
import json, os, sys
file, name, url, token, desc = sys.argv[1:6]
spokes = []
if os.path.exists(file):
    with open(file) as f: spokes = json.load(f)
spokes = [s for s in spokes if s.get('name') != name]
entry = {'name': name, 'url': url, 'token': token}
if desc: entry['description'] = desc
spokes.append(entry)
with open(file, 'w') as f: json.dump(spokes, f, indent=2); f.write('\n')
os.chmod(file, 0o600)
print(f"   {name} -> {url}")
PY
(cd "$ROOT" && npm run install:service >/dev/null 2>&1) && echo "   hub manager reinstalled"
sleep 8
curl -s http://127.0.0.1:4268/api/health | python3 -c "import sys,json; hs=[h for h in json.load(sys.stdin)['hosts'] if h['name']=='$NAME']; print('   hub sees:', hs[0] if hs else 'nothing yet')"

cat <<MSG

Left for a person, on $HOST's console:
  1. log $USERNAME on at the console; for a VM, set auto-logon (Sysinternals Autologon keeps the
     password as an LSA secret). The two tasks start within seconds of logon.
  2. run \`claude\` once there and log in.
Then the hub's /api/health shows $NAME with daemon: true, and an agent of any project here can run
on it: am new <project> <name> --host $NAME --cwd <a path there>.
The spoke's own admin password is in $ADMIN_FILE, its token in $TOKEN_FILE (both mode 600).
MSG
