import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { resolveSkillEntryPath, type SkillManifest } from "../core/skill-registry.js";
import type { SkillInput, SkillResult } from "../skills-sdk/types.js";
import type { SkillExecution, SkillLogEntry } from "../core/runtime.js";
import type { AppConfig } from "../core/config.js";
import { getAiProvider, type AiMessage } from "../core/ai-provider.js";
import { notify as runNotify } from "../core/notifier.js";

const AI_REQUEST_PREFIX = "AGENT_SIN_AI_REQUEST::";
const AI_RESPONSE_PREFIX = "AGENT_SIN_AI_RESPONSE::";
const NOTIFY_REQUEST_PREFIX = "AGENT_SIN_NOTIFY_REQUEST::";
const NOTIFY_RESPONSE_PREFIX = "AGENT_SIN_NOTIFY_RESPONSE::";
const CTX_LOG_PATTERN = /^\[(info|warn|error)\]\s+([\s\S]*)$/;

export function candidatePythonInterpreters(
  config: AppConfig,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const venvDir = path.join(config.workspace, ".venv");
  const fallback = platform === "win32" ? "python" : "python3";
  if (platform === "win32") {
    return [
      path.join(venvDir, "Scripts", "python.exe"),
      path.join(venvDir, "Scripts", "python"),
      fallback,
    ];
  }
  return [path.join(venvDir, "bin", "python"), fallback];
}

export function resolvePythonInterpreter(config: AppConfig): string {
  if (process.env.AGENT_SIN_PYTHON) {
    return process.env.AGENT_SIN_PYTHON;
  }
  const candidates = candidatePythonInterpreters(config);
  for (const candidate of candidates.slice(0, -1)) {
    try {
      const info = statSync(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Candidate not present; try the next one.
    }
  }
  return candidates[candidates.length - 1] || "python3";
}

export async function runPythonSkill(
  config: AppConfig,
  manifest: SkillManifest,
  input: SkillInput,
): Promise<SkillExecution> {
  const entry = await resolveSkillEntryPath(manifest);
  const python = resolvePythonInterpreter(config);
  const runtimePolicy = JSON.stringify({
    ai_steps: manifest.ai_steps || [],
    memory: manifest.memory || {},
  });
  const child = spawn(python, ["-c", runnerSource(), entry, manifest.handler, runtimePolicy], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });

  const stdout: Buffer[] = [];
  const stderrLines: string[] = [];
  const ctxLogs: SkillLogEntry[] = [];
  let stderrBuffer = "";

  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = stderrBuffer.indexOf("\n")) >= 0) {
      const line = stderrBuffer.slice(0, newlineIndex);
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      handleStderrLine(line);
    }
  });

  function handleStderrLine(line: string): void {
    if (line.startsWith(AI_REQUEST_PREFIX)) {
      const payloadJson = line.slice(AI_REQUEST_PREFIX.length);
      handleAiRequest(payloadJson).catch((error) => {
        stderrLines.push(`[ai-error] ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (line.startsWith(NOTIFY_REQUEST_PREFIX)) {
      const payloadJson = line.slice(NOTIFY_REQUEST_PREFIX.length);
      handleNotifyRequest(payloadJson).catch((error) => {
        stderrLines.push(`[notify-error] ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    const ctxMatch = line.match(CTX_LOG_PATTERN);
    if (ctxMatch) {
      ctxLogs.push({ level: ctxMatch[1] as SkillLogEntry["level"], message: ctxMatch[2] });
      return;
    }
    stderrLines.push(line);
  }

  async function handleAiRequest(payloadJson: string): Promise<void> {
    let request: { id: string; step_id: string; model_id: string; messages: AiMessage[] };
    try {
      request = JSON.parse(payloadJson);
    } catch (error) {
      child.stdin.write(
        `${AI_RESPONSE_PREFIX}${JSON.stringify({ id: "?", error: `Invalid AI request JSON: ${String(error)}` })}\n`,
      );
      return;
    }
    try {
      const response = await getAiProvider()(config, {
        model_id: request.model_id,
        messages: request.messages,
      });
      child.stdin.write(
        `${AI_RESPONSE_PREFIX}${JSON.stringify({ id: request.id, ok: true, response })}\n`,
      );
    } catch (error) {
      child.stdin.write(
        `${AI_RESPONSE_PREFIX}${JSON.stringify({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }

  async function handleNotifyRequest(payloadJson: string): Promise<void> {
    let request: { id: string; args: Record<string, unknown> };
    try {
      request = JSON.parse(payloadJson);
    } catch (error) {
      child.stdin.write(
        `${NOTIFY_RESPONSE_PREFIX}${JSON.stringify({ id: "?", ok: false, detail: `Invalid notify request JSON: ${String(error)}` })}\n`,
      );
      return;
    }
    try {
      const args = request.args || {};
      const result = await runNotify({
        title: String(args.title ?? ""),
        body: String(args.body ?? ""),
        subtitle: typeof args.subtitle === "string" ? args.subtitle : undefined,
        sound: Boolean(args.sound),
        channel: typeof args.channel === "string" ? (args.channel as never) : undefined,
        to: typeof args.to === "string" ? args.to : undefined,
        discordThreadId: typeof args.discordThreadId === "string" ? args.discordThreadId : undefined,
        telegramThreadId: typeof args.telegramThreadId === "string" ? args.telegramThreadId : undefined,
      });
      child.stdin.write(
        `${NOTIFY_RESPONSE_PREFIX}${JSON.stringify({ id: request.id, ok: result.ok, channel: result.channel, detail: result.detail })}\n`,
      );
    } catch (error) {
      child.stdin.write(
        `${NOTIFY_RESPONSE_PREFIX}${JSON.stringify({
          id: request.id,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  }

  child.stdin.write(JSON.stringify(input));
  child.stdin.write("\n");

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (stderrBuffer) {
    handleStderrLine(stderrBuffer);
    stderrBuffer = "";
  }

  const err = stderrLines.join("\n").trim();
  const out = Buffer.concat(stdout).toString("utf8").trim();
  if (code !== 0) {
    throw new Error(err || `Python skill exited with code ${code}`);
  }
  try {
    const parsed = JSON.parse(out) as unknown;
    if (isRunnerEnvelope(parsed)) {
      return {
        result: parsed.result as SkillResult,
        memory_updates: parsed.memory_updates,
        logs: ctxLogs,
      };
    }
    return { result: parsed as SkillResult, logs: ctxLogs };
  } catch {
    throw new Error(`Python skill did not return valid JSON${err ? `: ${err}` : ""}`);
  }
}

function isRunnerEnvelope(value: unknown): value is { result: unknown; memory_updates?: Record<string, unknown> } {
  return Boolean(value) && typeof value === "object" && (value as Record<string, unknown>).__agent_sin_runner === 1;
}

function runnerSource(): string {
  return String.raw`
import asyncio
import importlib.util
import json
import sys
import uuid
from datetime import datetime, timezone

skill_path = sys.argv[1]
handler_name = sys.argv[2]
policy = json.loads(sys.argv[3])
payload = json.loads(sys.stdin.readline())
allowed_ai_steps = {step.get("id"): step for step in policy.get("ai_steps", [])}
memory_policy = policy.get("memory") or {}

class Log:
    def info(self, message):
        print(f"[info] {message}", file=sys.stderr, flush=True)
    def warn(self, message):
        print(f"[warn] {message}", file=sys.stderr, flush=True)
    def error(self, message):
        print(f"[error] {message}", file=sys.stderr, flush=True)

class AI:
    async def run(self, step_id, ai_payload):
        step = allowed_ai_steps.get(step_id)
        if not step:
            raise RuntimeError(f"AI step is not defined for this skill: {step_id}")
        model_id = step.get("model") or ""
        if not model_id:
            raise RuntimeError(f"AI step has no model: {step_id}")
        prompt = ai_payload if isinstance(ai_payload, str) else json.dumps(ai_payload, ensure_ascii=False)
        messages = [
            {"role": "system", "content": f'You are an AI step "{step_id}" of an Agent-Sin skill. Purpose: ' + (step.get("purpose") or "")},
            {"role": "user", "content": prompt},
        ]
        request_id = str(uuid.uuid4())
        request = {"id": request_id, "step_id": step_id, "model_id": model_id, "messages": messages}
        print("AGENT_SIN_AI_REQUEST::" + json.dumps(request, ensure_ascii=False), file=sys.stderr, flush=True)
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("AI provider channel closed")
        marker = "AGENT_SIN_AI_RESPONSE::"
        idx = line.find(marker)
        if idx < 0:
            raise RuntimeError(f"Unexpected AI response: {line.strip()}")
        envelope = json.loads(line[idx + len(marker):])
        if not envelope.get("ok"):
            error_message = envelope.get("error") or "AI provider error"
            if step.get("optional"):
                return {"status": "skipped", "step_id": step_id, "reason": error_message, "payload": ai_payload}
            raise RuntimeError(error_message)
        response = envelope.get("response") or {}
        return {
            "status": "ok",
            "step_id": step_id,
            "model_id": response.get("model_id"),
            "provider": response.get("provider"),
            "text": response.get("text", ""),
        }

class Memory:
    def __init__(self):
        self.values = dict(payload.get("memory") or {})
        self.updates = {}
    async def get(self, key):
        if not memory_policy.get("read"):
            return None
        return self.values.get(key)
    async def set(self, key, value):
        if not memory_policy.get("write"):
            raise RuntimeError("Memory write is not allowed for this skill")
        self.values[key] = value
        self.updates[key] = value
        return True

async def notify_call(args):
    if not isinstance(args, dict):
        raise RuntimeError("ctx.notify requires a dict argument")
    request_id = str(uuid.uuid4())
    request = {"id": request_id, "args": args}
    print("AGENT_SIN_NOTIFY_REQUEST::" + json.dumps(request, ensure_ascii=False), file=sys.stderr, flush=True)
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Notify channel closed")
    marker = "AGENT_SIN_NOTIFY_RESPONSE::"
    idx = line.find(marker)
    if idx < 0:
        raise RuntimeError(f"Unexpected notify response: {line.strip()}")
    envelope = json.loads(line[idx + len(marker):])
    return {
        "ok": bool(envelope.get("ok")),
        "channel": envelope.get("channel"),
        "detail": envelope.get("detail"),
    }

class Ctx:
    def __init__(self):
        self.log = Log()
        self.ai = AI()
        self.memory = Memory()
    def now(self):
        return datetime.now(timezone.utc).isoformat()
    async def notify(self, args):
        return await notify_call(args)

spec = importlib.util.spec_from_file_location("agent_sin_skill", skill_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
handler = getattr(module, handler_name)
ctx = Ctx()
result = handler(ctx, payload)
if asyncio.iscoroutine(result):
    result = asyncio.run(result)
print(json.dumps({
    "__agent_sin_runner": 1,
    "result": result,
    "memory_updates": ctx.memory.updates
}, ensure_ascii=False))
`;
}
