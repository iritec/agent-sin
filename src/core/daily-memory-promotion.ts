import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { getAiProvider } from "./ai-provider.js";
import { appendEventLog, dailyConversationMemoryFile, type EventLogSource } from "./logger.js";
import {
  appendProfileMemory,
  profileMemoryPath,
  readProfileMemoryFiles,
} from "./profile-memory.js";
import { l } from "./i18n.js";

export type DailyMemoryPromotionStatus =
  | "promoted"
  | "reviewed"
  | "skipped"
  | "not_found"
  | "empty"
  | "model_failed"
  | "invalid_response";

export interface DailyMemoryPromotionOptions {
  date?: string | Date;
  now?: Date;
  force?: boolean;
  dryRun?: boolean;
  modelId?: string;
  eventSource?: EventLogSource;
}

export interface DailyMemoryPromotionResult {
  status: DailyMemoryPromotionStatus;
  date: string;
  file: string;
  items: string[];
  message?: string;
}

interface PromotionState {
  dates: Record<
    string,
    {
      hash: string;
      status: "promoted" | "reviewed";
      promoted_at: string;
      items: number;
    }
  >;
}

const MAX_DAILY_CHARS = 24000;
const MAX_MEMORY_CHARS = 12000;
const MAX_PROMOTION_ITEMS = 3;
const MAX_ITEM_CHARS = 500;

export async function maybePromoteDailyMemory(
  config: AppConfig,
  options: DailyMemoryPromotionOptions = {},
): Promise<DailyMemoryPromotionResult> {
  let result: DailyMemoryPromotionResult;
  try {
    result = await promoteDailyMemory(config, options);
  } catch (error) {
    const date = safeNormalizeTargetDate(options.date, options.now || new Date());
    result = {
      status: "model_failed",
      date,
      file: dailyMemoryFileForDate(config, date),
      items: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.status === "promoted" || result.status === "reviewed" || result.status === "model_failed") {
    try {
      await appendEventLog(config, {
        level: result.status === "model_failed" ? "warn" : "info",
        source: options.eventSource || "chat",
        event: "daily_memory_promotion",
        message: result.message,
        details: {
          date: result.date,
          status: result.status,
          items: result.items.length,
          file: result.file,
        },
      });
    } catch {
      // Promotion must never block the primary chat / builder / gateway flow.
    }
  }
  return result;
}

export async function promoteDailyMemory(
  config: AppConfig,
  options: DailyMemoryPromotionOptions = {},
): Promise<DailyMemoryPromotionResult> {
  const date = normalizeTargetDate(options.date, options.now || new Date());
  const file = dailyMemoryFileForDate(config, date);
  const daily = await readTextIfExists(file);
  if (!daily) {
    return { status: "not_found", date, file, items: [], message: `daily memory not found: ${date}` };
  }
  if (!daily.replace(/^# .+$/m, "").trim()) {
    return { status: "empty", date, file, items: [], message: `daily memory is empty: ${date}` };
  }

  const hash = sha256(daily);
  const state = await readPromotionState(config);
  const previous = state.dates[date];
  if (!options.force && previous?.hash === hash) {
    return {
      status: "skipped",
      date,
      file,
      items: [],
      message: `daily memory already reviewed: ${date}`,
    };
  }

  const profile = await readProfileMemoryFiles(config);
  const response = await requestPromotionItems(config, {
    date,
    daily,
    existingMemory: profile.memory,
    modelId: options.modelId || config.chat_model_id,
  });
  if (response.status !== "ok") {
    return {
      status: response.status,
      date,
      file,
      items: [],
      message: response.message,
    };
  }

  const items = dedupePromotionItems(response.items, profile.memory);
  if (!options.dryRun && items.length > 0) {
    await appendProfileMemory(config, "memory", formatPromotedMemoryEntry(date, items), options.now || new Date());
    await consolidateMemoryFile(config, options.modelId || config.chat_model_id, options.eventSource || "chat");
  }
  if (!options.dryRun) {
    state.dates[date] = {
      hash,
      status: items.length > 0 ? "promoted" : "reviewed",
      promoted_at: (options.now || new Date()).toISOString(),
      items: items.length,
    };
    await writePromotionState(config, state);
  }

  return {
    status: items.length > 0 ? "promoted" : "reviewed",
    date,
    file,
    items,
    message: items.length > 0 ? `promoted ${items.length} item(s) from ${date}` : `no long-term memory items: ${date}`,
  };
}

export function parseDailyMemoryPromotionResponse(text: string): string[] {
  const jsonText = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(l(`invalid promotion JSON: ${message}`, `昇格用JSONが不正です: ${message}`));
  }
  const rawItems = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : [];
  return rawItems
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const value = record.text || record.summary || record.content;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .map(cleanPromotionItem)
    .filter(Boolean)
    .slice(0, MAX_PROMOTION_ITEMS);
}

async function requestPromotionItems(
  config: AppConfig,
  input: { date: string; daily: string; existingMemory: string; modelId: string },
): Promise<{ status: "ok"; items: string[] } | { status: "model_failed" | "invalid_response"; message: string }> {
  try {
    const response = await getAiProvider()(config, {
      model_id: input.modelId,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are Agent-Sin's long-term memory curator. memory.md is a long-term note used to understand the user deeply and keep conversations smooth.",
            "Promote only observations from daily conversation memory that directly help understand the user. Be strict; if unsure, output nothing. Maximum 3 items, zero is fine.",
            "Write each item in the same language as the source daily-conversation.md content.",
            "Keep only items directly about the user:",
            "- The user's role, experience, interests, and personal context",
            "- Communication tendencies, preferred style, disliked expressions, and decision habits",
            "- Values, beliefs, and things the user considers important",
            "- Notification/channel preferences, subscribed media, preferred formats",
            "- Stable interests or areas the user is not interested in",
            "Never keep operating rules, skill settings, or work logs:",
            "- Schedules, notification timing, notification destinations, filters, limits, or other skill behavior settings",
            "- Action rules tied to individual emails, files, or usernames",
            "- Recent task work, commits, fixes, or implementation steps",
            "- Same-day chat, impressions, status updates, progress, mood, health, or weather",
            "- Tool output, logs, code snippets, or URL lists",
            "- Content with the same meaning as existing memory.md",
            "- Secrets, API keys, tokens, sensitive finance/family information, or information identifying other people",
            "Output rules: each item must be one generic sentence or fact. Do not include dates, ongoing wording, or 'today I...' phrasing.",
            'Output JSON only: {"items":[{"text":"..."}]}. If nothing qualifies, return {"items":[]}.',
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Target date: ${input.date}`,
            "",
            "<existing-memory.md>",
            clip(input.existingMemory, MAX_MEMORY_CHARS),
            "</existing-memory.md>",
            "",
            "<daily-conversation.md>",
            clip(input.daily, MAX_DAILY_CHARS),
            "</daily-conversation.md>",
          ].join("\n"),
        },
      ],
    });
    return { status: "ok", items: parseDailyMemoryPromotionResponse(response.text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("invalid promotion JSON:") || message.startsWith("昇格用JSONが不正です:")) {
      return { status: "invalid_response", message };
    }
    return { status: "model_failed", message };
  }
}

function formatPromotedMemoryEntry(date: string, items: string[]): string {
  return [
    l(`Auto promotion: from daily conversation memory on ${date}`, `自動昇格: ${date} の日別会話記録から`),
    "",
    ...items.map((item) => `- ${item}`),
  ].join("\n");
}

const MEMORY_CONSOLIDATE_INPUT_MAX = 32000;
const MEMORY_HEADER_PATTERN = /^# memory\.md\s*$/im;

async function consolidateMemoryFile(
  config: AppConfig,
  modelId: string,
  eventSource: EventLogSource,
): Promise<void> {
  const file = profileMemoryPath(config, "memory");
  const original = await readTextIfExists(file);
  if (!original.trim()) return;

  const headerBlock = extractHeaderBlock(original);
  const body = original.slice(headerBlock.length);
  if (!body.trim()) return;

  try {
    const response = await getAiProvider()(config, {
      model_id: modelId,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You organize Agent-Sin long-term memory. memory.md is a long-term note for understanding the user. Read the body, remove duplicates and stale items, and edit/overwrite existing items with newer information. Do not let it grow by appending only.",
            "Output rules:",
            "- Return only the Markdown body. No preface, afterword, or code fences.",
            "- Write content in the same language as the original memory.md body.",
            "- Preserve the existing heading structure when possible and normalize content under headings to one fact per bullet line starting with '-'. Do not create date headers or 'Auto promotion: ...' / '自動昇格: ...' headings.",
            "- Merge items with the same meaning. If new information updates old information, discard the old version and rewrite to the latest state.",
            "- Always keep observations directly tied to understanding the user: role, preferences, values, communication tendencies, media preferences, and interests.",
            "- Remove operating rules, schedules, skill behavior settings, specific sender names, filters, recent task work, progress, and casual chat.",
            "- Do not keep sensitive finance/family information or information that identifies other people.",
            "- Do not invent content. Do not add facts not present in the source.",
            "- Each line must be a concise generic sentence or fact. Do not include dates or 'today I...' phrasing.",
            "- Keep the whole result to about 25 lines at most. Reduce further when possible.",
            "Even if the target is empty or does not need much cleanup, return the minimal bullet list that preserves the current state.",
          ].join("\n"),
        },
        {
          role: "user",
          content: ["<memory.md-body>", clip(body, MEMORY_CONSOLIDATE_INPUT_MAX), "</memory.md-body>"].join("\n"),
        },
      ],
    });
    const cleaned = sanitizeConsolidatedBody(response.text);
    if (!cleaned) return;
    const next = `${headerBlock.replace(/\s+$/, "")}\n\n${cleaned}\n`;
    if (normalizeForCompare(next) === normalizeForCompare(original)) return;

    await writeFile(`${file}.bak`, original, "utf8");
    await writeFile(file, next, "utf8");
    await appendEventLog(config, {
      level: "info",
      source: eventSource,
      event: "memory_consolidated",
      message: `memory.md consolidated (${body.length} -> ${cleaned.length} chars)`,
      details: { file, before_chars: body.length, after_chars: cleaned.length },
    });
  } catch (error) {
    await appendEventLog(config, {
      level: "warn",
      source: eventSource,
      event: "memory_consolidate_failed",
      message: error instanceof Error ? error.message : String(error),
      details: { file },
    });
  }
}

function extractHeaderBlock(raw: string): string {
  const match = MEMORY_HEADER_PATTERN.exec(raw);
  if (!match) return "";
  const headerStart = match.index;
  const afterHeader = raw.slice(headerStart);
  const commentEnd = afterHeader.indexOf("-->");
  if (commentEnd >= 0) {
    return raw.slice(0, headerStart + commentEnd + "-->".length);
  }
  const newlineIdx = afterHeader.indexOf("\n");
  if (newlineIdx < 0) return raw.slice(0, headerStart + match[0].length);
  return raw.slice(0, headerStart + newlineIdx);
}

function sanitizeConsolidatedBody(text: string): string {
  let body = text.trim();
  const fenced = body.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) body = fenced[1].trim();
  if (isStructuredModelPayload(body)) {
    return "";
  }
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith("- ") || line.startsWith("# ") ? line : line.replace(/^[-*・]?\s*/, "- ")));
  return lines.join("\n").trim();
}

function isStructuredModelPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function dedupePromotionItems(items: string[], existingMemory: string): string[] {
  const existing = normalizeForDedupe(existingMemory);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const cleaned = cleanPromotionItem(item);
    const key = normalizeForDedupe(cleaned);
    if (!cleaned || !key || seen.has(key) || existing.includes(key)) {
      continue;
    }
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function cleanPromotionItem(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*・]\s*/, "")
    .trim()
    .slice(0, MAX_ITEM_CHARS);
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1).trim();
  }
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1).trim();
  }
  return text.trim();
}

function normalizeTargetDate(value: string | Date | undefined, now: Date): string {
  if (value instanceof Date) {
    return localDateString(value);
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new Error(l(`Invalid date: ${trimmed}. Use YYYY-MM-DD.`, `日付が不正です: ${trimmed}。YYYY-MM-DD を使ってください。`));
    }
    return trimmed;
  }
  const previous = new Date(now);
  previous.setDate(previous.getDate() - 1);
  return localDateString(previous);
}

function safeNormalizeTargetDate(value: string | Date | undefined, now: Date): string {
  try {
    return normalizeTargetDate(value, now);
  } catch {
    return localDateString(now);
  }
}

function localDateString(date: Date): string {
  const yyyy = String(date.getFullYear());
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd}`;
}

function dailyMemoryFileForDate(config: AppConfig, date: string): string {
  const [yyyy, MM, dd] = date.split("-").map((part) => Number.parseInt(part, 10));
  return dailyConversationMemoryFile(config, new Date(yyyy, MM - 1, dd));
}

function promotionStateFile(config: AppConfig): string {
  return path.join(config.memory_dir, "daily", ".promotion-state.json");
}

async function readPromotionState(config: AppConfig): Promise<PromotionState> {
  try {
    const raw = await readFile(promotionStateFile(config), "utf8");
    const parsed = JSON.parse(raw) as PromotionState;
    return { dates: parsed.dates && typeof parsed.dates === "object" ? parsed.dates : {} };
  } catch {
    return { dates: {} };
  }
}

async function writePromotionState(config: AppConfig, state: PromotionState): Promise<void> {
  const file = promotionStateFile(config);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n\n... clipped ...`;
}
