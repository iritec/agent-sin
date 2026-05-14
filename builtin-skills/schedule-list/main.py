"""Builtin: schedule-list

~/.agent-sin/schedules.yaml を読み、登録済みスケジュールを一覧表示する。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import localizer  # noqa: E402
from _schedules_lib import load_schedules  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    include_disabled = args.get("include_disabled")
    if include_disabled is None:
        include_disabled = True
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"), loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    try:
        entries = load_schedules(workspace)
    except Exception as e:
        return _err(loc.t("Load failed", "読込失敗"), loc.t(f"Could not read schedules.yaml: {e}", f"schedules.yaml を読めませんでした: {e}"))

    rows = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        enabled = item.get("enabled")
        if enabled is None:
            enabled = True
        if not include_disabled and not enabled:
            continue
        rows.append({
            "id": item.get("id"),
            "cron": item.get("cron"),
            "skill": item.get("skill"),
            "enabled": bool(enabled),
            "description": item.get("description"),
            "args": item.get("args") or {},
        })

    if not rows:
        return {
            "status": "ok",
            "title": loc.t("No schedules", "スケジュールなし"),
            "summary": loc.t("There are no registered schedules.", "登録済みのスケジュールはありません"),
            "outputs": {},
            "data": {"items": [], "total": 0},
            "suggestions": [],
        }

    lines = []
    for row in rows:
        flag = "" if row["enabled"] else " (disabled)"
        desc = f" - {row['description']}" if loc.locale != "ja" and row.get("description") else f" — {row['description']}" if row.get("description") else ""
        arrow = "->" if loc.locale != "ja" else "→"
        bullet = "-" if loc.locale != "ja" else "・"
        lines.append(f"{bullet} {row['id']}{flag}: {row['cron']} {arrow} {row['skill']}{desc}")

    return {
        "status": "ok",
        "title": loc.t(f"{len(rows)} schedules", f"スケジュール {len(rows)}件"),
        "summary": "\n".join(lines),
        "outputs": {},
        "data": {"items": rows, "total": len(rows)},
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
