import { spawn } from "node:child_process";
import { loadModels, type AppConfig, type ModelConfig } from "./config.js";
import { getApiKeys } from "./secrets.js";
import { getSharedCodexAppServer } from "../runtimes/codex-app-server.js";
import { l } from "./i18n.js";

export type AiRole = "system" | "user" | "assistant" | "tool";

export type AiMessageContent = string | AiContentPart[];

export type AiContentPart = AiTextPart | AiImagePart;

export interface AiTextPart {
  type: "text";
  text: string;
}

export interface AiImagePart {
  type: "image";
  image_url: string;
  mime_type?: string;
  filename?: string;
}

export interface AiMessage {
  role: AiRole;
  content: AiMessageContent;
}

export type AiProgressEvent =
  | { kind: "thinking"; text?: string }
  | { kind: "tool"; name?: string; text?: string }
  | { kind: "message"; text?: string }
  | { kind: "stderr"; text: string }
  | { kind: "info"; text: string };

export type AiProgressHandler = (event: AiProgressEvent) => void;

export type AiPermissionMode = "default" | "bypass";

export type AiRoleKind = "chat" | "builder";

export interface AiProviderRequest {
  model_id: string;
  messages: AiMessage[];
  system?: string;
  temperature?: number;
  onProgress?: AiProgressHandler;
  permission_mode?: AiPermissionMode;
  effort?: "low" | "medium" | "high" | "xhigh";
  cwd?: string;
  role?: AiRoleKind;
}

export interface AiProviderResponse {
  text: string;
  model_id: string;
  provider: string;
}

export class AiProviderError extends Error {
  constructor(message: string, public readonly model_id: string, public readonly provider: string) {
    super(message);
  }
}

export type AiProviderFn = (config: AppConfig, request: AiProviderRequest) => Promise<AiProviderResponse>;

let providerOverride: AiProviderFn | null = null;

export function setAiProviderOverride(fn: AiProviderFn | null): void {
  providerOverride = fn;
}

export function getAiProvider(): AiProviderFn {
  return providerOverride || runChatCompletion;
}

// skill.yaml の `ai_steps[].model` には実モデル ID（codex-low 等）と論理ロール名（chat / builder）の両方を許容する。
// 論理ロール名で書かれた場合は models.yaml の `roles` を引いて実モデル ID に解決する。
export function resolveModelId(modelId: string, models: ModelConfig): string {
  if (models.models[modelId]) {
    return modelId;
  }
  const roles = models.roles as Record<string, string | undefined> | undefined;
  const mapped = roles?.[modelId];
  return mapped && models.models[mapped] ? mapped : modelId;
}

export async function runChatCompletion(config: AppConfig, request: AiProviderRequest): Promise<AiProviderResponse> {
  if (process.env.AGENT_SIN_FAKE_PROVIDER === "1") {
    return fakeProvider(request);
  }

  const models = await loadModels(config.workspace);
  const resolvedModelId = resolveModelId(request.model_id, models);
  if (resolvedModelId !== request.model_id) {
    request = { ...request, model_id: resolvedModelId };
  }
  const entry = models.models[resolvedModelId];
  if (!entry) {
    throw new AiProviderError(l(`Unknown model: ${resolvedModelId}`, `不明なモデルです: ${resolvedModelId}`), resolvedModelId, "unknown");
  }
  if (entry.enabled === false) {
    throw new AiProviderError(
      l(`Model is disabled. Run: agent-sin model set ${resolvedModelId}`, `モデルが無効です。実行: agent-sin model set ${resolvedModelId}`),
      resolvedModelId,
      entry.provider || entry.type,
    );
  }

  if (entry.type === "ollama") {
    return dispatchOllama(request, entry);
  }
  if (entry.type === "api") {
    const provider = entry.provider || "openai";
    if (provider === "openai") {
      return dispatchOpenAI(request, entry);
    }
    if (provider === "gemini" || provider === "google") {
      return dispatchGemini(request, entry);
    }
    if (provider === "anthropic" || provider === "claude") {
      return dispatchAnthropic(request, entry);
    }
    throw new AiProviderError(l(`Unsupported api provider: ${provider}`, `未対応の API プロバイダです: ${provider}`), request.model_id, provider);
  }
  // "cli" は新名称、"login" は旧形式の互換受け入れ。
  if (entry.type === "cli" || entry.type === "login") {
    if (entry.provider === "codex") {
      return dispatchCodex(request, entry);
    }
    if (entry.provider === "claude-code") {
      return dispatchClaudeCode(request, entry);
    }
    throw new AiProviderError(l(`Unsupported cli provider: ${entry.provider}`, `未対応の CLI プロバイダです: ${entry.provider}`), request.model_id, String(entry.provider));
  }
  throw new AiProviderError(l(`Unsupported model type: ${entry.type}`, `未対応のモデル種別です: ${entry.type}`), request.model_id, entry.type);
}

let fakeCallIndex = 0;
let fakeScriptedValue: string | undefined;

function fakeProvider(request: AiProviderRequest): AiProviderResponse {
  const scripted = process.env.AGENT_SIN_FAKE_TEXTS;
  if (scripted) {
    if (scripted !== fakeScriptedValue) {
      fakeScriptedValue = scripted;
      fakeCallIndex = 0;
    }
    const parts = scripted.split("|||");
    const text = parts[fakeCallIndex] ?? parts[parts.length - 1] ?? "";
    fakeCallIndex += 1;
    return { text, model_id: request.model_id, provider: "fake" };
  }
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  return {
    text: `[fake:${request.model_id}] ${last ? messageContentToText(last.content) : ""}`.trim(),
    model_id: request.model_id,
    provider: "fake",
  };
}

export type ModelEntry = ModelConfig["models"][string];

async function dispatchOllama(request: AiProviderRequest, entry: ModelEntry): Promise<AiProviderResponse> {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const body = {
    model: entry.model || "qwen",
    messages: toTextChatMessages(request),
    stream: false,
  };
  const response = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new AiProviderError(`Ollama HTTP ${response.status}: ${detail}`, request.model_id, "ollama");
  }
  const json = (await response.json()) as { message?: { content?: string } };
  const text = json.message?.content || "";
  return { text, model_id: request.model_id, provider: "ollama" };
}

// OpenAI の chat/completions で `temperature` を受け付けるのは
// 旧世代の chat 系（gpt-4*, gpt-3.5*, およびそれらのファインチューン）のみ。
// gpt-5 系・o1/o3/o4 系はすべて reasoning モデルで temperature=1 固定。
// 2026 年以降に追加されるモデルも reasoning が既定になる見込みのため、
// 「既知のレガシー系だけ temperature を送る」ホワイトリスト方式で将来分も安全側に倒す。
const OPENAI_LEGACY_TEMPERATURE_PATTERN = /^(ft:)?(gpt-4|gpt-3\.5)/i;

export function openAIModelAcceptsTemperature(model: string | undefined): boolean {
  if (!model) return false;
  return OPENAI_LEGACY_TEMPERATURE_PATTERN.test(model);
}

export function buildOpenAIChatBody(
  request: AiProviderRequest,
  entry: ModelEntry,
): Record<string, unknown> {
  const model = entry.model || "gpt-5.4-mini";
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIChatMessages(request),
  };
  if (openAIModelAcceptsTemperature(model)) {
    body.temperature = request.temperature ?? 0.7;
  }
  return body;
}

// API プロバイダのエラーレスポンスを「人にわかりやすい一文＋直し方の手がかり」に整形する。
// 生 JSON をそのまま投げ返さず、よくあるパターン (モデル名タイポ・認証失敗) は
// 設定ファイルのどこを見直すべきかまで案内する。
export function formatProviderApiError(args: {
  provider: "openai" | "gemini" | "anthropic";
  modelEntryId: string; // models.yaml 側のエントリ ID
  modelName: string | undefined; // 実 API に渡したモデル名
  status: number;
  rawBody: string;
}): string {
  const { provider, modelEntryId, modelName, status, rawBody } = args;
  const parsed = tryParseJson(rawBody);
  const messageText = extractProviderErrorMessage(parsed) || rawBody.trim();

  if (isModelNotFoundError(provider, status, parsed, messageText)) {
    const lines = [
      l(`Model "${modelName ?? "(unset)"}" does not exist on ${provider} (HTTP ${status}).`, `モデル "${modelName ?? "(未指定)"}" は ${provider} に存在しません (HTTP ${status})。`),
      l(`Check models.${modelEntryId}.model in ~/.agent-sin/models.yaml.`, `~/.agent-sin/models.yaml の models.${modelEntryId}.model を見直してください。`),
    ];
    if (messageText) lines.push(l(`Original: ${truncate(messageText, 200)}`, `原文: ${truncate(messageText, 200)}`));
    return lines.join("\n");
  }
  if (status === 401 || status === 403) {
    const lines = [
      l(`${provider} authentication failed (HTTP ${status}).`, `${provider} の認証に失敗しました (HTTP ${status})。`),
      l("Check the API key in ~/.agent-sin/.env.", "~/.agent-sin/.env の API キーを確認してください。"),
    ];
    if (messageText) lines.push(l(`Original: ${truncate(messageText, 200)}`, `原文: ${truncate(messageText, 200)}`));
    return lines.join("\n");
  }
  // それ以外: メッセージだけ抜いて返す。生 JSON はもう吐かない。
  return `${provider} HTTP ${status}: ${truncate(messageText, 400)}`;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractProviderErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const error = root.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  const msg = root.message;
  return typeof msg === "string" ? msg : null;
}

function isModelNotFoundError(
  provider: string,
  status: number,
  parsed: unknown,
  messageText: string,
): boolean {
  if (status === 404) return true;
  const message = messageText.toLowerCase();
  if (
    message.includes("does not exist") ||
    message.includes("not found") ||
    message.includes("is not supported") ||
    message.includes("invalid model")
  ) {
    return true;
  }
  if (parsed && typeof parsed === "object") {
    const error = (parsed as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      const code = (error as Record<string, unknown>).code;
      const type = (error as Record<string, unknown>).type;
      if (code === "model_not_found" || type === "not_found_error") return true;
    }
  }
  void provider;
  return false;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

async function dispatchOpenAI(request: AiProviderRequest, entry: ModelEntry): Promise<AiProviderResponse> {
  const keys = getApiKeys("openai");
  if (keys.length === 0) {
    throw new AiProviderError("OPENAI_API_KEY is not set", request.model_id, "openai");
  }
  const body = buildOpenAIChatBody(request, entry);
  return rotateKeys(keys, request.model_id, "openai", async (apiKey) => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new AiProviderError(
        formatProviderApiError({
          provider: "openai",
          modelEntryId: request.model_id,
          modelName: entry.model,
          status: response.status,
          rawBody: text,
        }),
        request.model_id,
        "openai",
      );
      (error as AiProviderError & { status?: number }).status = response.status;
      throw error;
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content || "";
    return { text, model_id: request.model_id, provider: "openai" };
  });
}

async function dispatchGemini(request: AiProviderRequest, entry: ModelEntry): Promise<AiProviderResponse> {
  const keys = getApiKeys("gemini", ["google"]);
  if (keys.length === 0) {
    throw new AiProviderError(
      "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set",
      request.model_id,
      "gemini",
    );
  }
  const model = entry.model || "gemini-2.0-flash";
  const systemInstruction = collectSystem(request);
  const contents = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: toGeminiParts(message.content),
    }));
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }
  if (request.temperature !== undefined) {
    body.generationConfig = { temperature: request.temperature };
  }
  return rotateKeys(keys, request.model_id, "gemini", async (apiKey) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new AiProviderError(
        formatProviderApiError({
          provider: "gemini",
          modelEntryId: request.model_id,
          modelName: model,
          status: response.status,
          rawBody: text,
        }),
        request.model_id,
        "gemini",
      );
      (error as AiProviderError & { status?: number }).status = response.status;
      throw error;
    }
    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    return { text, model_id: request.model_id, provider: "gemini" };
  });
}

async function dispatchAnthropic(request: AiProviderRequest, entry: ModelEntry): Promise<AiProviderResponse> {
  const keys = getApiKeys("anthropic");
  if (keys.length === 0) {
    throw new AiProviderError("ANTHROPIC_API_KEY is not set", request.model_id, "anthropic");
  }
  const model = entry.model || "claude-opus-4-7";
  const systemInstruction = collectSystem(request);
  // Anthropic は role: "tool" を持たないので tool 結果は user メッセージとして
  // 流す。これで会話列が常に user で終わり、prefill エラー (HTTP 400) を防ぐ。
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: toAnthropicContent(message.content),
    }));
  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024,
    messages,
  };
  if (systemInstruction) {
    body.system = systemInstruction;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  return rotateKeys(keys, request.model_id, "anthropic", async (apiKey) => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new AiProviderError(
        formatProviderApiError({
          provider: "anthropic",
          modelEntryId: request.model_id,
          modelName: model,
          status: response.status,
          rawBody: text,
        }),
        request.model_id,
        "anthropic",
      );
      (error as AiProviderError & { status?: number }).status = response.status;
      throw error;
    }
    const json = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (json.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("");
    return { text, model_id: request.model_id, provider: "anthropic" };
  });
}

function toAnthropicContent(content: AiMessageContent): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.trim()) {
        parts.push({ type: "text", text: part.text });
      }
      continue;
    }
    const inline = dataUrlToInlineData(part.image_url, part.mime_type);
    if (inline) {
      parts.push({
        type: "image",
        source: { type: "base64", media_type: inline.mime_type, data: inline.data },
      });
    } else {
      parts.push({ type: "text", text: imagePartToText(part) });
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return parts;
}

async function rotateKeys<T>(
  keys: string[],
  modelId: string,
  providerLabel: string,
  call: (key: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < keys.length; i += 1) {
    try {
      return await call(keys[i]);
    } catch (error) {
      lastError = error;
      if (i === keys.length - 1 || !isRateLimitError(error)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AiProviderError(`${providerLabel} request failed`, modelId, providerLabel);
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const status = (error as { status?: number }).status;
  if (status === 429 || status === 503) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  return /\b(429|rate[ _-]?limit|quota|too[ _-]?many[ _-]?requests)\b/i.test(message);
}

function collectSystem(request: AiProviderRequest): string {
  const parts: string[] = [];
  if (request.system) {
    parts.push(request.system);
  }
  for (const message of request.messages) {
    if (message.role === "system") {
      parts.push(messageContentToText(message.content));
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

async function dispatchCodex(request: AiProviderRequest, entry: ModelEntry): Promise<AiProviderResponse> {
  const mode = (process.env.AGENT_SIN_CODEX_MODE || "auto").toLowerCase();
  const prompt = messagesToPrompt(request.messages);
  if (mode === "spawn") {
    return dispatchCodexSpawn(request, prompt, entry);
  }
  // appserver | auto: route through the app-server, including bypass mode (kingcoding-style).
  const sandbox = resolveCodexSandbox(request);
  const approvalPolicy = request.permission_mode === "bypass" ? "never" : undefined;
  const effort = resolveCodexEffort(request, entry);
  try {
    const session = getSharedCodexAppServer(entry.model);
    const text = await session.sendTurn(prompt, {
      effort,
      cwd: request.cwd || process.cwd(),
      sandbox,
      approvalPolicy,
      onProgress: request.onProgress,
    });
    return { text, model_id: request.model_id, provider: "codex" };
  } catch (error) {
    if (mode === "appserver") {
      throw new AiProviderError(
        `codex app-server failed: ${error instanceof Error ? error.message : String(error)}`,
        request.model_id,
        "codex",
      );
    }
    // auto: fall back to spawn so chat keeps working even if app-server is unavailable.
    return dispatchCodexSpawn(request, prompt, entry);
  }
}

async function dispatchCodexSpawn(
  request: AiProviderRequest,
  prompt: string,
  entry: ModelEntry,
): Promise<AiProviderResponse> {
  const bin = process.env.AGENT_SIN_CODEX_BIN || "codex";
  const extra = splitExtraArgs(process.env.AGENT_SIN_CODEX_ARGS);
  const sandbox = resolveCodexSandbox(request);
  const model = entry.model || process.env.AGENT_SIN_CODEX_MODEL;
  const args = ["exec", "--sandbox", sandbox];
  if (!extra.includes("--skip-git-repo-check")) {
    args.push("--skip-git-repo-check");
  }
  if (model && !extra.includes("--model") && !extra.includes("-m")) {
    args.push("--model", model);
  }
  args.push(...extra, "--", prompt);
  const text = await spawnCli(bin, args, request.model_id, "codex", request.onProgress, request.cwd);
  return { text, model_id: request.model_id, provider: "codex" };
}

function resolveCodexSandbox(
  request: AiProviderRequest,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (request.permission_mode !== "bypass") return "read-only";
  // Builder turns must not escape the draft (cwd) directory. workspace-write
  // permits writes only inside cwd; reads remain broad so the builder can
  // study agent-sin source / other skills.
  if (request.role === "builder") return "workspace-write";
  return "danger-full-access";
}

function resolveCodexEffort(
  request: AiProviderRequest,
  entry: ModelEntry,
): "low" | "medium" | "high" | "xhigh" {
  const allowed = new Set(["low", "medium", "high", "xhigh"]);
  const role: AiRoleKind = request.role || "chat";
  const envValue =
    role === "builder"
      ? process.env.AGENT_SIN_CODEX_BUILDER_EFFORT
      : process.env.AGENT_SIN_CODEX_EFFORT;
  const fallback = role === "builder" ? "xhigh" : "medium";
  const candidate =
    (entry.effort && allowed.has(entry.effort) ? entry.effort : undefined) ||
    request.effort ||
    envValue ||
    fallback;
  return (allowed.has(candidate) ? candidate : fallback) as "low" | "medium" | "high" | "xhigh";
}

async function dispatchClaudeCode(
  request: AiProviderRequest,
  entry: ModelEntry,
): Promise<AiProviderResponse> {
  const bin = process.env.AGENT_SIN_CLAUDE_BIN || "claude";
  const extra = splitExtraArgs(process.env.AGENT_SIN_CLAUDE_ARGS);
  const isBuilder = request.role === "builder";
  const tools = request.permission_mode === "bypass" ? ["--tools", "default"] : ["--tools="];
  // For builder turns, prefer acceptEdits + --add-dir so writes are scoped to cwd.
  // bypassPermissions disables every guard so we only keep it for non-builder uses.
  const permission =
    request.permission_mode === "bypass"
      ? isBuilder
        ? ["--permission-mode", "acceptEdits"]
        : ["--permission-mode", "bypassPermissions"]
      : [];
  const addDirArgs =
    isBuilder && request.permission_mode === "bypass" && request.cwd && !extra.includes("--add-dir")
      ? ["--add-dir", request.cwd]
      : [];
  const model = entry.model || process.env.AGENT_SIN_CLAUDE_MODEL;
  const modelArgs = model && !extra.includes("--model") && !extra.includes("-m") ? ["--model", model] : [];
  const effort = resolveClaudeEffort(request, entry);
  const effortArgs = effort && !extra.includes("--effort") ? ["--effort", effort] : [];
  const args = [
    "-p",
    ...tools,
    ...permission,
    ...addDirArgs,
    ...modelArgs,
    ...effortArgs,
    ...extra,
    messagesToPrompt(request.messages),
  ];
  const text = await spawnCli(bin, args, request.model_id, "claude-code", request.onProgress, request.cwd);
  return { text, model_id: request.model_id, provider: "claude-code" };
}

function resolveClaudeEffort(
  request: AiProviderRequest,
  entry: ModelEntry,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const allowed = new Set(["low", "medium", "high", "xhigh", "max"]);
  const role: AiRoleKind = request.role || "chat";
  const envValue =
    role === "builder"
      ? process.env.AGENT_SIN_CLAUDE_BUILDER_EFFORT
      : process.env.AGENT_SIN_CLAUDE_EFFORT;
  const candidate =
    (entry.effort && allowed.has(entry.effort) ? entry.effort : undefined) ||
    request.effort ||
    envValue;
  if (!candidate) {
    return undefined;
  }
  return allowed.has(candidate) ? (candidate as "low" | "medium" | "high" | "xhigh" | "max") : undefined;
}


function toChatMessages(request: AiProviderRequest): AiMessage[] {
  if (!request.system) {
    return request.messages;
  }
  return [{ role: "system", content: request.system }, ...request.messages];
}

function toTextChatMessages(request: AiProviderRequest): Array<{ role: AiRole; content: string }> {
  return toChatMessages(request).map((message) => ({
    role: message.role,
    content: messageContentToText(message.content),
  }));
}

function messagesToPrompt(messages: AiMessage[]): string {
  return messages
    .map((message) => {
      const content = messageContentToText(message.content);
      if (message.role === "system") {
        return `[system]\n${content}`;
      }
      if (message.role === "user") {
        return `[user]\n${content}`;
      }
      if (message.role === "tool") {
        return `[tool-result]\n${content}`;
      }
      return `[assistant]\n${content}`;
    })
    .join("\n\n");
}

type OpenAIChatMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

// OpenAI の chat/completions は `role: "tool"` を直前の assistant メッセージの
// `tool_calls` への返答としてしか許容しない（無いと HTTP 400）。
// agent-sin は markdown の skill-call ブロックで独自に skill 呼び出しを行うため
// tool_calls プロトコルには乗らない。よって OpenAI に投げる際だけ
// tool ロールは [tool-result] プレフィックス付きの user メッセージに畳む。
function toOpenAIChatMessages(request: AiProviderRequest): OpenAIChatMessage[] {
  return toChatMessages(request).map((message): OpenAIChatMessage => {
    const role: OpenAIChatMessage["role"] = message.role === "tool" ? "user" : message.role;
    const rawContent = Array.isArray(message.content)
      ? message.content
          .map((part) =>
            part.type === "image"
              ? { type: "image_url" as const, image_url: { url: part.image_url } }
              : { type: "text" as const, text: part.text },
          )
          .filter((part) => part.type !== "text" || part.text.trim().length > 0)
      : message.content;
    if (message.role !== "tool") {
      return { role, content: rawContent };
    }
    if (typeof rawContent === "string") {
      return { role, content: `[tool-result]\n${rawContent}` };
    }
    const prefixed: OpenAIChatMessage["content"] = [
      { type: "text", text: "[tool-result]" },
      ...rawContent,
    ];
    return { role, content: prefixed };
  });
}

function toGeminiParts(content: AiMessageContent): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.trim()) {
        parts.push({ text: part.text });
      }
      continue;
    }
    const inline = dataUrlToInlineData(part.image_url, part.mime_type);
    if (inline) {
      parts.push({ inline_data: inline });
    } else {
      parts.push({ text: imagePartToText(part) });
    }
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

function dataUrlToInlineData(
  value: string,
  fallbackMimeType?: string,
): { mime_type: string; data: string } | null {
  const match = value.match(/^data:([^;,]+)?;base64,([\s\S]+)$/);
  if (!match) {
    return null;
  }
  return {
    mime_type: match[1] || fallbackMimeType || "image/png",
    data: match[2],
  };
}

export function messageContentToText(content: AiMessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : imagePartToText(part)))
    .filter(Boolean)
    .join("\n");
}

function imagePartToText(part: AiImagePart): string {
  const meta = [part.filename, part.mime_type].filter(Boolean).join(" ");
  const url = part.image_url.startsWith("data:") ? "data-url" : part.image_url;
  return `[image${meta ? `: ${meta}` : ""}${url ? ` ${url}` : ""}]`;
}

function splitExtraArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(/\s+/).filter(Boolean);
}

async function spawnCli(
  bin: string,
  args: string[],
  modelId: string,
  provider: string,
  onProgress?: AiProgressHandler,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrLine = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (!onProgress) {
        return;
      }
      stderrLine += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = stderrLine.indexOf("\n")) >= 0) {
        const line = stderrLine.slice(0, newlineIndex).trim();
        stderrLine = stderrLine.slice(newlineIndex + 1);
        if (line) {
          onProgress({ kind: "stderr", text: line.slice(0, 160) });
        }
      }
    });
    child.on("error", (error) => {
      reject(new AiProviderError(`Failed to launch ${bin}: ${error.message}`, modelId, provider));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const err = Buffer.concat(stderr).toString("utf8").trim();
        reject(new AiProviderError(`${bin} exited with code ${code}${err ? `: ${err}` : ""}`, modelId, provider));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}
