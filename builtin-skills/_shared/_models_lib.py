"""Common helpers for model-add / model-set / model-list builtin skills.

Reads/writes ~/.agent-sin/models.yaml in the format used by
src/core/config.ts. PyYAML is used; we accept that block-level comments
written by hand may not be preserved on save. Round-trip safety is achieved
by re-parsing before writing.

Mirrors the PROVIDER_CATALOG in src/core/config.ts. Keep them in sync.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any, Dict, List, Optional, Tuple

try:
    import yaml as _yaml  # type: ignore
    HAS_PYYAML = True
except Exception:
    HAS_PYYAML = False


ALLOWED_EFFORTS = ("low", "medium", "high", "xhigh")
ALLOWED_ROLES = ("chat", "builder")


# Mirrors PROVIDER_CATALOG in src/core/config.ts.
PROVIDER_CATALOG: List[Dict[str, Any]] = [
    {
        "id": "codex",
        "label": "Codex CLI",
        "type": "cli",
        "default_model": "gpt-5.5",
        "needs_effort": True,
        "default_chat_effort": "low",
        "default_builder_effort": "xhigh",
    },
    {
        "id": "claude-code",
        "label": "Claude Code CLI",
        "type": "cli",
        "default_model": "opus",
        "needs_effort": True,
        "default_chat_effort": "medium",
        "default_builder_effort": "xhigh",
    },
    {
        "id": "openai",
        "label": "OpenAI API",
        "type": "api",
        "default_model": "gpt-5.5",
        "needs_effort": False,
    },
    {
        "id": "gemini",
        "label": "Google Gemini API",
        "type": "api",
        "default_model": "gemini-2.5-flash",
        "needs_effort": False,
    },
    {
        "id": "anthropic",
        "label": "Anthropic API",
        "type": "api",
        "default_model": "claude-opus-4-7",
        "needs_effort": False,
    },
    {
        "id": "ollama",
        "label": "Ollama (local)",
        "type": "ollama",
        "default_model": "gemma4:26b",
        "needs_effort": False,
    },
]


PROVIDER_INDEX: Dict[str, Dict[str, Any]] = {p["id"]: p for p in PROVIDER_CATALOG}


def models_path(workspace: str) -> str:
    return os.path.join(workspace, "models.yaml")


def load_models(workspace: str) -> Dict[str, Any]:
    """Returns {"roles": {"chat": id?, "builder": id?}, "models": {id: entry, ...}}."""
    path = models_path(workspace)
    if not os.path.exists(path):
        return {"roles": {}, "models": {}}
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    if not raw.strip():
        return {"roles": {}, "models": {}}
    if not HAS_PYYAML:
        raise RuntimeError("PyYAML is required to read models.yaml")
    data = _yaml.safe_load(raw) or {}
    if not isinstance(data, dict):
        return {"roles": {}, "models": {}}
    roles = data.get("roles") if isinstance(data.get("roles"), dict) else {}
    models = data.get("models") if isinstance(data.get("models"), dict) else {}
    # Normalize legacy "login" -> "cli" in memory.
    normalized: Dict[str, Any] = {}
    for entry_id, entry in models.items():
        if not isinstance(entry, dict):
            continue
        copy = dict(entry)
        if copy.get("type") == "login":
            copy["type"] = "cli"
        normalized[str(entry_id)] = copy
    return {"roles": dict(roles), "models": normalized}


def save_models(workspace: str, data: Dict[str, Any]) -> str:
    """Write models.yaml. May drop hand-written comments."""
    if not HAS_PYYAML:
        raise RuntimeError("PyYAML is required to write models.yaml")
    path = models_path(workspace)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload: Dict[str, Any] = {}
    roles = data.get("roles") or {}
    if isinstance(roles, dict) and roles:
        payload["roles"] = {k: v for k, v in roles.items() if v}
    payload["models"] = data.get("models") or {}
    text = _yaml.safe_dump(
        payload,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    # round-trip check before writing
    parsed = _yaml.safe_load(text) or {}
    if not isinstance(parsed.get("models"), dict) or len(parsed["models"]) != len(payload["models"]):
        raise RuntimeError("Round-trip check failed when serializing models.yaml")
    fd, tmp_path = tempfile.mkstemp(
        prefix=".models.", suffix=".yaml.tmp", dir=os.path.dirname(path) or "."
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise
    return path


def derive_id(provider: str, effort: Optional[str], type_: str) -> str:
    """Mirror src/core/config.ts deriveSetupId."""
    if type_ == "cli" and effort:
        return f"{provider}-{effort}"
    if type_ == "ollama":
        return "ollama" if provider == "ollama" else provider
    return provider


def unique_id(base: str, existing: set) -> str:
    if base not in existing:
        return base
    n = 2
    while f"{base}-{n}" in existing:
        n += 1
    return f"{base}-{n}"


def build_entry(
    catalog_entry: Dict[str, Any],
    model: Optional[str],
    effort: Optional[str],
) -> Dict[str, Any]:
    # フィールド順は既存 models.yaml に合わせる: type / provider / model / effort / enabled
    entry: Dict[str, Any] = {"type": catalog_entry["type"]}
    if catalog_entry["type"] != "ollama":
        entry["provider"] = catalog_entry["id"]
    if model:
        entry["model"] = model
    if effort:
        entry["effort"] = effort
    entry["enabled"] = True
    return entry


def find_provider(provider: str) -> Optional[Dict[str, Any]]:
    return PROVIDER_INDEX.get((provider or "").strip().lower())


def normalize_effort(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    value = str(raw).strip().lower()
    if not value:
        return None
    if value not in ALLOWED_EFFORTS:
        raise ValueError(
            f'effort must be one of: {"/".join(ALLOWED_EFFORTS)} (got "{raw}")'
        )
    return value


def default_effort_for(catalog_entry: Dict[str, Any], role: str) -> Optional[str]:
    if not catalog_entry.get("needs_effort"):
        return None
    if role == "chat":
        return catalog_entry.get("default_chat_effort") or "low"
    return catalog_entry.get("default_builder_effort") or "xhigh"


def entry_summary(entry_id: str, entry: Dict[str, Any]) -> str:
    parts: List[str] = []
    provider = entry.get("provider") or entry.get("type") or ""
    parts.append(str(provider))
    if entry.get("model"):
        parts.append(str(entry["model"]))
    if entry.get("effort"):
        parts.append(f"effort={entry['effort']}")
    return f"{entry_id} ({' / '.join(parts)})"


def entries_equivalent(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    keys = ("type", "provider", "model", "effort")
    for k in keys:
        if (a.get(k) or None) != (b.get(k) or None):
            return False
    return True
