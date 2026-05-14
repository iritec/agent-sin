"""Common helpers for schedule-* builtin skills.

Provides load / dump / cron-validation helpers for the
~/.agent-sin/schedules.yaml file. PyYAML is used if available;
otherwise a minimal hand-written parser/serializer (sufficient for the
restricted schedules schema) is used.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any, Dict, List

try:
    import yaml as _yaml  # type: ignore
    HAS_PYYAML = True
except Exception:
    HAS_PYYAML = False


CANONICAL_KEY_ORDER = [
    "id",
    "description",
    "cron",
    "skill",
    "args",
    "enabled",
    "approve",
    "timezone",
]


def schedules_path(workspace: str) -> str:
    return os.path.join(workspace, "schedules.yaml")


def legacy_schedules_path(workspace: str) -> str:
    return os.path.join(workspace, "schedules", "schedules.yaml")


def _migrate_legacy_schedules(workspace: str) -> None:
    target = schedules_path(workspace)
    if os.path.exists(target):
        return
    legacy = legacy_schedules_path(workspace)
    if not os.path.exists(legacy):
        return
    with open(legacy, "r", encoding="utf-8") as src:
        content = src.read()
    with open(target, "w", encoding="utf-8") as dst:
        dst.write(content)
    try:
        os.remove(legacy)
        os.rmdir(os.path.dirname(legacy))
    except OSError:
        pass


def load_schedules(workspace: str) -> List[Dict[str, Any]]:
    path = schedules_path(workspace)
    if not os.path.exists(path):
        legacy = legacy_schedules_path(workspace)
        if os.path.exists(legacy):
            path = legacy
        else:
            return []
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    return _parse_schedules(raw)


def _parse_schedules(raw: str) -> List[Dict[str, Any]]:
    if not raw.strip():
        return []
    if HAS_PYYAML:
        data = _yaml.safe_load(raw) or {}
    else:
        data = _minimal_parse(raw)
    items = data.get("schedules") if isinstance(data, dict) else None
    return list(items) if isinstance(items, list) else []


def _minimal_parse(raw: str) -> Dict[str, Any]:
    schedules: List[Dict[str, Any]] = []
    current: Dict[str, Any] | None = None
    in_args = False
    in_schedules = False
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("schedules:"):
            in_schedules = True
            rest = line[len("schedules:"):].strip()
            if rest == "[]":
                return {"schedules": []}
            continue
        if not in_schedules:
            continue
        indent = len(line) - len(line.lstrip(" "))
        body = line.strip()
        if body.startswith("- "):
            if current is not None:
                schedules.append(current)
            current = {}
            in_args = False
            body = body[2:].strip()
            if ":" in body:
                k, _, v = body.partition(":")
                current[k.strip()] = _parse_scalar(v.strip())
            continue
        if current is None:
            continue
        if in_args and indent >= 6:
            if ":" in body:
                k, _, v = body.partition(":")
                current.setdefault("args", {})
                current["args"][k.strip()] = _parse_scalar(v.strip())
            continue
        if ":" in body:
            k, _, v = body.partition(":")
            key = k.strip()
            value = v.strip()
            if key == "args" and value in ("", "{}"):
                in_args = value == ""
                current["args"] = {}
            else:
                in_args = False
                current[key] = _parse_scalar(value)
    if current is not None:
        schedules.append(current)
    return {"schedules": schedules}


def _parse_scalar(value: str) -> Any:
    if value == "":
        return ""
    if value.startswith('"') and value.endswith('"'):
        try:
            return bytes(value[1:-1], "utf-8").decode("unicode_escape")
        except Exception:
            return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1]
    low = value.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    if low in ("null", "~"):
        return None
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value


def dump_schedules(items: List[Dict[str, Any]]) -> str:
    if not items:
        return "schedules: []\n"
    if HAS_PYYAML:
        cleaned = [_clean_item(item) for item in items]
        return _yaml.safe_dump(
            {"schedules": cleaned},
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        )
    lines = ["schedules:"]
    for item in items:
        cleaned = _clean_item(item)
        keys = [k for k in CANONICAL_KEY_ORDER if k in cleaned]
        keys.extend(k for k in cleaned.keys() if k not in keys)
        first = True
        for k in keys:
            v = cleaned[k]
            prefix = "  - " if first else "    "
            first = False
            if k == "args":
                if not v:
                    lines.append(f"{prefix}args: {{}}")
                    continue
                lines.append(f"{prefix}args:")
                for ak, av in v.items():
                    lines.append(f"      {ak}: {_yaml_scalar(av)}")
            else:
                lines.append(f"{prefix}{k}: {_yaml_scalar(v)}")
    lines.append("")
    return "\n".join(lines)


def _clean_item(item: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in item.items() if v is not None}


def _yaml_scalar(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    if _needs_quote(s):
        escaped = s.replace("\\", "\\\\").replace("\"", "\\\"")
        return f'"{escaped}"'
    return s


def _needs_quote(s: str) -> bool:
    if s == "":
        return True
    if s.strip() != s:
        return True
    if s.lower() in ("null", "true", "false", "yes", "no", "on", "off", "~"):
        return True
    bad_start = set("-?:[]{},#&*!|>'\"%@`")
    if s[0] in bad_start:
        return True
    for ch in s:
        if ch in (":", "#", "\n"):
            return True
    return False


def write_schedules_atomic(workspace: str, items: List[Dict[str, Any]]) -> str:
    _migrate_legacy_schedules(workspace)
    path = schedules_path(workspace)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = dump_schedules(items)
    # round-trip check before writing
    roundtrip = _parse_schedules(text)
    if len(roundtrip) != len(items):
        raise RuntimeError(
            "Round-trip check failed: parsed entry count "
            f"{len(roundtrip)} != original {len(items)}",
        )
    fd, tmp_path = tempfile.mkstemp(
        prefix=".schedules.", suffix=".yaml.tmp", dir=os.path.dirname(path)
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


def validate_cron(raw: str) -> None:
    fields = raw.strip().split()
    if len(fields) != 5:
        raise ValueError(
            f'Cron must have 5 fields ("min hour dom month dow"): "{raw}"',
        )
    spec = [
        (0, 59, "minute"),
        (0, 23, "hour"),
        (1, 31, "day-of-month"),
        (1, 12, "month"),
        (0, 6, "day-of-week"),
    ]
    for field, (mn, mx, label) in zip(fields, spec):
        _validate_cron_field(field, mn, mx, label)


def _validate_cron_field(field: str, mn: int, mx: int, label: str) -> None:
    for part in field.split(","):
        seg = part.strip()
        if not seg:
            raise ValueError(f'Empty segment in {label} field: "{field}"')
        body = seg
        step = 1
        if "/" in body:
            body, _, step_raw = body.partition("/")
            try:
                step = int(step_raw)
            except ValueError as exc:
                raise ValueError(
                    f'Invalid step "{step_raw}" in {label} field: "{field}"',
                ) from exc
            if step <= 0:
                raise ValueError(
                    f'Invalid step "{step_raw}" in {label} field: "{field}"',
                )
        if body == "" or body == "*":
            continue
        if "-" in body:
            a, _, b = body.partition("-")
            try:
                fr = int(a)
                to = int(b)
            except ValueError as exc:
                raise ValueError(
                    f'Invalid value "{body}" in {label} field: "{field}"',
                ) from exc
        else:
            try:
                fr = to = int(body)
            except ValueError as exc:
                raise ValueError(
                    f'Invalid value "{body}" in {label} field: "{field}"',
                ) from exc
        if fr < mn or to > mx or fr > to:
            raise ValueError(
                f'{label} value out of range ({fr}-{to}); allowed {mn}-{mx} for "{field}"',
            )
