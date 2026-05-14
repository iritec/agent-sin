"""Builtin: schedule-remove

スケジュールを ~/.agent-sin/schedules.yaml から1件削除する。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import localizer  # noqa: E402
from _schedules_lib import load_schedules, write_schedules_atomic  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"), loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    target_id = str(args.get("id", "")).strip()
    if not target_id:
        return _err(loc.t("ID is missing", "ID未指定"), loc.t("Specify the schedule ID to delete.", "削除するスケジュールのIDを指定してください"))

    try:
        entries = load_schedules(workspace)
    except Exception as e:
        return _err(loc.t("Load failed", "読込失敗"), loc.t(f"Could not read schedules.yaml: {e}", f"schedules.yaml を読めませんでした: {e}"))

    remaining = []
    removed = None
    for item in entries:
        if isinstance(item, dict) and item.get("id") == target_id and removed is None:
            removed = item
            continue
        remaining.append(item)

    if removed is None:
        return _err(loc.t("Not found", "見つかりません"), loc.t(f'Schedule "{target_id}" is not registered.', f'スケジュール "{target_id}" は登録されていません'))

    try:
        path = write_schedules_atomic(workspace, remaining)
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"), loc.t(f"Failed to write schedules.yaml: {e}", f"schedules.yaml への書き込みに失敗しました: {e}"))

    ctx.log.info(f"schedule-remove: id={target_id} remaining={len(remaining)}")

    return {
        "status": "ok",
        "title": loc.t("Deleted", "削除"),
        "summary": loc.t(f"Deleted: {target_id}", f"削除しました: {target_id}"),
        "outputs": {},
        "data": {"removed": removed, "total": len(remaining), "path": path},
        "suggestions": [],
    }


def _err(title, summary):
    return {
        "status": "error",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
