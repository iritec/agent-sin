"""Agent-Sin Skill (Python) - template

The entry point is run(ctx, input). Runtime provides:

  ctx.log.info(msg) / warn / error  : writes to logs/runs/<run-id>.json and events.jsonl
  ctx.memory.get(key) / set(key, v) : persists under skill.yaml memory.namespace
  ctx.ai.run(step_id, payload)      : calls an ai_steps entry declared in skill.yaml
  ctx.notify(args)                  : notifies Discord/Telegram/macOS/Mail/Slack/stderr (auto recommended)
  ctx.now()                         : returns the current time as an ISO8601 string

input format:
  {
    "args":    arguments validated by skill.yaml input.schema,
    "trigger": {"type": "manual", "id": ..., "time": "ISO8601"},
    "sources": {"workspace": ..., "notes_dir": ..., ...},
    "memory":  current ctx.memory snapshot,
  }

Return a SkillResult. outputs.<id> maps to outputs[id] in skill.yaml.
Runtime saves outputs, so the skill should not write files directly.
"""

from __future__ import annotations


def _locale(input):
    locale = str((input.get("sources", {}) or {}).get("locale") or "").lower()
    return "ja" if locale.startswith("ja") else "en"


def _t(input, en, ja):
    return ja if _locale(input) == "ja" else en


async def run(ctx, input):
    args = input.get("args", {})
    text = str(args.get("text", "")).strip()

    # Return status: skipped for empty input. Runtime logs it without saving outputs.
    if not text:
        return {
            "status": "skipped",
            "title": _t(input, "No input", "入力なし"),
            "summary": _t(input, "Skipped because text is empty.", "text が空のためスキップしました"),
            "outputs": {},
            "data": {},
            "suggestions": [],
        }

    # ctx.log also writes to events.jsonl, which is useful for debugging.
    ctx.log.info(f"example-skill: processing {len(text)} chars")

    # ctx.memory is persisted per namespace. Use it for small state such as run counts.
    # Reads can use the input["memory"] snapshot; writes use await ctx.memory.set.
    runs = int(input.get("memory", {}).get("runs", 0)) + 1
    await ctx.memory.set("runs", runs)

    timestamp = input.get("trigger", {}).get("time") or ctx.now()
    content = f"- {timestamp} {text}\n"

    # outputs.note maps to outputs[id=note] in skill.yaml. Runtime saves it by path/filename.
    return {
        "status": "ok",
        "title": _t(input, "Processed", "処理しました"),
        "summary": _t(input, f"Saved text (total {runs} run(s))", f"text を保存しました (累計 {runs} 回)"),
        "outputs": {
            "note": {
                "content": content,
                "frontmatter": {"tags": ["example"]},
            }
        },
        "data": {"length": len(text), "runs": runs},
        "suggestions": [],
    }
