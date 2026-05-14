"""Builtin: profile-delete

soul.md / user.md / memory.md の既存エントリを削除する。
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
    index = args.get("index")
    timestamp = args.get("timestamp")
    timestamp = str(timestamp).strip() if timestamp else None

    if target not in VALID_TARGETS:
        return _err(loc.t("Invalid target", "対象不正"), loc.t("target must be soul, user, or memory.", "target は soul / user / memory のいずれかを指定してください"))
    if index is not None and not isinstance(index, int):
        return _err(loc.t("Invalid index", "index不正"), loc.t("index must be a positive integer.", "index は正の整数で指定してください"))
    if index is None and not timestamp:
        return _err(loc.t("Cannot identify entry", "特定不可"), loc.t("Specify either index or timestamp.", "index か timestamp のどちらかを指定してください"))

    path = profile_file(workspace, target)
    if not os.path.exists(path):
        return _err(loc.t("File not found", "対象ファイルなし"), loc.t(f"{target}.md does not exist.", f"{target}.md が存在しません"))

    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    preamble, entries = parse_profile(raw)

    if not entries:
        return _err(loc.t("No entries", "エントリなし"), loc.t(f"{target}.md has no entries to delete.", f"{target}.md に削除対象のエントリがありません"))

    try:
        i = find_entry_index(entries, index=index, timestamp=timestamp)
    except LookupError as e:
        return _err(loc.t("Cannot identify entry", "特定不可"), str(e))

    removed = entries.pop(i)

    try:
        write_atomic(path, serialize_profile(preamble, entries))
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"), loc.t(f"Failed to write {target}.md: {e}", f"{target}.md への書き込みに失敗しました: {e}"))

    ctx.log.info(f"profile-delete: {target}.md index={i + 1} removed")

    preview = removed["text"]
    if len(preview) > 60:
        preview = preview[:57] + "..."
    return {
        "status": "ok",
        "title": loc.t("Deleted", "削除"),
        "summary": loc.t(f"Deleted entry {i + 1} from {target}.md: {preview}", f"{target}.md の {i + 1}番目を削除しました: {preview}"),
        "outputs": {},
        "data": {
            "target": target,
            "index": i + 1,
            "timestamp": removed["timestamp"],
            "removed": removed,
            "remaining": len(entries),
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
