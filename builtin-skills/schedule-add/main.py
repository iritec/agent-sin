"""Builtin: schedule-add

スケジュールを ~/.agent-sin/schedules.yaml に1件追加する。
同じ id + 同じ内容で再度呼ばれた場合は冪等に登録済みを返す。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import localizer  # noqa: E402
from _schedules_lib import (  # noqa: E402
    load_schedules,
    validate_cron,
    write_schedules_atomic,
)


_COMPARABLE_KEYS = ("cron", "skill", "description", "args", "approve")


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"), loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    schedule_id = str(args.get("id", "")).strip()
    cron = str(args.get("cron", "")).strip()
    skill = str(args.get("skill", "")).strip()
    if not schedule_id or not cron or not skill:
        return _err(loc.t("Missing input", "入力不足"), loc.t("id / cron / skill are required.", "id / cron / skill は必須です"))

    try:
        validate_cron(cron)
    except ValueError as e:
        return _err(loc.t("Invalid cron", "cron不正"), str(e))

    try:
        entries = load_schedules(workspace)
    except Exception as e:
        return _err(loc.t("Load failed", "読込失敗"), loc.t(f"Could not read schedules.yaml: {e}", f"schedules.yaml を読めませんでした: {e}"))

    entry = {"id": schedule_id, "cron": cron, "skill": skill}
    description = args.get("description")
    if description:
        entry["description"] = str(description)
    extra_args = args.get("args")
    if isinstance(extra_args, dict) and extra_args:
        entry["args"] = extra_args
    if "enabled" in args:
        entry["enabled"] = bool(args["enabled"])
    if "approve" in args:
        entry["approve"] = bool(args["approve"])

    existing = next(
        (item for item in entries if isinstance(item, dict) and item.get("id") == schedule_id),
        None,
    )
    if existing is not None:
        if _same_schedule(existing, entry):
            ctx.log.info(f"schedule-add: id={schedule_id} already exists (idempotent)")
            disabled_note = " (disabled)" if _enabled_value(existing) is False else ""
            return {
                "status": "ok",
                "title": loc.t("Already registered", "登録済み"),
                "summary": loc.t(f"Already registered: {schedule_id}: {cron} -> {skill}{disabled_note}", f"登録済みです: {schedule_id}: {cron} → {skill}{disabled_note}"),
                "outputs": {},
                "data": {
                    "entry": existing,
                    "total": len(entries),
                    "path": _schedules_path(workspace),
                    "already_registered": True,
                },
                "suggestions": [],
            }
        return _err(
            loc.t("Duplicate ID", "ID重複"),
            loc.t(f'Schedule ID "{schedule_id}" is already registered with different settings. Remove it first or use another ID.', f'スケジュールID "{schedule_id}" は別の内容で既に登録されています。先に削除してから追加するか、別のIDを使ってください'),
        )

    entries.append(entry)

    try:
        path = write_schedules_atomic(workspace, entries)
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"), loc.t(f"Failed to write schedules.yaml: {e}", f"schedules.yaml への書き込みに失敗しました: {e}"))

    ctx.log.info(f"schedule-add: id={schedule_id} cron={cron} skill={skill}")

    disabled_note = " (disabled)" if entry.get("enabled") is False else ""
    return {
        "status": "ok",
        "title": loc.t("Registered", "登録"),
        "summary": loc.t(f"Registered: {schedule_id}: {cron} -> {skill}{disabled_note}", f"登録しました: {schedule_id}: {cron} → {skill}{disabled_note}"),
        "outputs": {},
        "data": {"entry": entry, "total": len(entries), "path": path},
        "suggestions": [],
    }


def _same_schedule(existing: dict, candidate: dict) -> bool:
    for key in _COMPARABLE_KEYS:
        if existing.get(key) != candidate.get(key):
            return False
    # enabled defaults to True when unspecified; treat missing as True so a
    # re-add that omits "enabled" still counts as identical to an entry that
    # is enabled by default.
    if _enabled_value(existing) != _enabled_value(candidate):
        return False
    return True


def _enabled_value(entry: dict) -> bool:
    value = entry.get("enabled")
    if value is None:
        return True
    return bool(value)


def _schedules_path(workspace: str) -> str:
    return os.path.join(workspace, "schedules.yaml")


def _err(title, summary):
    return {
        "status": "error",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
