from __future__ import annotations

import os


class Localizer:
    def __init__(self, locale: str):
        self.locale = locale

    def t(self, en: str, ja: str) -> str:
        return ja if self.locale == "ja" else en


def localizer(input_payload: dict | None = None) -> Localizer:
    return Localizer(detect_locale(input_payload))


def detect_locale(input_payload: dict | None = None) -> str:
    sources = (input_payload or {}).get("sources") or {}
    explicit = str(sources.get("locale") or os.environ.get("AGENT_SIN_LOCALE") or "").strip().lower()
    if explicit in {"en", "ja"}:
        return explicit
    lang = str(os.environ.get("LC_ALL") or os.environ.get("LANG") or "").strip().lower()
    if lang:
        return "ja" if lang.startswith("ja") else "en"
    return "en"
