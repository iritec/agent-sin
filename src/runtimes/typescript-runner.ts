import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { resolveSkillEntryPath, type SkillManifest } from "../core/skill-registry.js";
import type { NotifyArgs, NotifyOutcome, SkillInput, SkillResult } from "../skills-sdk/types.js";
import type { SkillExecution, SkillLogEntry } from "../core/runtime.js";
import type { AppConfig } from "../core/config.js";
import { getAiProvider, type AiMessage } from "../core/ai-provider.js";
import { notify as runNotify } from "../core/notifier.js";

export async function runTypeScriptSkill(
  config: AppConfig,
  manifest: SkillManifest,
  input: SkillInput,
): Promise<SkillExecution> {
  const entry = await resolveSkillEntryPath(manifest);
  const skillDir = await realpath(manifest.dir);
  const moduleUrl = await prepareModule(skillDir, entry);
  const module = await import(`${moduleUrl.href}?run=${crypto.randomUUID()}`);
  const handler = resolveHandler(module, manifest.handler);
  const context = createContext(config, manifest, input.memory);
  const result = await handler(context.ctx, input);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`TypeScript skill did not return a result object: ${manifest.id}`);
  }
  return {
    result: result as SkillResult,
    memory_updates: context.memoryUpdates,
    logs: context.logs,
  };
}

async function prepareModule(skillDir: string, entry: string): Promise<URL> {
  if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
    const cacheDir = path.join(os.tmpdir(), "agent-sin-ts-runtime", crypto.randomUUID());
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await prepareDirectory(skillDir, cacheDir);
    const relativeEntry = path.relative(skillDir, entry).replace(/\.(tsx?|mts|cts)$/, ".js");
    return pathToFileURL(path.join(cacheDir, relativeEntry));
  }
  return pathToFileURL(entry);
}

async function prepareDirectory(sourceDir: string, targetDir: string): Promise<void> {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await prepareDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (/\.(tsx?|mts|cts)$/.test(entry.name)) {
      const outFile = targetPath.replace(/\.(tsx?|mts|cts)$/, ".js");
      await transpileFile(sourcePath, outFile);
      continue;
    }
    if (/\.(mjs|cjs|js|json)$/.test(entry.name)) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function transpileFile(sourcePath: string, targetPath: string): Promise<void> {
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      esModuleInterop: true,
      sourceMap: false,
    },
  });
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, compiled.outputText, "utf8");
}

type SkillHandler = (ctx: unknown, input: SkillInput) => SkillResult | Promise<SkillResult>;

function resolveHandler(module: Record<string, unknown>, handlerName: string): SkillHandler {
  const direct = module[handlerName];
  if (typeof direct === "function") {
    return direct as SkillHandler;
  }
  const fallback = module.default;
  if (fallback && typeof fallback === "object" && typeof (fallback as Record<string, unknown>)[handlerName] === "function") {
    return (fallback as Record<string, SkillHandler>)[handlerName];
  }
  if (handlerName === "default" && typeof fallback === "function") {
    return fallback as SkillHandler;
  }
  throw new Error(`TypeScript skill handler not found: ${handlerName}`);
}

function createContext(
  config: AppConfig,
  manifest: SkillManifest,
  initialMemory: Record<string, unknown>,
): { ctx: Record<string, unknown>; memoryUpdates: Record<string, unknown>; logs: SkillLogEntry[] } {
  const memory = new Map<string, unknown>(Object.entries(initialMemory || {}));
  const memoryUpdates: Record<string, unknown> = {};
  const logs: SkillLogEntry[] = [];
  const allowedSteps = new Map((manifest.ai_steps || []).map((step) => [step.id, step]));
  return {
    ctx: {
      log: {
        info: (message: unknown) => logs.push({ level: "info", message: String(message) }),
        warn: (message: unknown) => logs.push({ level: "warn", message: String(message) }),
        error: (message: unknown) => logs.push({ level: "error", message: String(message) }),
      },
      ai: {
        run: async (stepId: string, payload: unknown) => {
          const step = allowedSteps.get(stepId);
          if (!step) {
            throw new Error(`AI step is not defined for this skill: ${stepId}`);
          }
          const modelId = step.model || config.chat_model_id;
          try {
            const messages: AiMessage[] = [
              { role: "system", content: `You are an AI step "${step.id}" of an Agent-Sin skill. Purpose: ${step.purpose}` },
              { role: "user", content: typeof payload === "string" ? payload : JSON.stringify(payload) },
            ];
            const response = await getAiProvider()(config, { model_id: modelId, messages });
            return {
              status: "ok",
              step_id: stepId,
              model_id: modelId,
              provider: response.provider,
              text: response.text,
            };
          } catch (error) {
            if (step.optional) {
              return {
                status: "skipped",
                step_id: stepId,
                reason: error instanceof Error ? error.message : String(error),
                payload,
              };
            }
            throw error;
          }
        },
      },
      notify: async (args: NotifyArgs): Promise<NotifyOutcome> => {
        const result = await runNotify({
          title: args.title,
          body: args.body,
          subtitle: args.subtitle,
          sound: args.sound,
          channel: args.channel,
          to: args.to,
          discordThreadId: args.discordThreadId,
          telegramThreadId: args.telegramThreadId,
        });
        return { ok: result.ok, channel: result.channel, detail: result.detail };
      },
      memory: {
        get: async (key: string) => {
          if (manifest.memory?.read !== true) {
            return undefined;
          }
          return memory.get(key);
        },
        set: async (key: string, value: unknown) => {
          if (manifest.memory?.write !== true) {
            throw new Error("Memory write is not allowed for this skill");
          }
          memory.set(key, value);
          memoryUpdates[key] = value;
          return true;
        },
      },
      now: () => new Date().toISOString(),
    },
    memoryUpdates,
    logs,
  };
}
