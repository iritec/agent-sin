"""Builtin: memo-list

memo-save が書き込むデイリーノートからメモ行を読み、削除時に使える
1始まり番号つきで表示する。
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MEMO_LINE_RE = re.compile(r"^-\s+")
_CONTINUATION_RE = re.compile(r"^  \S")
_MEMO_HEAD_RE = re.compile(r"^-\s+(?:\d{4}-\d{2}-\d{2}T\S+\s+)?")


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    notes_dir = input.get("sources", {}).get("notes_dir", "")
    if not notes_dir:
        return _err(loc.t("Notes unavailable", "ノート不明"), loc.t("notes_dir is unavailable.", "notes_dir が取得できません"))

    date_str = str(args.get("date", "")).strip()
    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")
    if not _DATE_RE.match(date_str):
        return _err(loc.t("Invalid date", "日付不正"), loc.t("Use YYYY-MM-DD for date.", "date は YYYY-MM-DD 形式で指定してください"))

    limit = int(args.get("limit", 20))
    year, month, _ = date_str.split("-")
    path = os.path.join(notes_dir, year, month, f"{date_str}.md")
    if not os.path.exists(path):
        return _ok(loc.t("No memos", "メモなし"), loc.t(f"No memos for {date_str}.", f"{date_str} のメモはありません"), [], date_str, path)

    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        return _err(loc.t("Cannot read", "読み取り失敗"), loc.t(f"Failed to read {path}: {e}", f"{path} を読み取れませんでした: {e}"))

    memos = _collect_memos(raw.splitlines(keepends=False))
    shown = memos[:limit]
    if not shown:
        return _ok(loc.t("No memos", "メモなし"), loc.t(f"No memo lines for {date_str}.", f"{date_str} にメモ行はありません"), [], date_str, path)

    lines = [loc.t(f"Memos for {date_str}:", f"{date_str} のメモ:")]
    for item in shown:
        lines.append(f"{item['index']}. {item['text']}")
    if len(memos) > len(shown):
        lines.append(loc.t(f"...and {len(memos) - len(shown)} more", f"...他 {len(memos) - len(shown)} 件"))

    title = loc.t(f"{len(memos)} memos", f"メモ {len(memos)}件")
    return _ok(title, "\n".join(lines), shown, date_str, path, total=len(memos))


def _collect_memos(lines):
    items = []
    i = 0
    while i < len(lines):
        if _MEMO_LINE_RE.match(lines[i]):
            start = i
            body = [_clean_head(lines[i])]
            j = i + 1
            while j < len(lines) and _CONTINUATION_RE.match(lines[j]):
                body.append(lines[j].strip())
                j += 1
            text = " / ".join(part for part in body if part)
            items.append(
                {
                    "index": len(items) + 1,
                    "line": start + 1,
                    "text": _snippet(text),
                }
            )
            i = j
        else:
            i += 1
    return items


def _clean_head(line):
    return _MEMO_HEAD_RE.sub("", line, count=1).strip()


def _snippet(text):
    compact = " ".join(str(text).split())
    if len(compact) <= 160:
        return compact
    return compact[:157] + "..."


def _ok(title, summary, memos, date_str, path, total=None):
    return {
        "status": "ok",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {
            "date": date_str,
            "memos": memos,
            "count": len(memos),
            "total": len(memos) if total is None else total,
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
