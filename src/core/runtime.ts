import path from "node:path";
import type { AppConfig } from "./config.js";
import { appendEventLog, createRunId, writeRunLog } from "./logger.js";
import { loadSkillMemory, saveSkillMemoryUpdates } from "./memory.js";
import { writeSkillOutputs, type SavedOutput } from "./output-writer.js";
import { findSkillManifest, type SkillManifest } from "./skill-registry.js";
import { validateSkillArgs } from "./input-schema.js";
import { loadDotenv } from "./secrets.js";
import { ensureProfileMemoryFiles } from "./profile-memory.js";
import { runPythonSkill } from "../runtimes/python-runner.js";
import { runTypeScriptSkill } from "../runtimes/typescript-runner.js";
import type { SkillInput, SkillResult } from "../skills-sdk/types.js";
import { detectLocale, l, t } from "./i18n.js";

export interface RunSkillResponse {
  run_id: string;
  manifest: SkillManifest;
  result: SkillResult;
  saved_outputs: SavedOutput[];
  log_path: string;
  memory_path?: string;
  attempts: number;
}

export interface RunSkillOptions {
  /** @deprecated Approval gating was removed; field kept for API compatibility. */
  approved?: boolean;
  dryRun?: boolean;
}

export interface SkillLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  ts?: string;
}

export interface SkillExecution {
  result: SkillResult;
  memory_updates?: Record<string, unknown>;
  logs?: SkillLogEntry[];
}

export class SkillRunError extends Error {
  constructor(
    message: string,
    public readonly runId: string,
    public readonly skillId: string,
    public readonly logPath: string,
    public readonly originalMessage: string,
  ) {
    super(message);
    this.name = "SkillRunError";
  }
}

export async function runSkill(
  config: AppConfig,
  skillId: string,
  args: Record<string, unknown>,
  options: RunSkillOptions = {},
): Promise<RunSkillResponse> {
  await loadDotenv(config.workspace);
  await ensureProfileMemoryFiles(config);
  const manifest = await findSkillManifest(config.skills_dir, skillId);
  if (manifest.enabled === false) {
    throw new Error(l(`Skill is disabled: ${skillId}`, `スキルが無効です: ${skillId}`));
  }
  assertRequiredEnv(manifest);

  const runId = createRunId();
  const started = new Date();
  const memory = await loadSkillMemory(config, manifest);
  const input: SkillInput = {
    args,
    trigger: {
      type: "manual",
      id: "manual",
      time: started.toISOString(),
    },
    sources: {
      workspace: config.workspace,
      notes_dir: config.notes_dir,
      memory_dir: config.memory_dir,
      index_dir: config.index_dir,
      logs_dir: config.logs_dir,
      locale: detectLocale(),
    },
    memory,
  };
  input.args = validateSkillArgs(manifest, args);

  let attempts = 0;
  let lastError: unknown;
  try {
    const maxAttempts = Math.max(0, manifest.retry?.max_attempts || 0);
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt + 1;
      try {
        const execution = await executeSkill(config, manifest, input);
        const result = normalizeResult(execution.result);
        if (result.status === "error" && attempt < maxAttempts) {
          await waitRetryDelay(manifest);
          continue;
        }

        const savedOutputs =
          result.status === "ok" && !options.dryRun ? await writeSkillOutputs(config, manifest, result, started) : [];
        const memoryPath =
          result.status === "ok" && !options.dryRun
            ? await saveSkillMemoryUpdates(config, manifest, execution.memory_updates || {})
            : undefined;
        const finished = new Date().toISOString();
        const skillLogs = execution.logs || [];
        const logPath = await writeRunLog(config, {
          run_id: runId,
          skill_id: manifest.id,
          status: result.status,
          started_at: started.toISOString(),
          finished_at: finished,
          attempts,
          input,
          result,
          saved_outputs: savedOutputs,
          memory_path: memoryPath,
          dry_run: options.dryRun ? true : undefined,
          ctx_logs: skillLogs.length > 0 ? skillLogs : undefined,
        });
        for (const entry of skillLogs) {
          await appendEventLog(config, {
            ts: entry.ts,
            level: entry.level,
            source: "skill",
            event: "ctx_log",
            message: entry.message,
            details: { skill_id: manifest.id, run_id: runId, dry_run: options.dryRun ? true : undefined },
          });
        }

        return {
          run_id: runId,
          manifest,
          result,
          saved_outputs: savedOutputs,
          log_path: logPath,
          memory_path: memoryPath,
          attempts,
        };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await waitRetryDelay(manifest);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } catch (error) {
    const finished = new Date().toISOString();
    const logPath = await writeRunLog(config, {
      run_id: runId,
      skill_id: manifest.id,
      status: "error",
      started_at: started.toISOString(),
      finished_at: finished,
      attempts,
      input,
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new SkillRunError(`${message} (log: ${path.basename(logPath)})`, runId, manifest.id, logPath, message);
  }
}

async function executeSkill(config: AppConfig, manifest: SkillManifest, input: SkillInput): Promise<SkillExecution> {
  if (manifest.runtime === "python") {
    return runPythonSkill(config, manifest, input);
  }
  if (manifest.runtime === "typescript") {
    return runTypeScriptSkill(config, manifest, input);
  }
  throw new Error(l(`Unsupported runtime: ${manifest.runtime}`, `未対応の runtime です: ${manifest.runtime}`));
}

export class MissingEnvError extends Error {
  constructor(public readonly missing: Array<{ name: string; description?: string }>) {
    super(
      l(
        `Missing required env vars: ${missing.map((entry) => entry.name).join(", ")}`,
        `必要な環境変数が未設定です: ${missing.map((entry) => entry.name).join(", ")}`,
      ),
    );
    this.name = "MissingEnvError";
  }
}

export function findMissingRequiredEnv(
  manifest: SkillManifest,
): Array<{ name: string; description?: string }> {
  if (!manifest.required_env || manifest.required_env.length === 0) return [];
  const missing: Array<{ name: string; description?: string }> = [];
  for (const entry of manifest.required_env) {
    if (entry.optional) continue;
    const value = process.env[entry.name];
    if (!value || value.trim() === "") {
      missing.push({ name: entry.name, description: entry.description });
    }
  }
  return missing;
}

function assertRequiredEnv(manifest: SkillManifest): void {
  const missing = findMissingRequiredEnv(manifest);
  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }
}

async function waitRetryDelay(manifest: SkillManifest): Promise<void> {
  const delay = manifest.retry?.delay_ms || 0;
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function normalizeResult(result: SkillResult): SkillResult {
  return {
    status: result.status || "ok",
    title: result.title || t("skill.default_done"),
    summary: result.summary || "",
    outputs: result.outputs || {},
    data: result.data || {},
    suggestions: result.suggestions || [],
  };
}
