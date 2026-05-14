## CHANGELOG

agent-sin のリリース履歴。形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) ベース、バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従う。

エントリ種別:

- **Added** — 新機能
- **Changed** — 既存挙動の変更（互換維持）
- **Deprecated** — 廃止予定（次メジャーで削除）
- **Removed** — 削除（破壊的変更）
- **Fixed** — バグ修正
- **Security** — セキュリティ修正

互換性ポリシーは [公式ドキュメント](https://agent.shingoirie.com/versioning) を参照。

---

## [Unreleased]

### Added

- Telegram bot 連携（`src/telegram/`）。Discord と同じ chat / build / intent ルーティングを Telegram でも利用可能に。
- Discord 添付ファイル取り込み（テキスト/画像）と、ビルド進捗の detail モード。
- profile memory（`soul.md` / `user.md` / `memory.md`）と日次メモの自動昇格（`daily-memory-promotion`）。
- `profile-save` ビルトインスキル。
- `install.sh` によるセットアップ補助。
- 互換性ポリシー（[versioning](https://agent.shingoirie.com/versioning)）と CHANGELOG。

### Changed

- ビルドモード進入時の固定文言「作業を開始しました」を廃止し、detail モード以外は進捗メッセージを送らない静かな挙動に変更。
- Discord/Telegram のビルド進捗は `AGENT_SIN_DISCORD_PROGRESS_DETAIL=1` / `AGENT_SIN_TELEGRAM_PROGRESS_DETAIL=1` または runtime 設定の `progress_detail=true` でのみ詳細表示。

### Deprecated

- なし

### Removed

- なし

---

## [0.1.0] — 2026-04-26

### Added

- 初回リリース。`agent-sin` CLI、スキル ランタイム（Python / TypeScript）、Discord bot、Builder モード、ビルトインスキル、Codex / OpenAI / Gemini / Claude Code プロバイダ統合、ローカルメモリ／インデックス／スケジューラの基盤。
