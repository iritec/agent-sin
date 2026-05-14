"""Builtin: memo-delete

memo-save が書き込むデイリーノートからメモを1件削除する。
バレット行 + 続く 2 スペースインデントの継続行をまとめて取り除く。
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MEMO_LINE_RE = re.compile(r"^-\s+")
_CONTINUATION_RE = re.compile(r"^  \S")


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    workspace = input.get("sources", {}).get("workspace", "")
    notes_dir = input.get("sources", {}).get("notes_dir", "")
    if not workspace or not notes_dir:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"), loc.t("workspace / notes_dir is unavailable.", "workspace / notes_dir が取得できません"))

    date_str = str(args.get("date", "")).strip()
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")
    if not _DATE_RE.match(date_str):
        return _err(loc.t("Invalid date", "日付不正"), loc.t("Use YYYY-MM-DD for date.", "date は YYYY-MM-DD 形式で指定してください"))

    match = args.get("match")
    match = str(match).strip() if match else None
    index = args.get("index")
    if index is not None and not isinstance(index, int):
        return _err(loc.t("Invalid index", "index不正"), loc.t("index must be a positive integer.", "index は正の整数で指定してください"))
    if not match and index is None:
        return _err(loc.t("Cannot identify memo", "特定不可"), loc.t("Specify either match or index.", "match か index のどちらかを指定してください"))

    year, month, _ = date_str.split("-")
    path = os.path.join(notes_dir, year, month, f"{date_str}.md")
    if not os.path.exists(path):
        return _err(loc.t("File not found", "ファイルなし"), loc.t(f"No memo file exists for {date_str}.", f"{date_str} のメモファイルがありません"))

    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    lines = raw.splitlines(keepends=False)

    memo_ranges = _collect_memo_ranges(lines)
    if not memo_ranges:
        return _err(loc.t("No memos", "メモなし"), loc.t(f"No memo lines can be removed for {date_str}.", f"{date_str} に削除対象のメモ行がありません"))

    target_range = None
    if index is not None:
        if index < 1 or index > len(memo_ranges):
            return _err(loc.t("Invalid index", "index不正"), loc.t(f"index {index} is out of range ({len(memo_ranges)} memos).", f"index {index} は範囲外です (メモ {len(memo_ranges)} 件)"))
        target_range = memo_ranges[index - 1]
    else:
        candidates = [
            r for r in memo_ranges
            if any(match in lines[i] for i in range(r[0], r[1]))
        ]
        if not candidates:
            return _err(loc.t("Not found", "見つかりません"), loc.t(f'No memo matches "{match}".', f'"{match}" に一致するメモがありません'))
        if len(candidates) > 1:
            preview = "\n".join(
                f"  {idx + 1}. {lines[start]}" for idx, (start, _end) in enumerate(candidates[:5])
            )
            return _err(
                loc.t("Ambiguous match", "曖昧です"),
                loc.t(f"{len(candidates)} memos matched. Specify index:\n{preview}", f"{len(candidates)} 件一致しました。index で指定してください:\n{preview}"),
            )
        target_range = candidates[0]

    start, end = target_range
    removed_lines = lines[start:end]
    new_lines = lines[:start] + lines[end:]
    new_content = "\n".join(new_lines)
    if raw.endswith("\n") and not new_content.endswith("\n"):
        new_content += "\n"
    if not raw.endswith("\n") and new_content.endswith("\n"):
        new_content = new_content.rstrip("\n")

    try:
        _write_atomic(path, new_content)
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"), loc.t(f"Failed to write {path}: {e}", f"{path} への書き込みに失敗しました: {e}"))

    ctx.log.info(f"memo-delete: {date_str} {len(removed_lines)} line(s) removed")

    preview = removed_lines[0].lstrip("- ").strip()
    if len(preview) > 60:
        preview = preview[:57] + "..."
    remaining = len(memo_ranges) - 1
    return {
        "status": "ok",
        "title": loc.t("Deleted", "削除"),
        "summary": loc.t(f"Deleted memo from {date_str}: {preview}", f"{date_str} のメモを削除しました: {preview}"),
        "outputs": {},
        "data": {
            "date": date_str,
            "removed_lines": removed_lines,
            "remaining_memos": remaining,
            "path": path,
        },
        "suggestions": [],
    }


def _collect_memo_ranges(lines):
    ranges = []
    i = 0
    while i < len(lines):
        if _MEMO_LINE_RE.match(lines[i]):
            start = i
            j = i + 1
            while j < len(lines) and _CONTINUATION_RE.match(lines[j]):
                j += 1
            ranges.append((start, j))
            i = j
        else:
            i += 1
    return ranges


def _write_atomic(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".memo.", suffix=".md.tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise


def _err(title, summary):
    return {
        "status": "error",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
