"""Builtin: schedule-toggle

スケジュールの enabled フラグを切り替える(または指定値に設定する)。
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
        return _err(loc.t("ID is missing", "ID未指定"), loc.t("Specify the target schedule ID.", "対象スケジュールのIDを指定してください"))

    explicit = "enabled" in args
    target_enabled = bool(args["enabled"]) if explicit else None

    try:
        entries = load_schedules(workspace)
    except Exception as e:
        return _err(loc.t("Load failed", "読込失敗"), loc.t(f"Could not read schedules.yaml: {e}", f"schedules.yaml を読めませんでした: {e}"))

    target = None
    for item in entries:
        if isinstance(item, dict) and item.get("id") == target_id:
            target = item
            break
    if target is None:
        return _err(loc.t("Not found", "見つかりません"), loc.t(f'Schedule "{target_id}" is not registered.', f'スケジュール "{target_id}" は登録されていません'))

    current = target.get("enabled")
    if current is None:
        current = True
    new_value = target_enabled if explicit else (not bool(current))
    target["enabled"] = new_value

    try:
        path = write_schedules_atomic(workspace, entries)
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"), loc.t(f"Failed to write schedules.yaml: {e}", f"schedules.yaml への書き込みに失敗しました: {e}"))

    ctx.log.info(
        f"schedule-toggle: id={target_id} {current} -> {new_value}",
    )

    state = loc.t("enabled", "有効") if new_value else loc.t("disabled", "無効")
    return {
        "status": "ok",
        "title": loc.t("Updated", "切替"),
        "summary": loc.t(f"{target_id} is now {state}.", f"{target_id} を{state}にしました"),
        "outputs": {},
        "data": {"entry": target, "previous_enabled": bool(current), "enabled": new_value, "path": path},
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
