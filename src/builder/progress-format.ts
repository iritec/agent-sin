import type { AiProgressEvent } from "../core/ai-provider.js";
import { l } from "../core/i18n.js";

export function progressIntervalMs(envName: string, fallback = 12000): number {
  const raw = Number.parseInt(process.env[envName] || "", 10);
  if (Number.isFinite(raw) && raw >= 1000) {
    return raw;
  }
  return fallback;
}

export function formatBuildProgress(
  event: AiProgressEvent,
  options: { detail?: boolean } = {},
): string | null {
  if (!options.detail) {
    return null;
  }
  return formatDetailedBuildProgress(event);
}

export function formatDetailedBuildProgress(event: AiProgressEvent): string | null {
  switch (event.kind) {
    case "info":
      return l(`Working: ${cleanProgressText(event.text)}`, `進めています: ${cleanProgressText(event.text)}`);
    case "thinking": {
      const detail = cleanProgressText(event.text || "");
      return detail ? l(`Thinking: ${detail}`, `考えています: ${detail}`) : l("Thinking", "考えています");
    }
    case "tool": {
      const name = cleanProgressText(event.name || "tool");
      const detail = cleanProgressText(event.text || "");
      return detail ? l(`Running tool: ${name} - ${detail}`, `ツール実行中: ${name} - ${detail}`) : l(`Running tool: ${name}`, `ツール実行中: ${name}`);
    }
    case "stderr": {
      const detail = cleanProgressText(event.text);
      return detail ? l(`Checking tool output: ${detail}`, `ツール出力を確認中: ${detail}`) : l("Checking tool output", "ツール出力を確認中");
    }
    case "message":
      return l("Preparing response", "応答を整理しています");
    default:
      return null;
  }
}

export function cleanProgressText(text: string): string {
  return text
    .replace(/```/g, "")
    .replace(/`/g, "'")
    .replace(/@/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}
