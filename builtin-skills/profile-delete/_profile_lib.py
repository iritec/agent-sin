"""Shared helpers for profile-edit / profile-delete skills.

soul.md / user.md / memory.md は profile-save が `\n## <timestamp>\n\n<text>\n`
形式で追記する。これを「ヘッダー = '## ...' を境にしたエントリ列」として
扱うためのパーサと再シリアライズを提供する。
"""

from __future__ import annotations

import os
import re
import tempfile
from typing import List, Optional, Tuple


_HEADER_RE = re.compile(r"^##\s+(.+?)\s*$")


def profile_file(workspace: str, target: str) -> str:
    return os.path.join(workspace, "memory", "profile", f"{target}.md")


def parse_profile(raw: str) -> Tuple[str, List[dict]]:
    """Split into (preamble, entries[{ timestamp, text }]).

    preamble は最初の '## ' より前の部分(ファイル冒頭のコメント等)。
    各 entry の `text` は本文のみ(前後の改行は trim 済み)。
    """
    lines = raw.splitlines(keepends=False)
    pre: List[str] = []
    entries: List[dict] = []
    current: Optional[dict] = None
    for line in lines:
        m = _HEADER_RE.match(line)
        if m:
            if current is not None:
                current["text"] = "\n".join(current["_body"]).strip()
                del current["_body"]
                entries.append(current)
            current = {"timestamp": m.group(1).strip(), "_body": []}
            continue
        if current is None:
            pre.append(line)
        else:
            current["_body"].append(line)
    if current is not None:
        current["text"] = "\n".join(current["_body"]).strip()
        del current["_body"]
        entries.append(current)
    preamble = "\n".join(pre).rstrip("\n")
    return preamble, entries


def serialize_profile(preamble: str, entries: List[dict]) -> str:
    out: List[str] = []
    if preamble:
        out.append(preamble)
    for entry in entries:
        out.append("")
        out.append(f"## {entry['timestamp']}")
        out.append("")
        out.append(entry["text"])
    text = "\n".join(out)
    if not text.endswith("\n"):
        text += "\n"
    return text


def write_atomic(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=".profile.", suffix=".md.tmp", dir=os.path.dirname(path),
    )
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


def find_entry_index(entries: List[dict], *, index: Optional[int], timestamp: Optional[str]) -> int:
    if timestamp:
        for i, entry in enumerate(entries):
            if entry["timestamp"] == timestamp:
                return i
        raise LookupError(f'timestamp "{timestamp}" にマッチするエントリがありません')
    if index is not None:
        if index < 1 or index > len(entries):
            raise LookupError(
                f"index {index} は範囲外です (entries={len(entries)})",
            )
        return index - 1
    raise LookupError("index か timestamp のどちらかを指定してください")
