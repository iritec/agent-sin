<p align="center">
  <img src="assets/logo.png" alt="Agent-Sin logo" width="120">
</p>

<h1 align="center">Agent-Sin</h1>

<p align="center">
  A safer, more reliable<br>
  <strong>program-driven personal AI agent.</strong>
</p>

<p align="center">
  <a href="https://agent.shingoirie.com?lang=en">Website</a> ·
  <a href="https://agent.shingoirie.com/overview?lang=en">Docs</a> ·
  <a href="https://agent.shingoirie.com/getting-started?lang=en">Quick Start</a>
</p>

---

Agent-Sin freezes daily work into small **Program Skills** instead of letting an LLM reinterpret every task. Conversation is handled by an LLM at the entrance; execution is delegated to verified programs.

> Design inspired by [openclaw/openclaw](https://github.com/openclaw/openclaw).

## Why program-driven

|  | Traditional AI agent | Agent-Sin |
|---|---|---|
| Execution | LLM follows steps every time | Runs pre-built programs |
| Speed | Bound to inference latency | Fast program execution |
| Stability | Output drifts run to run | Same input, same behavior |
| Cost | Charged per LLM call | No LLM cost for skill runs |
| Safety | Unexpected actions are possible | Only registered actions run |

When a new capability is needed, Build Mode uses Claude Code or Codex to generate a skill. After that it runs the same way — fast, cheap, and predictable.

## Highlights

- **Conversation Mode and Build Mode** — daily chat stays minimum-privilege; elevated permissions kick in only while authoring or editing a skill.
- **Multi-channel** — talk to the same agent from terminal, Discord, or Telegram.
- **Flexible notifications** — OS, Discord, Telegram, Slack, and email.
- **Free model mix** — pick a light model for chat and a stronger one for skill authoring.
- **Always-on gateway** — starts at login and bundles the scheduler with the Discord / Telegram bots.
- **Long-term memory** — agent persona, your profile, and daily context persist across sessions.

## Install

Requires Node.js 22+ and Python 3. Works on macOS, Linux, and Windows.

**macOS / Linux**

```bash
curl -fsSL https://agent.shingoirie.com/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://agent.shingoirie.com/install.ps1 | iex
```

The installer sets up `agent-sin`, runs initial setup, and registers a login service. Workspace data lives in `~/.agent-sin/`.

Full walkthrough: [Getting Started](https://agent.shingoirie.com/getting-started?lang=en).

## Documentation

- [Overview](https://agent.shingoirie.com/overview?lang=en) — the big picture
- [Getting Started](https://agent.shingoirie.com/getting-started?lang=en) — install to first conversation
- [Concepts](https://agent.shingoirie.com/concepts?lang=en) — design and Runtime
- [Skill Authoring](https://agent.shingoirie.com/skill-authoring?lang=en) — write your own skill
- [Built-in Skills](https://agent.shingoirie.com/built-in-skills?lang=en) — bundled skills
- [CLI Reference](https://agent.shingoirie.com/cli?lang=en) — every command
- [Configuration](https://agent.shingoirie.com/configuration?lang=en) — settings and API keys
- [Gateway & Ops](https://agent.shingoirie.com/operations?lang=en) — always-on, schedules, notifications, backup
- [Discord](https://agent.shingoirie.com/discord?lang=en) · [Telegram](https://agent.shingoirie.com/telegram?lang=en) — channel integrations
- [Versioning](https://agent.shingoirie.com/versioning?lang=en) — compatibility and release policy
- [Changelog](CHANGELOG.md) — release history

## Also by the author

[**KingCoding**](https://kingcode.shingoirie.com/en) — Claude Code and Codex, in one simple UI. A Mac app that unifies the two coding agents, runs tasks hands-free in King Mode, and lets you check progress from your phone.

## License

MIT
