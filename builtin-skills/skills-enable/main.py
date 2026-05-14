"""Builtin: skills-enable

指定したスキルIDを skill-settings.yaml の disabled リストから取り除く。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402
from _skill_settings_lib import set_skill_enabled  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"), loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    target_id = str(args.get("id", "")).strip()
    if not target_id:
        return _err(loc.t("ID is missing", "ID未指定"), loc.t("Specify the skill ID to enable.", "有効化したいスキルのIDを指定してください"))

    try:
        changed, settings = set_skill_enabled(workspace, target_id, True)
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"), loc.t(f"Failed to update skill-settings.yaml: {e}", f"skill-settings.yaml の更新に失敗しました: {e}"))

    if not changed:
        return {
            "status": "ok",
            "title": loc.t("Already enabled", "既に有効"),
            "summary": loc.t(f"{target_id} is already enabled.", f"{target_id} は既に有効です"),
            "outputs": {},
            "data": {"id": target_id, "enabled": True, "changed": False, "disabled": list(settings.get("disabled") or [])},
            "suggestions": [],
        }

    ctx.log.info(f"skills-enable: id={target_id}")

    return {
        "status": "ok",
        "title": loc.t("Enabled", "有効化"),
        "summary": loc.t(f"Enabled {target_id}.", f"{target_id} を有効化しました"),
        "outputs": {},
        "data": {"id": target_id, "enabled": True, "changed": True, "disabled": list(settings.get("disabled") or [])},
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
