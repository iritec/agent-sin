"""Builtin: memo-save

入力 text を Markdown メモのデイリーファイルに追記する。複数行に対応し、
1メモ = 1バレット + 継続行(2スペースインデント)の Markdown リスト形式で書き出す。
Runtime が outputs.note を skill.yaml の outputs[id=note] に従って保存するため、
このスキル自身は **content を返すだけ**でファイルには触らない。

入力:
  args.text: 保存する本文 (必須, 改行可)
出力:
  outputs.note: 追記用の Markdown。保存先の表示は skill.yaml 側で抑制する。
"""

from __future__ import annotations

import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    text = str(args.get("text", "")).strip()

    if not text:
        ctx.log.warn("memo-save: empty text, skipping")
        return {
            "status": "skipped",
            "title": loc.t("No memo", "メモなし"),
            "summary": loc.t("There is no text to save.", "保存する本文がありません"),
            "outputs": {},
            "data": {},
            "suggestions": [],
        }

    ctx.log.info(f"memo-save: saving {len(text)} chars")
    timestamp = input.get("trigger", {}).get("time") or datetime.now().isoformat()
    content = format_memo(timestamp, text)

    return {
        "status": "ok",
        "title": loc.t("Saved", "保存しました"),
        "summary": loc.t("Memo saved.", "メモを保存しました"),
        "outputs": {
            "note": {
                "content": content,
                "frontmatter": {
                    "tags": ["memo"]
                },
            }
        },
        "data": {
            "length": len(text)
        },
        "suggestions": [],
    }


def format_memo(timestamp, text):
    # 改行を正規化し、空行はメモ区切りと衝突するため除外する
    raw_lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    body_lines = [line for line in raw_lines if line.strip()]
    if not body_lines:
        return ""
    first, *rest = body_lines
    head = f"- {timestamp} {first}"
    if not rest:
        return head + "\n"
    indented = "\n".join(f"  {line}" for line in rest)
    return f"{head}\n{indented}\n"
