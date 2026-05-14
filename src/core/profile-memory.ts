import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { l } from "./i18n.js";

export type ProfileMemoryTarget = "soul" | "user" | "memory";

export interface ProfileMemoryFiles {
  soul: string;
  user: string;
  memory: string;
  paths: Record<ProfileMemoryTarget, string>;
}

const SOUL_TEMPLATE_EN = `# soul.md

<!--
Long-term notes about the AI itself.
Write explicit user-provided guidance for role, tone, judgment criteria, and durable behavior here.
-->
`;

const SOUL_TEMPLATE_JA = `# soul.md

<!--
AI自身についての長期メモを書く場所です。
役割、話し方、判断基準、継続したい姿勢などをユーザーが明示的に書きます。
-->
`;

const USER_TEMPLATE_EN = `# user.md

<!--
Long-term notes about the user.
Write explicit user-provided preferences, work context, things to avoid, and durable assumptions here.
-->
`;

const USER_TEMPLATE_JA = `# user.md

<!--
ユーザーについての長期メモを書く場所です。
好み、作業文脈、避けたいこと、長期的な前提などをユーザーが明示的に書きます。
-->
`;

const MEMORY_TEMPLATE_EN = `# memory.md

<!--
Long-term notes for understanding the user deeply and keeping conversations smooth.
Unlike user.md (fixed profile), this file stores updateable observations such as preferences, values, and communication patterns.
Edit and update existing items when new information arrives instead of only appending.
Do not write operating rules, schedules, or skill behavior settings here.
-->
`;

const MEMORY_TEMPLATE_JA = `# memory.md

<!--
ユーザーを深く理解し会話をスムーズにするための長期メモ。
user.md（固定プロフィール）に対し、こちらは嗜好・価値観・コミュニケーション傾向など
更新されうる観察を1行ずつ書く。新情報が入ったら追記ではなく既存項目を編集・更新していく。
運用ルール・スケジュール・スキル動作の設定はここに書かない。
-->
`;

export function profileMemoryDir(config: AppConfig): string {
  return path.join(config.memory_dir, "profile");
}

export function profileMemoryPath(config: AppConfig, target: ProfileMemoryTarget): string {
  return path.join(profileMemoryDir(config), `${target}.md`);
}

export async function ensureProfileMemoryFiles(config: AppConfig): Promise<ProfileMemoryFiles> {
  const paths = profileMemoryPaths(config);
  await mkdir(profileMemoryDir(config), { recursive: true });
  await writeIfMissing(paths.soul, l(SOUL_TEMPLATE_EN, SOUL_TEMPLATE_JA));
  await writeIfMissing(paths.user, l(USER_TEMPLATE_EN, USER_TEMPLATE_JA));
  await writeIfMissing(paths.memory, l(MEMORY_TEMPLATE_EN, MEMORY_TEMPLATE_JA));
  return {
    soul: await readFile(paths.soul, "utf8"),
    user: await readFile(paths.user, "utf8"),
    memory: await readFile(paths.memory, "utf8"),
    paths,
  };
}

export async function readProfileMemoryFiles(config: AppConfig): Promise<ProfileMemoryFiles> {
  const files = await ensureProfileMemoryFiles(config);
  return files;
}

export async function readProfileMemoryForPrompt(config: AppConfig): Promise<ProfileMemoryFiles> {
  const files = await ensureProfileMemoryFiles(config);
  return {
    soul: promptContent(files.soul, "soul"),
    user: promptContent(files.user, "user"),
    memory: promptContent(files.memory, "memory"),
    paths: files.paths,
  };
}

export async function appendProfileMemory(
  config: AppConfig,
  target: ProfileMemoryTarget,
  text: string,
  date = new Date(),
): Promise<string> {
  const value = text.trim();
  if (!value) {
    throw new Error(l("Profile text is empty", "プロフィールメモが空です"));
  }
  await ensureProfileMemoryFiles(config);
  const file = profileMemoryPath(config, target);
  await appendFile(file, formatProfileEntry(value, date), "utf8");
  return file;
}

export function parseProfileMemoryTarget(value: string | undefined): ProfileMemoryTarget | undefined {
  if (value === "soul" || value === "user" || value === "memory") {
    return value;
  }
  return undefined;
}

export function formatProfileEntry(text: string, date = new Date()): string {
  return `\n## ${date.toISOString()}\n\n${text.trim()}\n`;
}

export function formatProfileMemoryPromptSection(profileMemory: ProfileMemoryFiles | undefined): string[] {
  if (!profileMemory) {
    return [];
  }
  const lines: string[] = [];
  if (profileMemory.soul.trim()) {
    lines.push("<soul.md>", profileMemory.soul.trim(), "</soul.md>");
  }
  if (profileMemory.user.trim()) {
    lines.push("<user.md>", profileMemory.user.trim(), "</user.md>");
  }
  if (profileMemory.memory.trim()) {
    lines.push("<memory.md>", profileMemory.memory.trim(), "</memory.md>");
  }
  return lines;
}

function profileMemoryPaths(config: AppConfig): Record<ProfileMemoryTarget, string> {
  return {
    soul: profileMemoryPath(config, "soul"),
    user: profileMemoryPath(config, "user"),
    memory: profileMemoryPath(config, "memory"),
  };
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await stat(file);
  } catch {
    await writeFile(file, content, "utf8");
  }
}

function promptContent(raw: string, target: ProfileMemoryTarget): string {
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!withoutComments) {
    return "";
  }
  const lines = withoutComments.split(/\r?\n/);
  if (lines[0]?.trim().toLowerCase() === `# ${target}.md`) {
    lines.shift();
  }
  return lines.join("\n").trim();
}
