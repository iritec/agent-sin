# Agent-Sin installer for Windows.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://<install-host>/install.ps1 | iex"
#
# Or after downloading:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Yes
#
# Equivalent of install.sh: installs the agent-sin command globally,
# runs `agent-sin setup`, and registers the Task Scheduler logon task.

[CmdletBinding()]
param(
  [switch]$Yes,
  [string]$Model,
  [string]$Builder,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$AppName = 'agent-sin'
$NpmPackage = if ($env:AGENT_SIN_NPM_PACKAGE) { $env:AGENT_SIN_NPM_PACKAGE } else { 'agent-sin' }
$MinNodeMajor = 22

function Use-Japanese {
  if ($env:AGENT_SIN_LOCALE -match '^ja') { return $true }
  if ($env:AGENT_SIN_LOCALE -match '^en') { return $false }
  $locale = if ($env:LC_ALL) { $env:LC_ALL } elseif ($env:LANG) { $env:LANG } else { [System.Globalization.CultureInfo]::CurrentUICulture.Name }
  return $locale -match '^ja'
}

function Msg([string]$En, [string]$Ja) {
  if (Use-Japanese) { $Ja } else { $En }
}

function Show-Usage {
if (Use-Japanese) {
@'
Agent-Sin installer (Windows)

使い方:
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://<install-host>/install.ps1 | iex"
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Yes] [-Model <id>] [-Builder <id>]

オプション:
  -Yes               setup をプロンプトなしで実行
  -Model <id>        agent-sin setup に既定モデルを渡す
  -Builder <id>      agent-sin setup に builder モデルを渡す
  -Help              このヘルプを表示

環境変数:
  AGENT_SIN_NPM_PACKAGE   インストールする npm package (既定: agent-sin)
'@
} else {
@'
Agent-Sin installer (Windows)

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://<install-host>/install.ps1 | iex"
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Yes] [-Model <id>] [-Builder <id>]

Options:
  -Yes               Run setup without prompts
  -Model <id>        Pass default model to agent-sin setup
  -Builder <id>      Pass builder model to agent-sin setup
  -Help              Show this help

Environment:
  AGENT_SIN_NPM_PACKAGE   npm package to install (default: agent-sin)
'@
}
}

if ($Help) {
  Show-Usage
  exit 0
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Error (Msg "agent-sin install: missing required command: $Name" "agent-sin install: 必要なコマンドが見つかりません: $Name")
    exit 1
  }
}

Require-Command 'node'
Require-Command 'npm'

$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt $MinNodeMajor) {
  Write-Error (Msg "agent-sin install: Node.js $MinNodeMajor or newer is required. Current: v$nodeVersion" "agent-sin install: Node.js $MinNodeMajor 以上が必要です。現在: v$nodeVersion")
  exit 1
}

Write-Host (Msg "agent-sin install: installing $NpmPackage globally..." "agent-sin install: $NpmPackage をグローバルインストールしています...")
& npm install -g $NpmPackage
if ($LASTEXITCODE -ne 0) {
  Write-Error (Msg "agent-sin install: npm install failed." "agent-sin install: npm install に失敗しました。")
  exit 1
}

if (-not (Get-Command $AppName -ErrorAction SilentlyContinue)) {
  Write-Warning (Msg "agent-sin install: installed, but '$AppName' is not on PATH." "agent-sin install: インストール済みですが '$AppName' が PATH にありません。")
  Write-Host (Msg "Check your npm global bin path with: npm bin -g" "npm bin -g で npm の global bin path を確認してください。")
  Write-Host (Msg "You may need to open a new PowerShell so PATH refreshes." "PATH を反映するには新しい PowerShell を開く必要がある場合があります。")
  exit 1
}

$setupArgs = New-Object System.Collections.Generic.List[string]
if ($Yes) { $setupArgs.Add('--yes') }
if ($Model) { $setupArgs.Add('--model'); $setupArgs.Add($Model) }
if ($Builder) { $setupArgs.Add('--builder'); $setupArgs.Add($Builder) }

Write-Host (Msg "agent-sin install: running setup..." "agent-sin install: setup を実行しています...")
& $AppName setup @setupArgs
if ($LASTEXITCODE -ne 0) {
  Write-Error (Msg "agent-sin install: setup failed." "agent-sin install: setup に失敗しました。")
  exit 1
}

Write-Host (Msg "agent-sin install: installing service..." "agent-sin install: service をインストールしています...")
& $AppName service install
if ($LASTEXITCODE -ne 0) {
  Write-Warning (Msg "agent-sin install: service install reported a non-zero exit. Run 'agent-sin service status' for details." "agent-sin install: service install が非ゼロで終了しました。詳細は 'agent-sin service status' を実行してください。")
}

Write-Host ''
Write-Host (Msg 'agent-sin install: ready' 'agent-sin install: 準備完了')
Write-Host (Msg 'Next: agent-sin service status' '次: agent-sin service status')
