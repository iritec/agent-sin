"""Common helpers for skills-disable / skills-enable builtin skills.

Reads/writes ~/.agent-sin/skill-settings.yaml in the same format used by
src/core/skill-settings.ts. PyYAML is used if available; otherwise a minimal
serializer for the single-key `disabled: [...]` document is used.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any, Dict, List, Tuple

try:
    import yaml as _yaml  # type: ignore
    HAS_PYYAML = True
except Exception:
    HAS_PYYAML = False


def skill_settings_path(workspace: str) -> str:
    return os.path.join(workspace, "skill-settings.yaml")


def load_skill_settings(workspace: str) -> Dict[str, Any]:
    path = skill_settings_path(workspace)
    if not os.path.exists(path):
        return {"disabled": []}
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    if not raw.strip():
        return {"disabled": []}
    if HAS_PYYAML:
        data = _yaml.safe_load(raw) or {}
    else:
        data = _minimal_parse(raw)
    disabled = data.get("disabled") if isinstance(data, dict) else None
    items: List[str] = []
    if isinstance(disabled, list):
        for entry in disabled:
            if isinstance(entry, str) and entry.strip():
                items.append(entry.strip())
    return {"disabled": items}


def dump_skill_settings(settings: Dict[str, Any]) -> str:
    disabled = sorted(set(settings.get("disabled") or []))
    if not disabled:
        return "disabled: []\n"
    if HAS_PYYAML:
        return _yaml.safe_dump(
            {"disabled": disabled},
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        )
    lines = ["disabled:"]
    for entry in disabled:
        lines.append(f"  - {_yaml_scalar(entry)}")
    lines.append("")
    return "\n".join(lines)


def save_skill_settings(workspace: str, settings: Dict[str, Any]) -> str:
    path = skill_settings_path(workspace)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    text = dump_skill_settings(settings)
    fd, tmp_path = tempfile.mkstemp(
        prefix=".skill-settings.", suffix=".yaml.tmp", dir=os.path.dirname(path) or "."
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


def set_skill_enabled(
    workspace: str, skill_id: str, enabled: bool
) -> Tuple[bool, Dict[str, Any]]:
    settings = load_skill_settings(workspace)
    disabled: List[str] = list(settings.get("disabled") or [])
    was_disabled = skill_id in disabled
    if enabled:
        if not was_disabled:
            return False, settings
        disabled = [d for d in disabled if d != skill_id]
    else:
        if was_disabled:
            return False, settings
        disabled.append(skill_id)
    settings["disabled"] = disabled
    save_skill_settings(workspace, settings)
    return True, settings


def _minimal_parse(raw: str) -> Dict[str, Any]:
    disabled: List[str] = []
    in_disabled = False
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line.startswith("disabled:"):
            rest = line[len("disabled:"):].strip()
            if rest == "[]" or rest == "":
                in_disabled = rest == ""
                continue
            if rest.startswith("[") and rest.endswith("]"):
                body = rest[1:-1]
                for token in body.split(","):
                    item = token.strip().strip('"').strip("'")
                    if item:
                        disabled.append(item)
                in_disabled = False
                continue
        if in_disabled:
            if stripped.startswith("- "):
                value = stripped[2:].strip().strip('"').strip("'")
                if value:
                    disabled.append(value)
            else:
                in_disabled = False
    return {"disabled": disabled}


def _yaml_scalar(value: str) -> str:
    if _needs_quote(value):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def _needs_quote(value: str) -> bool:
    if value == "":
        return True
    if value.strip() != value:
        return True
    if value.lower() in ("null", "true", "false", "yes", "no", "on", "off", "~"):
        return True
    bad_start = set("-?:[]{},#&*!|>'\"%@`")
    if value[0] in bad_start:
        return True
    for ch in value:
        if ch in (":", "#", "\n"):
            return True
    return False
