"""Builtin: todo-done

ToDoを完了状態に更新する。argsで渡されたidの完全一致または先頭一致で1件特定する。

入力:
  args.id: 対象ToDoのID (先頭一致可)
出力:
  data.item: 更新後のToDo
"""

from __future__ import annotations

import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    target_id = str(args.get("id", "")).strip()

    if not target_id:
        return error_result(loc.t("ID is missing", "IDが指定されていません"), loc.t("Specify the ToDo ID to complete.", "完了するToDoのIDを指定してください"))

    items = list((await ctx.memory.get("items")) or [])
    if not items:
        return error_result(loc.t("No ToDos", "ToDoがありません"), loc.t("There are no registered ToDos yet.", "ToDoがまだ登録されていません"))

    matches = [i for i in items if i.get("id") == target_id]
    if not matches:
        matches = [i for i in items if str(i.get("id", "")).startswith(target_id)]
    if not matches:
        return error_result(loc.t("Not found", "見つかりません"), loc.t(f"No ToDo was found for ID {target_id}.", f"ID {target_id} のToDoは見つかりませんでした"))
    if len(matches) > 1:
        ids = ", ".join(str(i.get("id")) for i in matches)
        return error_result(loc.t("Ambiguous ID", "IDが曖昧です"), loc.t(f"Multiple ToDos match: {ids}", f"複数のToDoが該当します: {ids}"))

    target = matches[0]
    text = target.get("text", "")
    if target.get("status") == "done":
        return result_ok(loc.t("Already done", "既に完了済み"), loc.t(f"Already done: {text}", f"既に完了済み: {text}"), target)

    now = input.get("trigger", {}).get("time") or datetime.now().isoformat()
    target["status"] = "done"
    target["completed_at"] = now
    await ctx.memory.set("items", items)
    ctx.log.info(f"todo-done: id={target.get('id')}")

    return result_ok(loc.t("Done", "完了"), loc.t(f"Done: {text}", f"完了: {text}"), target)


def result_ok(title, summary, item):
    return {
        "status": "ok",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {"item": item},
        "suggestions": [],
    }


def error_result(title, summary):
    return {
        "status": "error",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
