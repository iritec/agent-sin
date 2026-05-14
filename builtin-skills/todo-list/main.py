"""Builtin: todo-list

memory.todo namespace の ToDo を一覧表示する。
status=open(default) / done / all で絞り込める。

入力:
  args.status: open | done | all (default: open)
出力:
  data.items: 該当ToDoの配列
  data.counts: { open, done, total }
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    status = str(args.get("status", "open")).strip() or "open"

    items = list((await ctx.memory.get("items")) or [])
    open_items = [i for i in items if i.get("status") == "open"]
    done_items = [i for i in items if i.get("status") == "done"]
    if status == "open":
        shown = open_items
    elif status == "done":
        shown = done_items
    else:
        shown = items

    counts = {"open": len(open_items), "done": len(done_items), "total": len(items)}

    if not shown:
        if status == "open":
            return result_ok(loc.t("No ToDos", "ToDoなし"), loc.t("There are no open ToDos.", "未完了のToDoはありません"), shown, counts)
        if status == "done":
            return result_ok(loc.t("No ToDos", "ToDoなし"), loc.t("There are no completed ToDos.", "完了済みのToDoはありません"), shown, counts)
        return result_ok(loc.t("No ToDos", "ToDoなし"), loc.t("There are no ToDos yet.", "ToDoがまだありません"), shown, counts)

    now = parse_iso(input.get("trigger", {}).get("time")) or datetime.now(timezone.utc)

    lines = []
    for item in shown:
        mark = "x" if loc.locale != "ja" and item.get("status") == "done" else "✔" if item.get("status") == "done" else "・"
        line = f"{mark} {item.get('text', '')}"
        due = item.get("due")
        if due:
            due_dt = parse_iso(due)
            suffix = ""
            if item.get("status") == "open" and due_dt and due_dt <= now:
                suffix = loc.t(" overdue", " ⚠期限切れ")
            elif item.get("notified_at"):
                suffix = loc.t(" notified", " 🔔通知済")
            line += loc.t(f" (due {due}){suffix}", f" (期限 {due}){suffix}")
        item_id = item.get("id")
        if item_id:
            line += f"  ·  {item_id}"
        lines.append(line)

    title = loc.t(f"{len(shown)} ToDos", f"ToDo {len(shown)}件")
    return result_ok(title, "\n".join(lines), shown, counts)


def parse_iso(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def result_ok(title, summary, items, counts):
    return {
        "status": "ok",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {"items": items, "counts": counts},
        "suggestions": [],
    }
