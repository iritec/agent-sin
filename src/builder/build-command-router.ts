import type { AppConfig } from "../core/config.js";
import type { AiProgressHandler } from "../core/ai-provider.js";
import { l } from "../core/i18n.js";
import {
  buildChatLines,
  buildLines,
  buildListLines,
  buildStatusLines,
  buildTestLines,
} from "./build-commands.js";

export function isBuildCommandText(text: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => text === `${prefix}build` || text.startsWith(`${prefix}build `));
}

export async function runBuildCommandText(
  config: AppConfig,
  text: string,
  options: { displayPrefix: string; onProgress?: AiProgressHandler },
): Promise<string[]> {
  const tokens = text.trim().split(/\s+/);
  const sub = tokens[1];
  const prefix = options.displayPrefix;
  if (!sub) {
    return [
      l("Usage:", "使い方:"),
      l(`  ${prefix}build [skill-id] [request]`, `  ${prefix}build [skill-id] [要望]`),
      `  ${prefix}build list`,
      l(`  ${prefix}build chat <id> "message"`, `  ${prefix}build chat <id> "メッセージ"`),
      `  ${prefix}build test <id>`,
      `  ${prefix}build status <id>`,
    ];
  }
  if (sub === "list") {
    return buildListLines(config);
  }
  if (sub === "register") {
    return [
      l(
        `${prefix}build register is deprecated. Builder writes directly to skills/<id>/, so there is no registration step.`,
        `${prefix}build register は廃止されました。Builder が skills/<id>/ に直接書き込むので、登録ステップはありません。`,
      ),
    ];
  }
  if (sub === "test") {
    const skillId = tokens[2];
    if (!skillId) return [l(`Usage: ${prefix}build test <skill-id>`, `使い方: ${prefix}build test <skill-id>`)];
    return buildTestLines(config, skillId);
  }
  if (sub === "status") {
    const skillId = tokens[2];
    if (!skillId) return [l(`Usage: ${prefix}build status <skill-id>`, `使い方: ${prefix}build status <skill-id>`)];
    return buildStatusLines(config, skillId);
  }
  if (sub === "chat") {
    const skillId = tokens[2];
    const message = tokens.slice(3).join(" ").trim();
    if (!skillId || !message) return [l(`Usage: ${prefix}build chat <skill-id> "message"`, `使い方: ${prefix}build chat <skill-id> "メッセージ"`)];
    return buildChatLines(config, skillId, message, { onProgress: options.onProgress });
  }
  const skillId = sub;
  const prompt = tokens.slice(2).join(" ").trim();
  return buildLines(config, skillId, { prompt: prompt || undefined, onProgress: options.onProgress });
}
