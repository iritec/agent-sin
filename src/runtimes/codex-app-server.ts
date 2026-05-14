import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { l } from "../core/i18n.js";

export type CodexProgressEvent =
  | { kind: "thinking"; text?: string }
  | { kind: "tool"; name?: string; text?: string }
  | { kind: "message"; text?: string }
  | { kind: "info"; text: string };

export type CodexProgressHandler = (event: CodexProgressEvent) => void;

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export interface CodexTurnOptions {
  cwd?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  sandbox?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  onProgress?: CodexProgressHandler;
}

export interface CodexAppServerOptions {
  bin?: string;
  args?: string[];
  model?: string;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type NotificationHandler = (method: string, params: Record<string, unknown> | undefined) => void;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

function snippet(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const flat = value.replaceAll("\n", " ").trim();
  if (!flat) {
    return undefined;
  }
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}

const singletons = new Map<string, CodexAppServerSession>();

const DEFAULT_KEY = "__default__";

export function getSharedCodexAppServer(model?: string): CodexAppServerSession {
  const key = model && model.length > 0 ? model : DEFAULT_KEY;
  let session = singletons.get(key);
  if (!session) {
    session = new CodexAppServerSession(model ? { model } : {});
    singletons.set(key, session);
  }
  return session;
}

export async function shutdownSharedCodexAppServer(): Promise<void> {
  const sessions = [...singletons.values()];
  singletons.clear();
  await Promise.all(sessions.map((session) => session.stop().catch(() => undefined)));
}

export class CodexAppServerSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private starting: Promise<void> | null = null;
  private readonly options: Required<Omit<CodexAppServerOptions, "onStderr" | "model">> &
    Pick<CodexAppServerOptions, "onStderr" | "model">;
  private exitReason: string | null = null;

  constructor(options: CodexAppServerOptions = {}) {
    const baseArgs = options.args ? [...options.args] : ["app-server"];
    const model = options.model || process.env.AGENT_SIN_CODEX_MODEL;
    if (model && !baseArgs.includes("--model") && !baseArgs.includes("-m")) {
      baseArgs.push("--model", model);
    }
    this.options = {
      bin: options.bin || process.env.AGENT_SIN_CODEX_BIN || "codex",
      args: baseArgs,
      model,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      onStderr: options.onStderr,
    };
  }

  async sendTurn(text: string, options: CodexTurnOptions = {}): Promise<string> {
    await this.ensureStarted();
    const startResponse = (await this.send("thread/start", {
      cwd: options.cwd,
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    })) as { thread?: { id?: string } };
    const threadId = startResponse?.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server: thread/start did not return a thread id");
    }
    return await this.runTurn(threadId, text, options);
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.notificationHandlers.clear();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("codex app-server: shutting down"));
    }
    this.pending.clear();
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.isRunning() && !this.starting) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async start(): Promise<void> {
    // Windows wraps the codex CLI as a .cmd shim; Node's spawn cannot exec
    // those without a shell, so we enable shell only on win32.
    const child = spawn(this.options.bin, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    this.child = child;
    this.exitReason = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      if (this.options.onStderr) {
        this.options.onStderr(chunk);
      }
    });
    child.on("exit", (code, signal) => {
      this.exitReason = `exited code=${code} signal=${signal}`;
      const error = new Error(`codex app-server: ${this.exitReason}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.notificationHandlers.clear();
      this.child = null;
    });
    child.on("error", (error) => {
      this.exitReason = `spawn error: ${error.message}`;
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    const initTimer = setTimeout(() => {
      child.kill("SIGTERM");
    }, this.options.startupTimeoutMs);
    try {
      await this.send("initialize", {
        clientInfo: { name: "agent-sin", version: "0.1.0" },
      });
    } finally {
      clearTimeout(initTimer);
    }
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const handler = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (handler) {
          if (message.error) {
            handler.reject(new Error(`codex app-server error: ${message.error.message || JSON.stringify(message.error)}`));
          } else {
            handler.resolve(message.result);
          }
        }
        continue;
      }
      if (message.method) {
        for (const handler of this.notificationHandlers) {
          try {
            handler(message.method, message.params);
          } catch {
            // Notification handlers should not throw, but we ignore if they do.
          }
        }
      }
    }
  }

  private send(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error("codex app-server: not running"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      this.child!.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private runTurn(threadId: string, text: string, options: CodexTurnOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let assistantText = "";
      let settled = false;
      const emit = (event: CodexProgressEvent): void => {
        if (!options.onProgress) {
          return;
        }
        try {
          options.onProgress(event);
        } catch {
          // Progress handlers must not throw; ignore.
        }
      };
      const handler: NotificationHandler = (method, params) => {
        if (settled || !params) {
          return;
        }
        const eventThreadId = (params as { threadId?: string }).threadId;
        if (eventThreadId && eventThreadId !== threadId) {
          return;
        }
        if (method === "item/started" || method === "item/updated") {
          const item = (params as { item?: { type?: string; text?: string; name?: string } }).item;
          if (item) {
            if (item.type === "agentMessage") {
              emit({ kind: "message", text: snippet(item.text) });
            } else if (item.type === "reasoning" || item.type === "thinking") {
              emit({ kind: "thinking", text: snippet(item.text) });
            } else if (
              item.type === "command" ||
              item.type === "command_execution" ||
              item.type === "tool_call" ||
              item.type === "tool_use"
            ) {
              emit({ kind: "tool", name: item.name || item.type, text: snippet(item.text) });
            } else if (item.type) {
              emit({ kind: "info", text: `${item.type}${item.name ? `: ${item.name}` : ""}` });
            }
          }
        } else if (method === "item/completed") {
          const item = (params as { item?: { type?: string; text?: string; name?: string } }).item;
          if (item && item.type === "agentMessage" && typeof item.text === "string") {
            assistantText = item.text;
            emit({ kind: "message", text: snippet(item.text) });
          } else if (item && (item.type === "command" || item.type === "tool_call")) {
            emit({ kind: "tool", name: item.name || item.type, text: l("done", "完了") });
          }
        } else if (method === "turn/completed") {
          const turn = (params as { turn?: { items?: Array<{ type?: string; text?: string }> } }).turn;
          if (turn && Array.isArray(turn.items)) {
            const fromTurn = turn.items
              .filter((entry) => entry && entry.type === "agentMessage" && typeof entry.text === "string")
              .map((entry) => entry.text as string)
              .join("\n");
            if (fromTurn) {
              assistantText = fromTurn;
            }
          }
          finish(true, undefined);
        } else if (method === "turn/failed" || method === "error") {
          const reason = JSON.stringify(params).slice(0, 400);
          finish(false, new Error(`codex app-server: turn failed: ${reason}`));
        }
      };
      const finish = (ok: boolean, error: Error | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.notificationHandlers.delete(handler);
        if (ok) {
          resolve(assistantText);
        } else {
          reject(error || new Error("codex app-server: unknown failure"));
        }
      };
      const timeout = setTimeout(() => {
        finish(false, new Error(`codex app-server: turn timed out after ${this.options.turnTimeoutMs}ms`));
      }, this.options.turnTimeoutMs);
      this.notificationHandlers.add(handler);
      this.send("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        ...(options.effort ? { effort: options.effort } : {}),
      }).catch((sendError) => {
        finish(false, sendError instanceof Error ? sendError : new Error(String(sendError)));
      });
    });
  }
}
