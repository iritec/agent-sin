import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tiny localization helper used for framework-emitted UI strings (spinner
 * labels, chat narration, etc.) and packaged metadata such as builtin skill
 * names/descriptions.
 *
 * Locale resolution (only `en` and `ja` supported):
 *   1. AGENT_SIN_LOCALE env var (explicit override)
 *   2. Per-turn locale inferred from the current user message
 *   3. Configured locale via setLocale()
 *   4. LC_ALL or LANG starting with `ja` → `ja` (Unix shells)
 *   5. Intl.DateTimeFormat().resolvedOptions().locale starting with `ja`
 *      → `ja` (cross-platform OS locale, including Windows where step 2 is empty)
 *   6. Default: `en`
 */

export type Locale = "en" | "ja";

type Catalog = Record<Locale, string>;
type LocalizedMap = Partial<Record<Locale, unknown>>;
const localeContext = new AsyncLocalStorage<Locale>();

const STRINGS: Record<string, Catalog> = {
  "spinner.thinking": {
    en: "Thinking",
    ja: "考え中",
  },
  "spinner.skill_running": {
    en: "Running {skill}",
    ja: "{skill} を実行中",
  },
  "spinner.skill_repairing": {
    en: "Repairing {skill}",
    ja: "{skill} を修正中",
  },
  "chat.history_reset": {
    en: "Chat history reset.",
    ja: "会話履歴をリセットしました。",
  },
  "chat.tool_call_announce": {
    en: "→ Calling {skill}",
    ja: "→ {skill} を実行します",
  },
  "chat.skill_repair_started": {
    en: "→ Repairing {skill} after a failed run",
    ja: "→ {skill} が失敗したため修正します",
  },
  "chat.skill_repair_done": {
    en: "Repaired it and ran it again.",
    ja: "修正してもう一度実行しました。",
  },
  "chat.skill_repair_failed": {
    en: "Automatic repair could not finish: {message}",
    ja: "自動修正を完了できませんでした: {message}",
  },
  "chat.skill_repair_still_failed": {
    en: "It still failed after repair: {message}",
    ja: "修正後も実行できませんでした: {message}",
  },
  "chat.model_unreachable": {
    en: "[chat model '{model}' is unreachable] {message}",
    ja: "[chat-model '{model}' に接続できませんでした] {message}",
  },
  "skill.default_done": {
    en: "Done",
    ja: "完了",
  },
};

let active: Locale | null = null;

export function detectLocale(): Locale {
  const explicit = (process.env.AGENT_SIN_LOCALE || "").trim().toLowerCase();
  if (explicit === "ja" || explicit === "en") {
    return explicit;
  }
  const scoped = localeContext.getStore();
  if (scoped) {
    return scoped;
  }
  if (active) {
    return active;
  }
  // Respect an explicitly-set Unix shell locale even when it is not Japanese
  // (a user who typed `export LANG=en_US.UTF-8` wants English).
  const lang = (process.env.LC_ALL || process.env.LANG || "").trim();
  if (lang) {
    active = /^ja(_|$|-)/i.test(lang) ? "ja" : "en";
    return active;
  }
  // No shell-level locale set (typical on Windows or stripped-down envs):
  // fall back to the OS-reported locale via the Intl API.
  try {
    const intlLocale = (Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase();
    if (/^ja(-|$)/.test(intlLocale)) {
      active = "ja";
      return active;
    }
  } catch {
    // Intl API can fail in stripped-down builds; fall through to default.
  }
  active = "en";
  return active;
}

export function setLocale(locale: Locale | null): void {
  active = locale;
}

export function inferLocaleFromText(value: string | string[] | undefined): Locale | null {
  const text = Array.isArray(value) ? value.join("\n") : value || "";
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) {
    return "ja";
  }
  return null;
}

export function withLocale<T>(locale: Locale | null | undefined, fn: () => T): T {
  if (!locale) {
    return fn();
  }
  return localeContext.run(locale, fn);
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const locale = detectLocale();
  const entry = STRINGS[key];
  if (!entry) {
    return key;
  }
  let value = entry[locale] || entry.en || key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

export function l(en: string, ja: string, vars?: Record<string, string | number>): string {
  let value = detectLocale() === "ja" ? ja : en;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

export function lLines(en: string[], ja: string[]): string[] {
  return detectLocale() === "ja" ? ja : en;
}

export function localizeObject<T>(value: T, locale: Locale = detectLocale()): T {
  return resolveLocalizedFields(value, locale) as T;
}

function resolveLocalizedFields(value: unknown, locale: Locale): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveLocalizedFields(item, locale));
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.endsWith("_i18n")) {
      continue;
    }
    out[key] = resolveLocalizedFields(entry, locale);
  }

  for (const [key, entry] of Object.entries(value)) {
    if (!key.endsWith("_i18n")) {
      continue;
    }
    const baseKey = key.slice(0, -"_i18n".length);
    const localized = pickLocalizedEntry(entry, locale);
    if (localized !== undefined) {
      out[baseKey] = resolveLocalizedFields(localized, locale);
    }
  }
  return out;
}

function pickLocalizedEntry(value: unknown, locale: Locale): unknown {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const localized = value as LocalizedMap;
  if (localized[locale] !== undefined) {
    return localized[locale];
  }
  return localized.en;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
