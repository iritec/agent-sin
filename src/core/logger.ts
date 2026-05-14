import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { l } from "./i18n.js";

export interface RunLogRecord {
  run_id: string;
  skill_id: string;
  status: string;
  started_at: string;
  finished_at: string;
  attempts?: number;
  input: unknown;
  result?: unknown;
  error?: string;
  saved_outputs?: unknown[];
  memory_path?: string;
  dry_run?: boolean;
  ctx_logs?: Array<{ level: "info" | "warn" | "error"; message: string; ts?: string }>;
}

export type EventLogLevel = "info" | "warn" | "error";
export type EventLogSource = "cli" | "chat" | "skill" | "setup" | "build" | "schedule" | "discord" | "telegram";

export interface EventLogEntry {
  ts?: string;
  level: EventLogLevel;
  source: EventLogSource;
  event: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ReadEventLogOptions {
  tail?: number;
  level?: EventLogLevel;
  source?: EventLogSource;
}

export interface ReadEventLogResult extends EventLogEntry {
  ts: string;
  raw: string;
}

export function createRunId(): string {
  return crypto.randomUUID();
}

export async function writeRunLog(config: AppConfig, record: RunLogRecord): Promise<string> {
  const runsDir = path.join(config.logs_dir, "runs");
  await mkdir(runsDir, { recursive: true });
  const file = path.join(runsDir, `${record.run_id}.json`);
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  await appendFile(
    path.join(config.logs_dir, "app.log"),
    `${record.finished_at} ${record.status} ${record.skill_id} ${record.run_id}\n`,
    "utf8",
  );
  await appendEventLog(config, {
    ts: record.finished_at,
    level: record.status === "ok" ? "info" : record.status === "error" ? "error" : "warn",
    source: "skill",
    event: "run",
    message: record.error || extractSummary(record.result),
    details: {
      run_id: record.run_id,
      skill_id: record.skill_id,
      status: record.status,
      attempts: record.attempts,
      saved: Array.isArray(record.saved_outputs) ? record.saved_outputs.length : 0,
    },
  });
  return file;
}

export async function appendEventLog(config: AppConfig, entry: EventLogEntry): Promise<void> {
  await mkdir(config.logs_dir, { recursive: true });
  const ts = entry.ts || new Date().toISOString();
  const line = JSON.stringify({ ...entry, ts });
  await appendFile(path.join(config.logs_dir, "events.jsonl"), `${line}\n`, "utf8");
}

export type ConversationLogSource = "chat" | "builder";
export type ConversationLogRole = "user" | "assistant" | "system" | "tool";

export interface ConversationLogEntry {
  ts?: string;
  source: ConversationLogSource;
  role: ConversationLogRole;
  content: string;
  model_id?: string;
  skill_id?: string;
  session_id?: string;
  details?: Record<string, unknown>;
}

let conversationPruneAt = 0;

export async function appendConversationLog(
  config: AppConfig,
  entry: ConversationLogEntry,
): Promise<void> {
  const dir = path.join(config.logs_dir, "conversations");
  await mkdir(dir, { recursive: true });
  const ts = entry.ts || new Date().toISOString();
  const day = ts.slice(0, 10);
  const file = path.join(dir, `${day}.jsonl`);
  await appendFile(file, `${JSON.stringify({ ...entry, ts })}\n`, "utf8");
  await appendDailyConversationMemory(config, { ...entry, ts });
  await maybePruneOldLogs(config);
}

export function dailyConversationMemoryFile(config: AppConfig, date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return path.join(config.memory_dir, "daily", yyyy, MM, `${yyyy}-${MM}-${dd}.md`);
}

async function appendDailyConversationMemory(
  config: AppConfig,
  entry: ConversationLogEntry & { ts: string },
): Promise<void> {
  const date = new Date(entry.ts);
  const file = Number.isNaN(date.getTime())
    ? dailyConversationMemoryFile(config)
    : dailyConversationMemoryFile(config, date);
  const existing = await readTextIfExists(file);
  const titleDate = path.basename(file, ".md");
  const prefix = existing ? "" : `# ${titleDate}\n\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${prefix}${formatConversationMarkdownEntry(entry)}\n`, "utf8");
}

function formatConversationMarkdownEntry(entry: ConversationLogEntry & { ts: string }): string {
  const label = [entry.source, entry.role].filter(Boolean).join(" ");
  const content = entry.content.trim() || "(empty)";
  return [`## ${entry.ts} ${label}`, "", content].join("\n");
}

async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function maybePruneOldLogs(config: AppConfig): Promise<void> {
  const now = Date.now();
  if (now - conversationPruneAt < 60 * 60 * 1000) {
    return;
  }
  conversationPruneAt = now;
  try {
    await pruneOldLogs(config);
  } catch {
    // best-effort
  }
}

export async function pruneOldLogs(config: AppConfig): Promise<void> {
  const days = config.log_retention_days;
  if (days && days > 0) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    await pruneFilesByMtime(path.join(config.logs_dir, "conversations"), cutoff);
    await pruneFilesByMtime(path.join(config.logs_dir, "runs"), cutoff);
  }
  const eventDays = config.event_log_retention_days;
  if (eventDays && eventDays > 0) {
    const cutoff = Date.now() - eventDays * 24 * 60 * 60 * 1000;
    await pruneLinesByLeadingTimestamp(path.join(config.logs_dir, "events.jsonl"), cutoff, (line) => {
      try {
        const parsed = JSON.parse(line) as { ts?: string };
        return parsed.ts ? Date.parse(parsed.ts) : NaN;
      } catch {
        return NaN;
      }
    });
    await pruneLinesByLeadingTimestamp(path.join(config.logs_dir, "app.log"), cutoff, (line) => {
      const head = line.slice(0, 32).split(/\s/, 1)[0];
      return head ? Date.parse(head) : NaN;
    });
  }
}

async function pruneLinesByLeadingTimestamp(
  file: string,
  cutoff: number,
  extractTime: (line: string) => number,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const ts = extractTime(line);
    if (Number.isFinite(ts) && ts < cutoff) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) {
    return;
  }
  const next = kept.length > 0 ? `${kept.join("\n")}\n` : "";
  await writeFile(file, next, "utf8");
}

async function pruneFilesByMtime(dir: string, cutoff: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await rm(file, { force: true });
      }
    } catch {
      // ignore
    }
  }
}

export async function readEventLog(
  config: AppConfig,
  options: ReadEventLogOptions = {},
): Promise<ReadEventLogResult[]> {
  const file = path.join(config.logs_dir, "events.jsonl");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const entries: ReadEventLogResult[] = [];
  for (const line of lines) {
    let parsed: EventLogEntry;
    try {
      parsed = JSON.parse(line) as EventLogEntry;
    } catch {
      continue;
    }
    if (!parsed.level || !parsed.source || !parsed.event) {
      continue;
    }
    if (options.level && parsed.level !== options.level) {
      continue;
    }
    if (options.source && parsed.source !== options.source) {
      continue;
    }
    entries.push({ ...parsed, ts: parsed.ts || "", raw: line });
  }
  if (options.tail && options.tail > 0) {
    return entries.slice(-options.tail);
  }
  return entries;
}

function extractSummary(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const summary = (result as { summary?: unknown }).summary;
  if (typeof summary === "string" && summary.length > 0) {
    return summary;
  }
  return undefined;
}

export async function listRunLogs(config: AppConfig, skillId?: string): Promise<RunLogRecord[]> {
  const runsDir = path.join(config.logs_dir, "runs");
  let files: string[];
  try {
    files = await readdir(runsDir);
  } catch {
    return [];
  }

  const records: RunLogRecord[] = [];
  for (const file of files.filter((item) => item.endsWith(".json")).sort().reverse()) {
    try {
      const record = JSON.parse(await readFile(path.join(runsDir, file), "utf8")) as RunLogRecord;
      if (!skillId || record.skill_id === skillId) {
        records.push(record);
      }
    } catch {
      continue;
    }
  }
  return records;
}

export async function readRunLog(config: AppConfig, runId: string): Promise<RunLogRecord> {
  const file = path.join(config.logs_dir, "runs", `${runId}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as RunLogRecord;
  } catch {
    throw new Error(l(`Run log not found: ${runId}`, `実行ログが見つかりません: ${runId}`));
  }
}
