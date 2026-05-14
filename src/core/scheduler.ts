import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { l } from "./i18n.js";

export interface ScheduleEntry {
  id: string;
  cron: string;
  skill: string;
  enabled: boolean;
  args: Record<string, unknown>;
  approve: boolean;
  description?: string;
  expression: CronExpression;
}

export interface CronExpression {
  raw: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export interface CronField {
  values: Set<number>;
  isWildcard: boolean;
}

export async function loadSchedules(workspace: string): Promise<ScheduleEntry[]> {
  const file = schedulesFile(workspace);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    try {
      raw = await readFile(legacySchedulesFile(workspace), "utf8");
    } catch {
      return [];
    }
  }
  const parsed = YAML.parse(raw) as { schedules?: unknown } | null | undefined;
  const list = parsed && Array.isArray(parsed.schedules) ? (parsed.schedules as unknown[]) : [];
  const seen = new Set<string>();
  const entries: ScheduleEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = String(record.id || "").trim();
    if (!id) {
      throw new Error(l("Invalid schedule: missing id", "スケジュールが不正です: id がありません"));
    }
    if (seen.has(id)) {
      throw new Error(l(`Duplicate schedule id: ${id}`, `スケジュール id が重複しています: ${id}`));
    }
    seen.add(id);
    const cronText = String(record.cron || "").trim();
    if (!cronText) {
      throw new Error(l(`Invalid schedule '${id}': missing cron`, `スケジュール '${id}' が不正です: cron がありません`));
    }
    const skill = String(record.skill || "").trim();
    if (!skill) {
      throw new Error(l(`Invalid schedule '${id}': missing skill`, `スケジュール '${id}' が不正です: skill がありません`));
    }
    const expression = parseCron(cronText);
    const enabled = record.enabled === undefined ? true : Boolean(record.enabled);
    const args = isPlainObject(record.args) ? (record.args as Record<string, unknown>) : {};
    const approve = Boolean(record.approve);
    const description = record.description ? String(record.description) : undefined;
    entries.push({ id, cron: cronText, skill, enabled, args, approve, description, expression });
  }
  return entries;
}

export function schedulesFile(workspace: string): string {
  return path.join(workspace, "schedules.yaml");
}

export function legacySchedulesFile(workspace: string): string {
  return path.join(workspace, "schedules", "schedules.yaml");
}

export function parseCron(raw: string): CronExpression {
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(l(`Cron must have 5 fields ("min hour dom month dow"): "${raw}"`, `Cron は5フィールド ("min hour dom month dow") で指定してください: "${raw}"`));
  }
  return {
    raw,
    minute: parseField(fields[0], 0, 59, "minute"),
    hour: parseField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseField(fields[2], 1, 31, "day-of-month"),
    month: parseField(fields[3], 1, 12, "month"),
    dayOfWeek: parseField(fields[4], 0, 6, "day-of-week"),
  };
}

function parseField(field: string, min: number, max: number, label: string): CronField {
  const values = new Set<number>();
  let isWildcard = field === "*" || field === "*/1";
  for (const part of field.split(",")) {
    const segment = part.trim();
    if (!segment) {
      throw new Error(l(`Empty segment in ${label} field: "${field}"`, `${label} フィールドに空のセグメントがあります: "${field}"`));
    }
    let step = 1;
    let body = segment;
    const slashIndex = body.indexOf("/");
    if (slashIndex >= 0) {
      const stepRaw = body.slice(slashIndex + 1);
      const stepValue = Number.parseInt(stepRaw, 10);
      if (!Number.isFinite(stepValue) || stepValue <= 0) {
        throw new Error(l(`Invalid step "${stepRaw}" in ${label} field: "${field}"`, `${label} フィールドの step が不正です: "${stepRaw}" ("${field}")`));
      }
      step = stepValue;
      body = body.slice(0, slashIndex);
      isWildcard = isWildcard && step === 1;
    }
    let from = min;
    let to = max;
    if (body !== "" && body !== "*") {
      const dashIndex = body.indexOf("-");
      if (dashIndex >= 0) {
        from = Number.parseInt(body.slice(0, dashIndex), 10);
        to = Number.parseInt(body.slice(dashIndex + 1), 10);
        isWildcard = false;
      } else {
        from = Number.parseInt(body, 10);
        to = from;
        isWildcard = false;
      }
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error(l(`Invalid value "${body}" in ${label} field: "${field}"`, `${label} フィールドの値が不正です: "${body}" ("${field}")`));
      }
      if (from < min || to > max || from > to) {
        throw new Error(
          l(
            `${label} value out of range (${from}-${to}); allowed ${min}-${max} for "${field}"`,
            `${label} の値が範囲外です (${from}-${to}); 使用可能範囲 ${min}-${max} ("${field}")`,
          ),
        );
      }
    }
    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }
  return { values, isWildcard };
}

export function matchesCron(expression: CronExpression, date: Date): boolean {
  if (!expression.minute.values.has(date.getMinutes())) {
    return false;
  }
  if (!expression.hour.values.has(date.getHours())) {
    return false;
  }
  if (!expression.month.values.has(date.getMonth() + 1)) {
    return false;
  }
  const dom = expression.dayOfMonth;
  const dow = expression.dayOfWeek;
  const domMatch = dom.values.has(date.getDate());
  const dowMatch = dow.values.has(date.getDay());
  // POSIX cron: when both dom and dow are restricted, OR them; otherwise AND.
  if (!dom.isWildcard && !dow.isWildcard) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

export function nextRunAfter(expression: CronExpression, from: Date, lookaheadMinutes = 7 * 24 * 60): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < lookaheadMinutes; i += 1) {
    if (matchesCron(expression, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
