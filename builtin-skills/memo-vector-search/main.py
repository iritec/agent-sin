"""Builtin: memo-vector-search

memo-index で索引化した Chroma collection に対してクエリを embedding 化し、
意味的に近いメモを top-K で返す。先に agent-sin run memo-index を実行する必要あり。

入力:
  args.query:      検索クエリ (必須, 1 文字以上)
  args.limit:      上位件数 (1..50, default 5)
  args.collection: 索引コレクション名 (default: memo)

出力:
  data.matches: [{text, file, line, timestamp, distance}]
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


EMBED_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    query = str(args.get("query", "")).strip()
    limit = int(args.get("limit", 5))
    collection_name = args.get("collection", "memo")
    sources = input.get("sources", {})
    index_dir = sources.get("index_dir")

    if not query:
        ctx.log.warn("memo-vector-search: empty query")
        return result_value("skipped", loc.t("No query", "クエリなし"), loc.t("There is no keyword to search.", "検索するキーワードがありません"), [])
    if not index_dir:
        ctx.log.error("memo-vector-search: index_dir not provided")
        return result_value("error", loc.t("Cannot search", "検索できません"), loc.t("index_dir was not provided.", "index_dir が渡されていません"), [])

    try:
        import chromadb
        from chromadb.utils.embedding_functions import (
            SentenceTransformerEmbeddingFunction,
        )
    except ImportError as e:
        ctx.log.error(f"memo-vector-search: missing dependency: {e}")
        return result_value(
            "error",
            loc.t("chromadb not found", "chromadb が見つかりません"),
            loc.t(
                "Run: python3 -m venv ~/.agent-sin/.venv && ~/.agent-sin/.venv/bin/pip install chromadb sentence-transformers",
                "次を実行: python3 -m venv ~/.agent-sin/.venv && ~/.agent-sin/.venv/bin/pip install chromadb sentence-transformers",
            ),
            [],
        )

    chroma_path = Path(index_dir).expanduser().resolve() / "local-index" / "chroma"
    if not chroma_path.exists():
        return result_value(
            "ok",
            loc.t("0 matches", "0件"),
            loc.t("The index is empty. Run agent-sin run memo-index first.", "索引が空です。先に agent-sin run memo-index を実行してください"),
            [],
        )

    ctx.log.info(f"memo-vector-search: query='{query[:40]}' limit={limit}")

    try:
        ef = SentenceTransformerEmbeddingFunction(model_name=EMBED_MODEL)
        client = chromadb.PersistentClient(path=str(chroma_path))
        col = client.get_or_create_collection(
            name=collection_name, embedding_function=ef
        )
        r = col.query(query_texts=[query], n_results=limit)
    except Exception as e:
        ctx.log.error(f"memo-vector-search: query failed: {e}")
        return result_value("error", loc.t("Search error", "検索エラー"), str(e), [])

    matches = []
    docs = (r.get("documents") or [[]])[0]
    metas = (r.get("metadatas") or [[]])[0]
    dists = (r.get("distances") or [[]])[0]
    for doc, meta, dist in zip(docs, metas, dists):
        meta = meta or {}
        matches.append(
            {
                "text": doc,
                "file": meta.get("file", ""),
                "line": meta.get("line", 0),
                "timestamp": meta.get("timestamp", ""),
                "distance": float(dist),
            }
        )

    if not matches:
        return result_value(
            "ok", loc.t("0 matches", "0件"), loc.t(f'No memos are close to "{query}".', f"「{query}」に近いメモは見つかりませんでした"), []
        )

    lines = [loc.t("Closest memos:", "近いメモ:")]
    for i, m in enumerate(matches, start=1):
        lines.append(f"  {i}) {m['file']}:{m['line']}  dist={m['distance']:.3f}")
        lines.append(f"     {m['text'][:80]}")
    return result_value(
        "ok", loc.t(f"{len(matches)} matches", f"{len(matches)}件見つかりました"), "\n".join(lines), matches
    )


def result_value(status, title, summary, matches):
    return {
        "status": status,
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {"matches": matches},
        "suggestions": [],
    }
