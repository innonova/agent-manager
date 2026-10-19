# Installs the manager on Windows as a scheduled task at the user's logon,
# beside the daemon's (see agent-daemon/scripts/install-windows.ps1): builds,
# copies a production install to %LOCALAPPDATA%\agent-manager\lib (with the
# UI build from ..\agent-manager-ui\dist if present), writes the fake profile
# into the daemon, registers the task "agent-manager" and starts it if the
# user is logged on. Re-running updates the install and restarts the task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 `
#     -AdminPassword 'choose one' -HubToken '<shared secret>' -HostName win
#
# -Listen defaults to 0.0.0.0:4268 and the script opens that port in the
# Windows firewall when run as an administrator (a spoke must be reachable
# from the hub). The settings are kept in %LOCALAPPDATA%\agent-manager\lib\env.cmd,
# readable by this user only, like the systemd drop-ins on Linux.
param(
  [string]$AdminPassword = '',
  [string]$HubToken = '',
  [string]$HostName = '',
  [string]$Listen = '0.0.0.0:4268',
  [string]$UiDist = ''
)
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$Lib    = Join-Path $env:LOCALAPPDATA 'agent-manager\lib'
$State  = Join-Path $env:LOCALAPPDATA 'agent-manager'
$DaemonConfig = Join-Path $env:APPDATA 'agent-daemon'
$Node   = (Get-Command node).Source
$Task   = 'agent-manager'
if ($UiDist -eq '') { $UiDist = Join-Path $Root '..\agent-manager-ui\dist' }

Write-Host "building in $Root"
Push-Location $Root
try { npm run build | Out-Null } finally { Pop-Location }

New-Item -ItemType Directory -Force $Lib, $State, (Join-Path $DaemonConfig 'profiles') | Out-Null
foreach ($d in 'dist', 'fixtures', 'ui') { Remove-Item -Recurse -Force (Join-Path $Lib $d) -ErrorAction SilentlyContinue }
Copy-Item -Recurse (Join-Path $Root 'dist'), (Join-Path $Root 'fixtures') $Lib
Copy-Item (Join-Path $Root 'package.json'), (Join-Path $Root 'package-lock.json') $Lib
Push-Location $Lib
try {
  npm ci --omit=dev --ignore-scripts | Out-Null
  # the two native modules fetch their prebuilt binaries in their install
  # scripts; npm 11.16+ runs no install script it has not been told to allow
  npm approve-scripts better-sqlite3 argon2 2>$null | Out-Null
  npm rebuild better-sqlite3 argon2 | Out-Null
} finally { Pop-Location }
if (Test-Path $UiDist) { Copy-Item -Recurse $UiDist (Join-Path $Lib 'ui'); Write-Host "UI from $UiDist" }
else { Write-Warning "no UI build at $UiDist; API only (build agent-manager-ui and re-run)" }

# the fake profile lets the UI be used without spending tokens
$fake = @{ description = 'fake agent for development and tests (agent-manager)'; command = $Node; args = @("$Lib\fixtures\fake-agent.mjs") }
$fake | ConvertTo-Json | Set-Content -Path (Join-Path $DaemonConfig 'profiles\fake.json') -Encoding UTF8

$Log = Join-Path $State 'manager.log'
$Env = Join-Path $Lib 'env.cmd'
$lines = @('@echo off', "set AGENT_MANAGER_LISTEN=$Listen", "set AGENT_MANAGER_UI_DIR=$Lib\ui", 'set ELECTRON_RUN_AS_NODE=', "set PATH=$env:USERPROFILE\.local\bin;$env:PATH")
if ($AdminPassword -ne '') { $lines += "set AGENT_MANAGER_ADMIN_PASSWORD=$AdminPassword" }
if ($HubToken -ne '')      { $lines += "set AGENT_MANAGER_HUB_TOKEN=$HubToken" }
if ($HostName -ne '')      { $lines += "set AGENT_MANAGER_HOST_NAME=$HostName" }
$lines | Set-Content -Path $Env -Encoding ASCII
# this user only: the file holds credentials
icacls $Env /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null
$Cmd = Join-Path $Lib 'run.cmd'
@('@echo off', "call `"$Env`"", "`"$Node`" `"$Lib\dist\main.js`" >> `"$Log`" 2>&1") | Set-Content -Path $Cmd -Encoding ASCII
$Vbs = Join-Path $Lib 'run.vbs'
"CreateObject(""WScript.Shell"").Run """"""$Cmd"""""", 0, False" | Set-Content -Path $Vbs -Encoding ASCII

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Vbs`"" -WorkingDirectory $Lib
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT5S' # after the daemon's task
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*agent-manager\lib\dist\main.js*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false
}
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'agent-manager: projects, agents and the UI on top of agent-daemon' | Out-Null
Write-Host "registered scheduled task $Task (at logon of $env:USERNAME, interactive)"

$port = [int]($Listen -split ':')[-1]
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  if (-not (Get-NetFirewallRule -DisplayName "agent-manager $port" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "agent-manager $port" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
    Write-Host "firewall: inbound TCP $port allowed"
  }
} else { Write-Warning "not an administrator: open inbound TCP $port in the firewall yourself if a hub must reach this machine" }

$sessions = cmd /c "query user 2>nul"
$loggedOn = ($sessions | Out-String) -match "(?m)^\s*>?$env:USERNAME\s"
if ($loggedOn) {
  Start-ScheduledTask -TaskName $Task
  Start-Sleep -Seconds 4
  try { (Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing).Content } catch { Write-Warning "no answer on :$port yet; see $Log" }
} else {
  Write-Warning "$env:USERNAME is not logged on at the console; the task starts at the next logon"
}
Write-Host "log: $Log"
