"""Builtin: model-add

models.yaml にモデル定義を1件追加する。set_as が指定されていれば、
追加と同時に chat / builder ロールの既定モデルにする。
同じIDが既に同等の内容で登録されていれば idempotent に「登録済み」を返す。
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_shared"))
from i18n import localizer  # noqa: E402
from _models_lib import (  # noqa: E402
    build_entry,
    default_effort_for,
    derive_id,
    entries_equivalent,
    entry_summary,
    find_provider,
    load_models,
    models_path,
    normalize_effort,
    save_models,
    unique_id,
)


async def run(ctx, input):
    loc = localizer(input)
    args = input.get("args", {}) or {}
    workspace = input.get("sources", {}).get("workspace", "")
    if not workspace:
        return _err(loc.t("Workspace unavailable", "ワークスペース不明"),
                    loc.t("The workspace path is unavailable.", "workspace パスが取得できません"))

    provider_raw = str(args.get("provider", "")).strip()
    if not provider_raw:
        return _err(loc.t("Provider missing", "プロバイダ未指定"),
                    loc.t("Specify provider (codex / claude-code / openai / gemini / anthropic / ollama).",
                          "provider を指定してください (codex / claude-code / openai / gemini / anthropic / ollama)"))
    catalog = find_provider(provider_raw)
    if not catalog:
        return _err(loc.t("Unknown provider", "不明なプロバイダ"),
                    loc.t(f"Unknown provider: {provider_raw}", f"不明なプロバイダです: {provider_raw}"))

    model_raw = str(args.get("model", "")).strip()
    model = model_raw or catalog.get("default_model")

    set_as = str(args.get("set_as", "")).strip().lower() or None
    if set_as and set_as not in ("chat", "builder"):
        return _err(loc.t("Invalid set_as", "set_as 不正"),
                    loc.t('set_as must be "chat" or "builder".', 'set_as は "chat" か "builder" を指定してください'))

    try:
        effort = normalize_effort(args.get("effort"))
    except ValueError as e:
        return _err(loc.t("Invalid effort", "effort 不正"), str(e))
    if catalog.get("needs_effort") and not effort:
        # ロール優先度: set_as があればそれ、無ければ chat の既定を使う
        effort = default_effort_for(catalog, set_as or "chat")
    if not catalog.get("needs_effort") and effort:
        effort = None  # API 系では effort を持たない

    try:
        models = load_models(workspace)
    except Exception as e:
        return _err(loc.t("Load failed", "読込失敗"),
                    loc.t(f"Could not read models.yaml: {e}", f"models.yaml を読めませんでした: {e}"))

    existing_ids = set(models["models"].keys())
    requested_id = str(args.get("id", "")).strip() or None
    new_entry = build_entry(catalog, model, effort)

    # 冪等性: 既存のエントリに内容一致するものがあれば、それを再利用する。
    # requested_id があるときは、その ID が等価エントリでない限り別物として扱う。
    equivalent_id = None
    for eid, e in models["models"].items():
        if entries_equivalent(e, new_entry):
            equivalent_id = eid
            break

    if equivalent_id and (not requested_id or requested_id == equivalent_id):
        existing = models["models"][equivalent_id]
        roles_changed = False
        if set_as and models["roles"].get(set_as) != equivalent_id:
            models["roles"][set_as] = equivalent_id
            roles_changed = True
        if roles_changed:
            try:
                save_models(workspace, models)
            except Exception as e:
                return _err(loc.t("Save failed", "保存失敗"),
                            loc.t(f"Failed to write models.yaml: {e}", f"models.yaml への書き込みに失敗しました: {e}"))
            summary = loc.t(
                f"{equivalent_id} already existed; set as {set_as} model.",
                f"{equivalent_id} は既に登録済みでした。{set_as} の既定モデルに設定しました。")
        else:
            summary = loc.t(
                f"Already registered: {entry_summary(equivalent_id, existing)}",
                f"登録済みです: {entry_summary(equivalent_id, existing)}")
        ctx.log.info(f"model-add: equivalent entry exists id={equivalent_id} set_as={set_as}")
        return {
            "status": "ok",
            "title": loc.t("Already registered", "登録済み"),
            "summary": summary,
            "outputs": {},
            "data": {
                "id": equivalent_id,
                "entry": existing,
                "set_as": set_as,
                "already_registered": True,
                "path": models_path(workspace),
            },
            "suggestions": [],
        }

    # ID 決定: 明示指定があればそれを使う。なければ provider/effort から導出。
    if requested_id:
        new_id = requested_id
        if new_id in existing_ids:
            # 等価なら上で return 済み。ここに来るのは「同じIDで内容違い」のケース
            return _err(
                loc.t("ID conflict", "ID重複"),
                loc.t(
                    f'Model ID "{new_id}" already exists with different settings. Remove it first or use a different id.',
                    f'モデルID "{new_id}" は別の内容で既に登録されています。先に削除するか、別の id を指定してください'),
            )
    else:
        base = derive_id(catalog["id"], effort, catalog["type"])
        new_id = unique_id(base, existing_ids)

    models["models"][new_id] = new_entry
    if set_as:
        models["roles"][set_as] = new_id

    try:
        path = save_models(workspace, models)
    except Exception as e:
        return _err(loc.t("Save failed", "保存失敗"),
                    loc.t(f"Failed to write models.yaml: {e}", f"models.yaml への書き込みに失敗しました: {e}"))

    ctx.log.info(f"model-add: id={new_id} provider={catalog['id']} model={model} effort={effort} set_as={set_as}")

    if set_as:
        summary = loc.t(
            f"Added {entry_summary(new_id, new_entry)} and set as {set_as} model.",
            f"追加しました: {entry_summary(new_id, new_entry)}。{set_as} の既定モデルに設定しました。",
        )
    else:
        summary = loc.t(
            f"Added {entry_summary(new_id, new_entry)}.",
            f"追加しました: {entry_summary(new_id, new_entry)}",
        )

    return {
        "status": "ok",
        "title": loc.t("Added", "追加"),
        "summary": summary,
        "outputs": {},
        "data": {
            "id": new_id,
            "entry": new_entry,
            "set_as": set_as,
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
