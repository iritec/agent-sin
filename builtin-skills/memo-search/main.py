"""Builtin: memo-search

input.sources.notes_dir 配下の *.md を全文走査し、query にすべての語が含まれる
最初の 1 行を結果に含める。outputs は持たず data.matches に結果を返すのみ。

入力:
  args.query: 検索語 (空白区切りで AND 検索)
  args.limit: 上限 (1..50, default 10)
出力:
  data.matches: [{file, line, text}]
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    query = str(args.get("query", "")).strip()
    limit = int(args.get("limit", 10))
    notes_dir = input.get("sources", {}).get("notes_dir")

    if not query:
        ctx.log.warn("memo-search: empty query")
        return result("skipped", loc.t("No query", "検索語なし"), loc.t("There is no keyword to search.", "検索するキーワードがありません"), [])
    if not notes_dir:
        ctx.log.error("memo-search: notes_dir not provided by runtime")
        return result("error", loc.t("Cannot search", "検索できません"), loc.t("The notes directory was not provided by the runtime.", "ノート保存先がRuntimeから渡されていません"), [])

    root = Path(notes_dir).expanduser().resolve()
    if not root.exists():
        ctx.log.info(f"memo-search: notes_dir does not exist yet: {root}")
        return result("ok", loc.t("0 matches", "0件見つかりました"), loc.t("There are no memos yet.", "まだメモがありません"), [])

    terms = [term.casefold() for term in query.split() if term]
    ctx.log.info(f"memo-search: searching {len(terms)} term(s) in {root}, limit={limit}")
    matches = search_notes(root, terms, limit)
    if not matches:
        return result("ok", loc.t("0 matches", "0件見つかりました"), loc.t(f'No memos contain "{query}".', f"「{query}」を含むメモは見つかりませんでした"), [])

    lines = [loc.t("Found memos:", "見つかったメモ:")]
    for item in matches:
        lines.append(f"- {item['file']}:{item['line']} {item['text']}")
    return result("ok", loc.t(f"{len(matches)} matches", f"{len(matches)}件見つかりました"), "\n".join(lines), matches)


def search_notes(root, terms, limit):
    matches = []
    for file in sorted(root.rglob("*.md")):
        if len(matches) >= limit:
            break
        try:
            resolved = file.resolve()
            if root != resolved and root not in resolved.parents:
                continue
            lines = file.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue

        for index, line in enumerate(lines, start=1):
            if all(term in line.casefold() for term in terms):
                matches.append(
                    {
                        "file": str(file.relative_to(root)),
                        "line": index,
                        "text": snippet(line),
                    }
                )
                break
    return matches


def snippet(line):
    text = " ".join(line.strip().split())
    if len(text) <= 160:
        return text
    return f"{text[:157]}..."


def result(status, title, summary, matches):
    return {
        "status": status,
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {
            "matches": matches,
        },
        "suggestions": [],
    }
