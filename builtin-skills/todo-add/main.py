"""Builtin: todo-add

ToDo を1件追加する。memory.todo namespace の "items" リストに append する。

入力:
  args.text: ToDoの本文 (必須)
  args.due:  ISO8601 日時 (任意)
出力:
  data.item: 追加したToDo
  data.total: 追加後の総件数
"""

from __future__ import annotations

import secrets
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    text = str(args.get("text", "")).strip()
    due = str(args.get("due", "")).strip() or None

    if not text:
        return result_skipped(loc.t("No ToDo", "ToDoなし"), loc.t("There is nothing to add.", "追加する内容がありません"))

    items = list((await ctx.memory.get("items")) or [])
    now = input.get("trigger", {}).get("time") or datetime.now().isoformat()
    item = {
        "id": secrets.token_hex(3),
        "text": text,
        "status": "open",
        "created_at": now,
    }
    if due:
        item["due"] = due
    items.append(item)
    await ctx.memory.set("items", items)
    ctx.log.info(f"todo-add: id={item['id']} total={len(items)}")

    summary = loc.t(f"Added: {text}", f"追加: {text}")
    if due:
        summary += loc.t(f" (due {due})", f" (期限 {due})")
    return {
        "status": "ok",
        "title": loc.t("Added", "追加"),
        "summary": summary,
        "outputs": {},
        "data": {"item": item, "total": len(items)},
        "suggestions": [],
    }


def result_skipped(title, summary):
    return {
        "status": "skipped",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
