"""Builtin: profile-edit

soul.md / user.md / memory.md の既存エントリ本文を置き換える。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import localizer  # noqa: E402
from _profile_lib import (  # noqa: E402
    find_entry_index,
    parse_profile,
    profile_file,
    serialize_profile,
    write_atomic,
)


VALID_TARGETS = {"soul", "user", "memory"}


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"), loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    target = str(args.get("target", "")).strip()
    text = str(args.get("text", "")).strip()
    index = args.get("index")
    timestamp = args.get("timestamp")
    timestamp = str(timestamp).strip() if timestamp else None

    if target not in VALID_TARGETS:
        return _err(loc.t("Invalid target", "対象不正"), loc.t("target must be soul, user, or memory.", "target は soul / user / memory のいずれかを指定してください"))
    if not text:
        return _err(loc.t("No text", "本文なし"), loc.t("Specify the replacement text.", "置き換える本文を指定してください"))
    if index is not None and not isinstance(index, int):
        return _err(loc.t("Invalid index", "index不正"), loc.t("index must be a positive integer.", "index は正の整数で指定してください"))

    path = profile_file(workspace, target)
    if not os.path.exists(path):
        return _err(loc.t("File not found", "対象ファイルなし"), loc.t(f"{target}.md does not exist.", f"{target}.md が存在しません"))

    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    preamble, entries = parse_profile(raw)

    if not entries:
        return _err(loc.t("No entries", "エントリなし"), loc.t(f"{target}.md has no entries to edit.", f"{target}.md に編集対象のエントリがありません"))

    try:
        i = find_entry_index(entries, index=index, timestamp=timestamp)
    except LookupError as e:
        return _err(loc.t("Cannot identify entry", "特定不可"), str(e))

    before = entries[i]["text"]
    entries[i]["text"] = text

    try:
        write_atomic(path, serialize_profile(preamble, entries))
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"), loc.t(f"Failed to write {target}.md: {e}", f"{target}.md への書き込みに失敗しました: {e}"))

    ctx.log.info(f"profile-edit: {target}.md index={i + 1} updated")

    return {
        "status": "ok",
        "title": loc.t("Updated", "更新"),
        "summary": loc.t(f"Updated entry {i + 1} in {target}.md", f"{target}.md の {i + 1}番目を更新しました"),
        "outputs": {},
        "data": {
            "target": target,
            "index": i + 1,
            "timestamp": entries[i]["timestamp"],
            "before": before,
            "after": text,
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
