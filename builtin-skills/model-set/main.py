"""Builtin: model-set

models.yaml.roles の chat / builder ロールに、登録済みのモデルIDを割り当てる。
未登録IDが渡された場合は候補一覧をエラーで返す。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402
from _models_lib import (  # noqa: E402
    ALLOWED_ROLES,
    entry_summary,
    load_models,
    models_path,
    save_models,
)


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"),
                    loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    role = str(args.get("role", "")).strip().lower()
    if role not in ALLOWED_ROLES:
        return _err(loc.t("Invalid role", "role 不正"),
                    loc.t('role must be "chat" or "builder".', 'role は "chat" か "builder" を指定してください'))

    target_id = str(args.get("id", "")).strip()
    if not target_id:
        return _err(loc.t("ID missing", "ID未指定"),
                    loc.t("Specify the model id to assign.", "割り当てるモデルIDを指定してください"))

    try:
        models = load_models(workspace)
    except Exception as e:
        return _err(loc.t("Load failed", "読込失敗"),
                    loc.t(f"Could not read models.yaml: {e}", f"models.yaml を読めませんでした: {e}"))

    if target_id not in models["models"]:
        known = ", ".join(models["models"].keys()) or "-"
        return _err(
            loc.t("Unknown model", "未登録モデル"),
            loc.t(
                f"Model id not found: {target_id}. Available: {known}. Call model-add first to register it.",
                f"未登録のモデルIDです: {target_id}。登録済み: {known}。先に model-add で登録してください",
            ),
        )

    current_id = models["roles"].get(role)
    entry = models["models"][target_id]

    if current_id == target_id:
        return {
            "status": "ok",
            "title": loc.t("No change", "変更なし"),
            "summary": loc.t(
                f"{role} model is already {entry_summary(target_id, entry)}.",
                f"{role} は既に {entry_summary(target_id, entry)} です",
            ),
            "outputs": {},
            "data": {
                "role": role,
                "id": target_id,
                "entry": entry,
                "changed": False,
                "path": models_path(workspace),
            },
            "suggestions": [],
        }

    # 該当エントリが disabled だった場合、ロール割当と同時に enabled=true にする
    # (setRoleModel の TS 実装と挙動を合わせる)
    if entry.get("enabled") is False:
        entry["enabled"] = True
        models["models"][target_id] = entry

    models["roles"][role] = target_id

    try:
        path = save_models(workspace, models)
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"),
                    loc.t(f"Failed to write models.yaml: {e}", f"models.yaml への書き込みに失敗しました: {e}"))

    ctx.log.info(f"model-set: role={role} id={target_id} (was {current_id or '-'})")

    return {
        "status": "ok",
        "title": loc.t("Switched", "切り替え"),
        "summary": loc.t(
            f"{role} model -> {entry_summary(target_id, entry)}",
            f"{role} のモデルを {entry_summary(target_id, entry)} に切り替えました",
        ),
        "outputs": {},
        "data": {
            "role": role,
            "id": target_id,
            "previous_id": current_id,
            "entry": entry,
            "changed": True,
            "path": path,
        },
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
