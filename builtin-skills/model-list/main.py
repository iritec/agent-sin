"""Builtin: model-list

models.yaml の登録モデル一覧と、chat / builder ロールの現在の割当を返す。
副作用なし。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402
from _models_lib import load_models, models_path  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"),
                    loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    try:
        models = load_models(workspace)
    except Exception as e:
        return _err(loc.t("Load failed", "読込失敗"),
                    loc.t(f"Could not read models.yaml: {e}", f"models.yaml を読めませんでした: {e}"))

    chat_id = models["roles"].get("chat")
    builder_id = models["roles"].get("builder")

    items = []
    lines = []
    for entry_id, entry in models["models"].items():
        roles = []
        if entry_id == chat_id:
            roles.append("chat")
        if entry_id == builder_id:
            roles.append("builder")
        item = {
            "id": entry_id,
            "type": entry.get("type"),
            "provider": entry.get("provider"),
            "model": entry.get("model"),
            "effort": entry.get("effort"),
            "enabled": entry.get("enabled", True),
            "roles": roles,
        }
        items.append(item)
        parts = []
        parts.append(entry.get("provider") or entry.get("type") or "-")
        if entry.get("model"):
            parts.append(str(entry["model"]))
        if entry.get("effort"):
            parts.append(f"effort={entry['effort']}")
        if entry.get("enabled") is False:
            parts.append("disabled")
        suffix = f"  <- {','.join(roles)}" if roles else ""
        lines.append(f"- {entry_id}: {' / '.join(parts)}{suffix}")

    role_summary = loc.t(
        f"chat: {chat_id or '-'} / builder: {builder_id or '-'}",
        f"chat: {chat_id or '-'} / builder: {builder_id or '-'}",
    )
    if items:
        summary = role_summary + "\n" + "\n".join(lines)
    else:
        summary = loc.t("No models registered.", "登録モデルはありません")

    return {
        "status": "ok",
        "title": loc.t("Models", "モデル一覧"),
        "summary": summary,
        "outputs": {},
        "data": {
            "roles": {"chat": chat_id, "builder": builder_id},
            "models": items,
            "path": models_path(workspace),
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
