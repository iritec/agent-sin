#!/usr/bin/env bash
set -euo pipefail

APP_NAME="agent-sin"
NPM_PACKAGE="${AGENT_SIN_NPM_PACKAGE:-agent-sin}"
MIN_NODE_MAJOR=22

setup_args=()

locale_is_ja() {
  case "${AGENT_SIN_LOCALE:-}" in
    ja|ja_*) return 0 ;;
    en|en_*) return 1 ;;
  esac
  case "${LC_ALL:-${LANG:-}}" in
    ja*|JA*) return 0 ;;
    *) return 1 ;;
  esac
}

msg() {
  if locale_is_ja; then
    printf '%s\n' "$2"
  else
    printf '%s\n' "$1"
  fi
}

usage() {
  if locale_is_ja; then
    cat <<'EOF'
Agent-Sin installer

使い方:
  curl -fsSL https://<install-host>/install.sh | bash
  curl -fsSL https://<install-host>/install.sh | bash -s -- --yes

agent-sin コマンドをインストールし、setup を実行してログインサービスを登録します。

オプション:
  --yes, --defaults, --no-input  setup をプロンプトなしで実行
  --model <id>                   agent-sin setup に既定モデルを渡す
  --builder <id>                 agent-sin setup に builder モデルを渡す
  --help                         このヘルプを表示

環境変数:
  AGENT_SIN_NPM_PACKAGE          インストールする npm package (既定: agent-sin)
EOF
  else
    cat <<'EOF'
Agent-Sin installer

Usage:
  curl -fsSL https://<install-host>/install.sh | bash
  curl -fsSL https://<install-host>/install.sh | bash -s -- --yes

Installs the agent-sin command, runs setup, and registers the login service.

Options:
  --yes, --defaults, --no-input  Run setup without prompts
  --model <id>                   Pass default model to agent-sin setup
  --builder <id>                 Pass builder model to agent-sin setup
  --help                         Show this help

Environment:
  AGENT_SIN_NPM_PACKAGE          npm package to install (default: agent-sin)
EOF
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --yes|--defaults|--no-input)
      setup_args+=("$1")
      shift
      ;;
    --model|--builder)
      if [[ $# -lt 2 ]]; then
        msg "agent-sin install: $1 requires a value" "agent-sin install: $1 には値が必要です" >&2
        exit 1
      fi
      setup_args+=("$1" "$2")
      shift 2
      ;;
    *)
      msg "agent-sin install: unknown option: $1" "agent-sin install: 不明なオプションです: $1" >&2
      msg "Run with --help for usage." "--help で使い方を確認してください。" >&2
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    msg "agent-sin install: missing required command: $1" "agent-sin install: 必要なコマンドが見つかりません: $1" >&2
    return 1
  fi
}

need_cmd node
need_cmd npm

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$node_major" -lt "$MIN_NODE_MAJOR" ]]; then
  msg "agent-sin install: Node.js $MIN_NODE_MAJOR or newer is required. Current: $(node -v)" "agent-sin install: Node.js $MIN_NODE_MAJOR 以上が必要です。現在: $(node -v)" >&2
  exit 1
fi

msg "agent-sin install: installing $NPM_PACKAGE globally..." "agent-sin install: $NPM_PACKAGE をグローバルインストールしています..."
npm install -g "$NPM_PACKAGE"

if ! command -v "$APP_NAME" >/dev/null 2>&1; then
  msg "agent-sin install: installed, but '$APP_NAME' is not on PATH." "agent-sin install: インストール済みですが '$APP_NAME' が PATH にありません。" >&2
  msg "Check your npm global bin path with: npm bin -g" "npm bin -g で npm の global bin path を確認してください。" >&2
  exit 1
fi

msg "agent-sin install: running setup..." "agent-sin install: setup を実行しています..."
"$APP_NAME" setup "${setup_args[@]}"

msg "agent-sin install: installing service..." "agent-sin install: service をインストールしています..."
"$APP_NAME" service install

echo ""
msg "agent-sin install: ready" "agent-sin install: 準備完了"
msg "Next: agent-sin service status" "次: agent-sin service status"
