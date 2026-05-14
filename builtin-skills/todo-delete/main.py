"""Builtin: todo-delete

ToDoを削除する。argsで渡されたidの完全一致または先頭一致で1件特定する。

入力:
  args.id: 対象ToDoのID (先頭一致可)
出力:
  data.removed: 削除したToDo
  data.total:   削除後の総件数
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    target_id = str(args.get("id", "")).strip()

    if not target_id:
        return error_result(loc.t("ID is missing", "IDが指定されていません"), loc.t("Specify the ToDo ID to delete.", "削除するToDoのIDを指定してください"))

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
    remaining = [i for i in items if i is not target]
    await ctx.memory.set("items", remaining)
    ctx.log.info(f"todo-delete: id={target.get('id')} remaining={len(remaining)}")

    return {
        "status": "ok",
        "title": loc.t("Deleted", "削除"),
        "summary": loc.t(f"Deleted: {target.get('text', '')}", f"削除: {target.get('text', '')}"),
        "outputs": {},
        "data": {"removed": target, "total": len(remaining)},
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
