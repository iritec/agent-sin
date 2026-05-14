"""Builtin: memo-index

notes_dir 配下の Markdown を読んで、各 "- {timestamp} {text}" 行を
Chroma の collection (default: memo) に upsert する。

入力:
  args.since:      ISO8601 文字列 (この時刻より古いメモはスキップ、任意)
  args.collection: 索引コレクション名 (default: memo)

出力:
  data: {added, skipped, total, collection}
"""

from __future__ import annotations

import hashlib
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402


EMBED_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {})
    since_str = args.get("since")
    collection_name = args.get("collection", "memo")
    sources = input.get("sources", {})
    notes_dir = sources.get("notes_dir")
    index_dir = sources.get("index_dir")

    if not notes_dir or not index_dir:
        return result_error(
            loc.t("Cannot index", "索引化できません"),
            loc.t("notes_dir or index_dir was not provided by the runtime.", "notes_dir または index_dir が Runtime から渡されていません"),
        )

    try:
        import chromadb
        from chromadb.utils.embedding_functions import (
            SentenceTransformerEmbeddingFunction,
        )
    except ImportError as e:
        ctx.log.error(f"memo-index: missing dependency: {e}")
        return result_error(
            loc.t("chromadb not found", "chromadb が見つかりません"),
            loc.t(
                "Run: python3 -m venv ~/.agent-sin/.venv && ~/.agent-sin/.venv/bin/pip install chromadb sentence-transformers",
                "次を実行: python3 -m venv ~/.agent-sin/.venv && ~/.agent-sin/.venv/bin/pip install chromadb sentence-transformers",
            ),
        )

    chroma_path = Path(index_dir).expanduser().resolve() / "local-index" / "chroma"
    chroma_path.mkdir(parents=True, exist_ok=True)

    notes_root = Path(notes_dir).expanduser().resolve()
    if not notes_root.exists():
        ctx.log.info("memo-index: notes_dir does not exist yet")
        return result_ok(
            loc.t("Nothing to index", "索引化対象なし"),
            loc.t("There are no memos yet.", "まだメモがありません"),
            {"added": 0, "skipped": 0, "total": 0, "collection": collection_name},
        )

    try:
        ef = SentenceTransformerEmbeddingFunction(model_name=EMBED_MODEL)
    except Exception as e:
        ctx.log.error(f"memo-index: failed to load embedder: {e}")
        return result_error(
            loc.t("Could not initialize embedding model", "embedding モデルを初期化できません"),
            loc.t(f"{e}. Check that sentence-transformers is installed.", f"{e}. sentence-transformers のインストールを確認してください"),
        )

    client = chromadb.PersistentClient(path=str(chroma_path))
    col = client.get_or_create_collection(name=collection_name, embedding_function=ef)

    try:
        existing_ids = set(col.get()["ids"])
    except Exception:
        existing_ids = set()

    since = parse_iso(since_str) if since_str else None
    total = added = skipped = 0
    documents, ids, metadatas = [], [], []

    for md in sorted(notes_root.rglob("*.md")):
        try:
            relative = md.relative_to(notes_root)
        except ValueError:
            continue
        # reports サブディレクトリは出力先なので索引対象外
        if "reports" in relative.parts:
            continue
        try:
            lines = md.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for line_no, raw in enumerate(lines, start=1):
            text = raw.strip()
            if not text.startswith("- "):
                continue
            body = text[2:].strip()
            if not body:
                continue
            first, _, rest = body.partition(" ")
            ts = parse_iso(first)
            if ts and rest:
                body = rest.strip()
            if since and ts and ts < since:
                continue
            total += 1
            file_rel = str(relative)
            doc_id = sha1(f"{file_rel}:{line_no}:{body}")
            if doc_id in existing_ids:
                skipped += 1
                continue
            documents.append(body)
            ids.append(doc_id)
            metadatas.append(
                {
                    "file": file_rel,
                    "line": line_no,
                    "timestamp": ts.isoformat() if ts else "",
                }
            )
            added += 1

    if documents:
        ctx.log.info(f"memo-index: adding {len(documents)} new chunks to {collection_name}")
        col.add(documents=documents, ids=ids, metadatas=metadatas)

    summary = loc.t(f"Added {added} / skipped {skipped} / found {total}", f"追加 {added} / スキップ {skipped} / 検出 {total}")
    return result_ok(
        loc.t(f"Indexed {added} entries", f"{added}件を索引化しました"),
        summary,
        {"added": added, "skipped": skipped, "total": total, "collection": collection_name},
    )


def sha1(value):
    return hashlib.sha1(value.encode("utf-8")).hexdigest()


def parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def result_ok(title, summary, data):
    return {
        "status": "ok",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": data,
        "suggestions": [],
    }


def result_error(title, summary):
    return {
        "status": "error",
        "title": title,
        "summary": summary,
        "outputs": {},
        "data": {},
        "suggestions": [],
    }
