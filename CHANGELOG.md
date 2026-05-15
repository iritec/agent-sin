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

## [0.1.12] — 2026-05-15

### Added

- `/memo` slash command on Discord (`add` / `list` / `delete`), plus a new built-in `memo-list` skill that backs it.

### Fixed

- Telegram replies no longer leak internal `skill-call` / `agent-sin-build-suggestion` fence blocks. Both the live draft preview and the final sent message now strip these control blocks, including malformed variants where the language tag ends up on its own line.
- Chat skill invocation is more tolerant of malformed `skill-call` blocks, and exact read-only triggers such as `todolist` run without waiting for the model to format a call.

---

## [0.1.11] — 2026-05-14

### Fixed

- The interactive startup banner now uses a plain `AGENT-SIN` wordmark on Windows. The previous half-block terminal logo could render slightly misaligned in Windows Terminal depending on font and line-height settings.

---

## [0.1.10] — 2026-05-14

### Fixed

- Update notifications now compare full semver versions correctly. Previously `0.1.6` and `0.1.9` were treated as equal because only the major segment was compared, so `agent-sin start` could miss an available update even when `update-check.json` already had the newer version.

---

## [0.1.9] — 2026-05-14

### Fixed

- The `.env` permission warning ("permissions 666 ... are too open; recommend: chmod 600") no longer fires on Windows. POSIX-style mode bits are not meaningful on Windows (every file reports 0o666), so the check is skipped there.

---

## [0.1.8] — 2026-05-14

### Fixed

- Update notification on `agent-sin start` / `agent-sin chat` was being emitted *before* the ascii startup banner, so on small terminals it scrolled out of view. The notification now renders *after* the startup banner, with a blank line of separation, so it is always visible at the bottom of the welcome area.

---

## [0.1.7] — 2026-05-14

### Fixed

- `agent-sin import` now rewrites absolute paths inside the restored `config.toml` (and legacy `config.yaml`) so the imported workspace points at the current machine's `~/.agent-sin` instead of the source machine's. Previously, restoring a backup on a different user account failed with `EACCES: permission denied, mkdir '/Users/<source>'`.

---

## [0.1.6] — 2026-05-14

### Fixed

- On Windows, launching the Codex CLI (and Claude Code CLI) failed with `spawn codex ENOENT` because Node's `spawn` cannot resolve the `.cmd` shim that npm-installed CLIs use on Windows. Both the one-shot CLI bridge and the long-running `codex app-server` now enable `shell: true` only on `win32`, so the shim is found correctly. POSIX paths still use direct exec.

---

## [0.1.5] — 2026-05-14

### Changed

- The interactive CLI (`agent-sin start` / `agent-sin chat`) now hits the npm registry on every startup instead of trusting the 24-hour cache, so new releases are surfaced immediately. Background paths (gateway, mid-conversation polls) still use the cache.

---

## [0.1.4] — 2026-05-14

### Added

- `agent-sin --version` / `-v` / `agent-sin version` now print the installed version. Previously these printed an "unknown command" error.

### Fixed

- Update-notifier now refreshes its cache when the installed version has caught up to or passed the previously cached "latest". Previously, after upgrading to the cached latest, the cache stayed valid for 24 hours and hid the banner for the next release. The CLI also fetches synchronously (with a short timeout) on the very first run so the banner appears immediately when a new version is available.

---

## [0.1.3] — 2026-05-14

### Added

- The long-running `agent-sin gateway` (the launchd / Task Scheduler service) now self-detects upgrades. Every 5 minutes it re-reads its own `package.json` version, and if it differs from the version it started with, it exits gracefully so launchd / Task Scheduler restarts it on the new code. This means `npm i -g agent-sin@latest` is enough — no manual `service restart` is required.

### Fixed

- The CLI banner used to print a hard-coded `v0.1.0` because the version string was inlined. It now reads `package.json` at runtime, so the displayed version always matches the installed one.

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
