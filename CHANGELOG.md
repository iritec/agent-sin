## Changelog

Release history of `agent-sin`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Entry types:

- **Added** — new features
- **Changed** — changes to existing behavior (backwards-compatible)
- **Deprecated** — features to be removed in the next major release
- **Removed** — breaking changes
- **Fixed** — bug fixes
- **Security** — security fixes

See the [compatibility policy](https://agent.shingoirie.com/versioning) for details.

---

## [0.1.2] — 2026-05-14

### Fixed

- `agent-sin setup` no longer writes `defaults.locale` into `config.toml`. The locale is now resolved fresh on every run from `AGENT_SIN_LOCALE` or the OS-level Intl locale. This prevents a stale `locale = "ja"` from being pinned at first setup (for example via `curl ... install.sh | bash` on a Mac whose shell still inherits `LANG=ja_JP.UTF-8`) and surviving subsequent re-installs.
  - Existing workspaces with the wrong locale: remove the `locale` line from `~/.agent-sin/config.toml`, or run with `AGENT_SIN_LOCALE=en`. `sed -i '' '/^locale = /d' ~/.agent-sin/config.toml` works on macOS.

---

## [0.1.1] — 2026-05-14

### Fixed

- Locale auto-detection now prefers the OS-level system locale (Intl) over the shell's `LANG`/`LC_ALL`. A Mac switched to English in System Settings could still inherit `LANG=ja_JP.UTF-8` from a stale shell environment, which persisted `locale = "ja"` into `config.toml` on first setup and pinned the UI to Japanese.
  - If you already have a workspace with the wrong locale, remove the `locale` line from `~/.agent-sin/config.toml` and rerun, or start with `AGENT_SIN_LOCALE=en agent-sin ...`.

### Changed

- Windows installer one-liner now runs through `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm … | iex"` so the default execution policy does not block the install.

---

## [0.1.0] — 2026-05-14

### Added

- Initial public release. `agent-sin` CLI, skill runtimes (Python / TypeScript), Discord bot, Builder mode, built-in skills, Codex / OpenAI / Gemini / Claude Code provider integrations, and the local memory / index / scheduler foundation.
- Telegram bot integration (`src/telegram/`). The same chat / build / intent routing used by Discord is now available on Telegram.
- Discord attachment ingestion (text / images) and a detail mode for build progress.
- Profile memory (`soul.md` / `user.md` / `memory.md`) with automatic promotion of daily notes (`daily-memory-promotion`).
- `profile-save` built-in skill.
- `install.sh` for one-shot setup.
- Windows install guidance uses a one-run PowerShell execution-policy bypass, so default script policy does not block first install.
- Compatibility policy ([versioning](https://agent.shingoirie.com/versioning)) and this changelog.

### Changed

- Removed the fixed "started working" announcement when entering build mode. Outside detail mode, no progress message is sent — the agent stays quiet.
- Build progress on Discord / Telegram is shown in detail only when `AGENT_SIN_DISCORD_PROGRESS_DETAIL=1` / `AGENT_SIN_TELEGRAM_PROGRESS_DETAIL=1` is set, or `progress_detail=true` is configured in the runtime settings.
