"""Builtin: profile-save

soul.md / user.md / memory.md に長期プロフィールを追記する。
Runtime が outputs の保存先に従って書き込むため、このスキル自身は content を返すだけ。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    target = str(args.get("target", "")).strip()
    text = str(args.get("text", "")).strip()

    if target not in {"soul", "user", "memory"}:
        return result("error", loc.t("Cannot save", "保存できません"), loc.t("target must be soul, user, or memory.", "target は soul / user / memory のいずれかを指定してください"), {})
    if not text:
        ctx.log.warn("profile-save: empty text, skipping")
        return result("skipped", loc.t("Nothing saved", "保存なし"), loc.t("There is no text to save.", "保存する本文がありません"), {})

    timestamp = input.get("trigger", {}).get("time") or ctx.now()
    content = f"\n## {timestamp}\n\n{text}\n"
    ctx.log.info(f"profile-save: saving {len(text)} chars to {target}.md")
    return result(
        "ok",
        loc.t("Saved", "保存しました"),
        loc.t(f"Saved to {target}.md", f"{target}.md に保存しました"),
        {
            target: {
                "content": content,
                "frontmatter": {},
            }
        },
    )


def result(status, title, summary, outputs):
    return {
        "status": status,
        "title": title,
        "summary": summary,
        "outputs": outputs,
        "data": {},
        "suggestions": [],
    }
