import { loadModels, type AppConfig } from "./config.js";
import { appendConversationLog, appendEventLog, readRunLog, type EventLogSource, type RunLogRecord } from "./logger.js";
import {
  getAiProvider,
  type AiImagePart,
  type AiMessage,
  type AiProgressEvent,
  type AiProgressHandler,
} from "./ai-provider.js";
import { listSkillManifests, type SkillManifest } from "./skill-registry.js";
import { runSkill, SkillRunError, type RunSkillResponse } from "./runtime.js";
import {
  buildDraftWithAgent,
  prepareRepairDraft,
  type BuilderHandoffTurn,
} from "../builder/builder-session.js";
import {
  formatProfileMemoryPromptSection,
  readProfileMemoryForPrompt,
  type ProfileMemoryFiles,
} from "./profile-memory.js";
import { maybePromoteDailyMemory } from "./daily-memory-promotion.js";
import { l, t } from "./i18n.js";

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

export interface SkillCall {
  id: string;
  args: Record<string, unknown>;
}

export interface ChatBuildSuggestion {
  type: "create" | "edit";
  skill_id: string;
  reason?: string;
}

export interface SpinnerLike {
  isActive(): boolean;
  start(label: string): void;
  update(label: string): void;
  stop(): void;
}

export type ChatProgressEvent =
  | { kind: "thinking"; iteration: number }
  | { kind: "tool_running"; skill_id: string }
  | { kind: "tool_repairing"; skill_id: string }
  | { kind: "tool_done"; skill_id: string; status: string }
  | { kind: "model_failed"; message: string };

export interface ChatRespondOptions {
  formatNarrative?: (text: string) => string;
  spinner?: SpinnerLike;
  eventSource?: EventLogSource;
  onChatProgress?: (event: ChatProgressEvent) => void;
  onAiProgress?: AiProgressHandler;
  onBuildSuggestion?: (suggestion: ChatBuildSuggestion) => void;
  preferredSkillId?: string;
  userImages?: AiImagePart[];
}

export const HISTORY_LIMIT = 20;
export const TOOL_CALL_MAX_ITERATIONS = 3;
const SKILL_CALL_BLOCK = "skill-call";
const BUILD_SUGGESTION_BLOCK = "agent-sin-build-suggestion";
const INTERNAL_BLOCK_NAMES = [SKILL_CALL_BLOCK, BUILD_SUGGESTION_BLOCK];
const REPAIR_FAILURE_PATTERN =
  /(traceback|exception|runtimeerror|syntaxerror|typeerror|nameerror|valueerror|importerror|module not found|exited with code|did not return valid json|handler not found|entry file not found|実行時|例外|エラー|失敗|読み取れません|できませんでした)/i;
const USER_FIXABLE_FAILURE_PATTERN =
  /(missing required env vars|invalid input for|is disabled|skill not found|not allowed|設定してください|必要な設定|未入力|アプリパスワード|api[_ -]?key|token|credentials?)/i;

export async function chatRespond(
  config: AppConfig,
  userText: string,
  history: ChatTurn[],
  options: ChatRespondOptions = {},
): Promise<string[]> {
  const formatNarrative = options.formatNarrative ?? ((text) => text);
  const spinner = options.spinner;
  const eventSource = options.eventSource ?? "chat";
  const emitProgress = (event: ChatProgressEvent) => {
    if (!options.onChatProgress) return;
    try {
      options.onChatProgress(event);
    } catch {
      // progress callbacks must not break the chat flow
    }
  };

  const skills = await listSkillManifests(config.skills_dir);
  const tools = skills.filter(isToolEligible);
  await maybePromoteDailyMemory(config, { eventSource });
  const profileMemory = await readProfileMemoryForPrompt(config);
  const systemPrompt = buildSystemPrompt(tools, options.preferredSkillId, profileMemory);
  const modelDisplay = await resolveDisplayModelName(config);
  const directSkillCall = resolveDirectSkillCall(tools, userText, options.preferredSkillId);
  let queuedAssistantText = directSkillCall ? formatSkillCallBlock(directSkillCall) : null;

  appendHistory(history, { role: "user", content: userText });
  const userTurnIndex = history.length - 1;
  const userImages = options.userImages || [];
  await appendEventLog(config, {
    level: "info",
    source: eventSource,
    event: "user_input",
    message: userText.slice(0, 200),
    details: { model_id: config.chat_model_id, length: userText.length },
  });
  await appendConversationLog(config, {
    source: "chat",
    role: "user",
    content: userText,
    model_id: config.chat_model_id,
  });

  const lines: string[] = [];
  const ensureVisibleReply = () => {
    if (lines.some((line) => line.trim().length > 0)) {
      return lines;
    }
    lines.push(formatNarrative(emptyChatFallback()));
    return lines;
  };
  const completedCallKeys = new Set<string>();
  let lastCompletedSummary = "";
  let pendingRawRangeStart: number | null = null;

  for (let iteration = 0; iteration < TOOL_CALL_MAX_ITERATIONS; iteration += 1) {
    let assistantText: string;
    let buildSuggestion: ChatBuildSuggestion | null = null;
    if (queuedAssistantText) {
      assistantText = queuedAssistantText;
      queuedAssistantText = null;
    } else {
      const baseLabel = `${modelDisplay}: ${t("spinner.thinking")}`;
      if (spinner) spinner.start(baseLabel);
      emitProgress({ kind: "thinking", iteration });
      const spinnerProgress = spinner ? makeSpinnerProgress(spinner, baseLabel) : null;
      const providerProgress =
        spinnerProgress || options.onAiProgress
          ? (event: AiProgressEvent) => {
              if (spinnerProgress) {
                spinnerProgress(event);
              }
              if (options.onAiProgress) {
                options.onAiProgress(event);
              }
            }
          : undefined;
      try {
        const messages: AiMessage[] = [
          { role: "system", content: systemPrompt },
          ...toAiMessages(history, userImages.length > 0 ? { index: userTurnIndex, images: userImages } : undefined),
        ];
        const provider = getAiProvider();
        const response = await provider(config, {
          model_id: config.chat_model_id,
          messages,
          onProgress: providerProgress,
        });
        buildSuggestion = parseBuildSuggestion(response.text);
        assistantText = stripBuildSuggestions(response.text);
        if (shouldRetryEmptyAssistantReply(assistantText, buildSuggestion)) {
          await appendEventLog(config, {
            level: "warn",
            source: eventSource,
            event: "empty_model_reply_retry",
            message: "model returned an empty chat reply; retrying once",
            details: { model_id: config.chat_model_id, iteration },
          });
          try {
            const retryResponse = await provider(config, {
              model_id: config.chat_model_id,
              messages: [
                ...messages,
                { role: "system", content: emptyReplyRetryPrompt() },
              ],
              onProgress: providerProgress,
            });
            buildSuggestion = parseBuildSuggestion(retryResponse.text);
            assistantText = stripBuildSuggestions(retryResponse.text);
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
            await appendEventLog(config, {
              level: "warn",
              source: eventSource,
              event: "empty_model_reply_retry_failed",
              message: retryMessage,
              details: { model_id: config.chat_model_id, iteration },
            });
          }
        }
        if (buildSuggestion && options.onBuildSuggestion) {
          try {
            options.onBuildSuggestion(buildSuggestion);
          } catch {
            // Build suggestions are optional metadata; never break chat.
          }
        }
      } catch (error) {
        if (spinner) spinner.stop();
        const message = error instanceof Error ? error.message : String(error);
        history.pop();
        await appendEventLog(config, {
          level: "error",
          source: eventSource,
          event: "model_failed",
          message,
          details: { model_id: config.chat_model_id },
        });
        emitProgress({ kind: "model_failed", message });
        return [t("chat.model_unreachable", { model: config.chat_model_id, message })];
      }
      if (spinner) spinner.stop();
    }

    const calls = parseSkillCalls(assistantText);
    const narrative = stripSkillCalls(assistantText).trim();
    // When the response invokes a side-effect skill (add/delete/send/save),
    // drop the LLM's narrative entirely. The deterministic skill result is
    // the only record — both for the user and for future-turn history reads.
    // This stops "今から追加します" from sitting next to a successful tool
    // result and being misread later as "not done yet".
    const hasSideEffectCall = calls.some((call) => {
      const tool = tools.find((skill) => skill.id === call.id);
      return tool?.side_effect === true;
    });
    const recordedAssistantText = hasSideEffectCall && narrative
      ? extractSkillCallBlocks(assistantText)
      : assistantText;

    appendHistory(history, { role: "assistant", content: recordedAssistantText });

    if (pendingRawRangeStart !== null) {
      if (calls.length > 0) {
        // Previous turn ran an output_mode: raw skill, but the model wants to
        // call another tool (e.g. todo-list -> todo-done). The intermediate
        // result is plumbing the user does not need to see — drop it.
        lines.length = pendingRawRangeStart;
        pendingRawRangeStart = null;
      } else {
        // Previous raw skill result is the final answer; skip the LLM's
        // narrative-only follow-up so the raw output stands alone.
        return ensureVisibleReply();
      }
    }

    if (narrative && !hasSideEffectCall) {
      lines.push(formatNarrative(narrative));
    } else if (!narrative && calls.length === 0 && buildSuggestion) {
      const prompt = buildSuggestion.type === "edit"
        ? l("I can fix that in build mode. Should I continue?", "ビルドモードで直せます。進めますか？")
        : l("I can create that in build mode. Should I continue?", "ビルドモードで作れます。進めますか？");
      lines.push(formatNarrative(prompt));
    } else if (!narrative && calls.length === 0) {
      lines.push(formatNarrative(emptyChatFallback()));
    }
    await appendEventLog(config, {
      level: "info",
      source: eventSource,
      event: "assistant_reply",
      message: narrative.slice(0, 200) || undefined,
      details: { model_id: config.chat_model_id, iteration, skill_calls: calls.map((call) => call.id) },
    });
    await appendConversationLog(config, {
      source: "chat",
      role: "assistant",
      content: assistantText,
      model_id: config.chat_model_id,
      details: { iteration, skill_calls: calls.map((call) => call.id) },
    });
    if (calls.length === 0) {
      return ensureVisibleReply();
    }

    const callsToRun = calls.filter((call) => !completedCallKeys.has(skillCallKey(call)));
    if (callsToRun.length === 0) {
      if (!narrative && lastCompletedSummary) {
        lines.push(formatNarrative(lastCompletedSummary));
      }
      await appendEventLog(config, {
        level: "info",
        source: eventSource,
        event: "tool_repeat_skipped",
        message: `model repeated already-completed skill calls: ${calls.map((call) => call.id).join(", ")}`,
        details: { model_id: config.chat_model_id, iteration },
      });
      return ensureVisibleReply();
    }

    const rawRangeStart = lines.length;
    let allRawOk = callsToRun.length > 0;
    for (const call of callsToRun) {
      const tool = tools.find((skill) => skill.id === call.id);
      if (!tool) {
        const message = `[skill not allowed: ${call.id}]`;
        lines.push(message);
        appendHistory(history, { role: "tool", content: toolResultJson(call.id, "error", message) });
        await appendEventLog(config, {
          level: "warn",
          source: eventSource,
          event: "skill_blocked",
          message,
          details: { skill_id: call.id },
        });
        allRawOk = false;
        continue;
      }
      const isRawMode = tool.output_mode === "raw";
      if (!isRawMode) {
        lines.push(t("chat.tool_call_announce", { skill: call.id }));
      }
      const execution = await runSkillCallWithSelfRepair(config, tool, call, userText, history, {
        spinner,
        emitProgress,
        eventSource,
      });
      lines.push(...execution.repairLines);
      if (execution.response) {
        const result = execution.response;
        const summary = [result.result.title, result.result.summary].filter(Boolean).join(" / ");
        const display = result.result.summary || result.result.title;
        const saved = result.saved_outputs.filter((item) => item.show_saved !== false).map((item) => item.path);
        if (display) {
          lines.push(display);
        }
        for (const savedPath of saved) {
          lines.push(`saved: ${savedPath}`);
        }
        if (result.result.status === "ok") {
          completedCallKeys.add(skillCallKey(call));
          if (display) {
            lastCompletedSummary = display;
          }
        }
        if (!isRawMode || result.result.status !== "ok") {
          allRawOk = false;
        }
        const historyData = isRawMode ? result.result.data : undefined;
        const historyContent = toolResultJson(call.id, result.result.status, summary, saved, historyData);
        appendHistory(history, {
          role: "tool",
          content: historyContent,
        });
        await appendConversationLog(config, {
          source: "chat",
          role: "tool",
          content: historyContent,
          skill_id: call.id,
          details: { status: result.result.status, run_id: result.run_id, saved },
        });
      } else {
        const message = execution.errorMessage;
        lines.push(`[skill error: ${message}]`);
        appendHistory(history, { role: "tool", content: toolResultJson(call.id, "error", message) });
        await appendEventLog(config, {
          level: "error",
          source: eventSource,
          event: "skill_error",
          message,
          details: { skill_id: call.id, args: call.args },
        });
        allRawOk = false;
      }
    }

    if (allRawOk) {
      pendingRawRangeStart = rawRangeStart;
    }
  }

  if (pendingRawRangeStart !== null) {
    return ensureVisibleReply();
  }

  lines.push("[tool call iterations exhausted]");
  await appendEventLog(config, {
    level: "warn",
    source: eventSource,
    event: "tool_iterations_exhausted",
    details: { model_id: config.chat_model_id, max: TOOL_CALL_MAX_ITERATIONS },
  });
  return lines;
}

type SkillAttempt =
  | { ok: true; response: RunSkillResponse; runLog?: RunLogRecord }
  | { ok: false; message: string; runLog?: RunLogRecord; runId?: string; logPath?: string };

type SkillCallRunOutcome =
  | { response: RunSkillResponse; repairLines: string[]; errorMessage?: undefined }
  | { response?: undefined; repairLines: string[]; errorMessage: string };

async function runSkillCallWithSelfRepair(
  config: AppConfig,
  tool: SkillManifest,
  call: SkillCall,
  userText: string,
  history: ChatTurn[],
  options: {
    spinner?: SpinnerLike;
    emitProgress: (event: ChatProgressEvent) => void;
    eventSource: EventLogSource;
  },
): Promise<SkillCallRunOutcome> {
  const firstAttempt = await attemptSkillRun(config, call, options);
  const firstFailure = failureFromAttempt(firstAttempt);
  if (!firstFailure || !shouldAttemptSelfRepair(firstFailure)) {
    return firstAttempt.ok
      ? { response: firstAttempt.response, repairLines: [] }
      : { errorMessage: firstAttempt.message, repairLines: [] };
  }

  const repairLines = [t("chat.skill_repair_started", { skill: call.id })];
  const failureContext = buildFailureContext(firstAttempt, firstFailure);
  const repair = await repairSkillAfterFailure(config, tool, call, userText, history, firstFailure, failureContext, options);
  if (!repair.ok) {
    repairLines.push(t("chat.skill_repair_failed", { message: repair.message }));
    return firstAttempt.ok
      ? { response: firstAttempt.response, repairLines }
      : { errorMessage: firstAttempt.message, repairLines };
  }

  const secondAttempt = await attemptSkillRun(config, call, options);
  const secondFailure = failureFromAttempt(secondAttempt);
  if (!secondFailure && secondAttempt.ok) {
    repairLines.push(t("chat.skill_repair_done"));
    return { response: secondAttempt.response, repairLines };
  }

  const stillFailure = secondFailure || "Skill failed after repair";
  repairLines.push(t("chat.skill_repair_still_failed", { message: shortError(stillFailure) }));
  return secondAttempt.ok
    ? { response: secondAttempt.response, repairLines }
    : { errorMessage: secondAttempt.message, repairLines };
}

async function attemptSkillRun(
  config: AppConfig,
  call: SkillCall,
  options: {
    spinner?: SpinnerLike;
    emitProgress: (event: ChatProgressEvent) => void;
  },
): Promise<SkillAttempt> {
  const spinner = options.spinner;
  if (spinner) spinner.start(t("spinner.skill_running", { skill: call.id }));
  options.emitProgress({ kind: "tool_running", skill_id: call.id });
  try {
    const response = await runSkill(config, call.id, call.args, { approved: true });
    options.emitProgress({ kind: "tool_done", skill_id: call.id, status: response.result.status });
    const runLog = await readRunLog(config, response.run_id).catch(() => undefined);
    return { ok: true, response, runLog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.emitProgress({ kind: "tool_done", skill_id: call.id, status: "error" });
    if (error instanceof SkillRunError) {
      const runLog = await readRunLog(config, error.runId).catch(() => undefined);
      return {
        ok: false,
        message,
        runLog,
        runId: error.runId,
        logPath: error.logPath,
      };
    }
    return { ok: false, message };
  } finally {
    if (spinner) spinner.stop();
  }
}

async function repairSkillAfterFailure(
  config: AppConfig,
  tool: SkillManifest,
  call: SkillCall,
  userText: string,
  history: ChatTurn[],
  failure: string,
  failureContext: string,
  options: {
    spinner?: SpinnerLike;
    emitProgress: (event: ChatProgressEvent) => void;
    eventSource: EventLogSource;
  },
): Promise<{ ok: true; summary: string } | { ok: false; message: string }> {
  const spinner = options.spinner;
  const baseLabel = t("spinner.skill_repairing", { skill: call.id });
  if (spinner) spinner.start(baseLabel);
  options.emitProgress({ kind: "tool_repairing", skill_id: call.id });
  await appendEventLog(config, {
    level: "warn",
    source: options.eventSource,
    event: "skill_self_repair_started",
    message: shortError(failure),
    details: { skill_id: call.id, args: call.args },
  });
  try {
    await prepareRepairDraft(config, tool);
    const result = await buildDraftWithAgent(config, call.id, buildRepairPrompt(tool, call, userText, failure, failureContext), {
      runtime: tool.runtime,
      handoff: buildRepairHandoff(history, call, failureContext),
      onProgress: spinner ? makeSpinnerProgress(spinner, baseLabel) : undefined,
    });
    await appendEventLog(config, {
      level: "info",
      source: options.eventSource,
      event: "skill_self_repair_finished",
      message: result.summary.slice(0, 200),
      details: {
        skill_id: call.id,
        files_written: result.files_written,
        status: result.state.status,
      },
    });
    return { ok: true, summary: result.summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEventLog(config, {
      level: "error",
      source: options.eventSource,
      event: "skill_self_repair_failed",
      message,
      details: { skill_id: call.id },
    });
    return { ok: false, message: shortError(message) };
  } finally {
    if (spinner) spinner.stop();
  }
}

function failureFromAttempt(attempt: SkillAttempt): string | null {
  if (!attempt.ok) {
    return attempt.message;
  }
  const result = attempt.response.result;
  const summary = [result.title, result.summary].filter(Boolean).join(" / ");
  if (result.status === "error") {
    return summary || "Skill returned error";
  }
  if (result.status === "skipped" && REPAIR_FAILURE_PATTERN.test(summary) && !USER_FIXABLE_FAILURE_PATTERN.test(summary)) {
    return summary;
  }
  return null;
}

function buildFailureContext(attempt: SkillAttempt, failure: string): string {
  const parts = [`failure: ${failure}`];
  if (!attempt.ok) {
    if (attempt.runId) {
      parts.push(`run_id: ${attempt.runId}`);
    }
    if (attempt.logPath) {
      parts.push(`log_path: ${attempt.logPath}`);
    }
    if (attempt.runLog) {
      parts.push("run_log:");
      parts.push(formatRunLogForRepair(attempt.runLog));
    }
    return parts.join("\n");
  }

  const response = attempt.response;
  parts.push(`run_id: ${response.run_id}`);
  parts.push(`log_path: ${response.log_path}`);
  if (attempt.runLog) {
    parts.push("run_log:");
    parts.push(formatRunLogForRepair(attempt.runLog));
  } else {
    parts.push(
      safeJson({
        status: response.result.status,
        attempts: response.attempts,
        result: redactSensitiveValues(response.result),
        saved_outputs: response.saved_outputs.map((item) => item.path),
      }),
    );
  }
  return parts.join("\n");
}

function formatRunLogForRepair(record: RunLogRecord): string {
  return safeJson({
    run_id: record.run_id,
    skill_id: record.skill_id,
    status: record.status,
    started_at: record.started_at,
    finished_at: record.finished_at,
    attempts: record.attempts,
    input: redactSensitiveValues(record.input),
    result: redactSensitiveValues(record.result),
    error: record.error,
    ctx_logs: record.ctx_logs,
    dry_run: record.dry_run,
  });
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length > 2000) {
      return `${value.slice(0, 2000)}...`;
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(api[_-]?key|token|secret|password|credential|authorization|cookie)/i.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactSensitiveValues(item);
  }
  return out;
}

function shouldAttemptSelfRepair(failure: string): boolean {
  if (!failure.trim()) return false;
  if (USER_FIXABLE_FAILURE_PATTERN.test(failure)) return false;
  return REPAIR_FAILURE_PATTERN.test(failure);
}

function buildRepairPrompt(
  tool: SkillManifest,
  call: SkillCall,
  userText: string,
  failure: string,
  failureContext: string,
): string {
  return [
    `${tool.id} failed while running. Fix the cause without asking the user again, while preserving the original goal.`,
    "",
    "User request:",
    truncateForPrompt(userText, 2000),
    "",
    "Skill call arguments:",
    truncateForPrompt(safeJson(call.args), 2000),
    "",
    "Failure:",
    truncateForPrompt(failure, 8000),
    "",
    "Run logs and diagnostics:",
    truncateForPrompt(failureContext, 12000),
    "",
    "Repair policy:",
    "- Fix root causes such as tracebacks, runtime exceptions, invalid JSON, or failures to parse natural language.",
    "- If credentials are the only missing piece, declare required_env correctly and do not break the implementation.",
    "- When logs are available, use input / result / error / ctx_logs as evidence.",
    "- Do not remove existing capabilities.",
    "- Make the skill runnable again with the same arguments.",
    "- Keep the user-facing response short, in the user's language, and say only what was fixed.",
  ].join("\n");
}

function buildRepairHandoff(history: ChatTurn[], call: SkillCall, failure: string): BuilderHandoffTurn[] {
  const recent = history.slice(-8).map((turn) => ({
    role: turn.role,
    content: truncateForPrompt(turn.content, 4000),
  }));
  return [
    ...recent,
    {
      role: "tool",
      content: toolResultJson(call.id, "error", truncateForPrompt(failure, 8000)),
    },
  ];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateForPrompt(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...`;
}

function shortError(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}

async function resolveDisplayModelName(config: AppConfig): Promise<string> {
  const entryId = config.chat_model_id;
  try {
    const models = await loadModels(config.workspace);
    const entry = models.models?.[entryId];
    if (entry?.model) return entry.model;
  } catch {
    // models.yaml may be unreadable in degraded environments — fall through.
  }
  return entryId;
}

export function makeSpinnerProgress(spinner: SpinnerLike, baseLabel: string): (event: AiProgressEvent) => void {
  return (event) => {
    if (!spinner.isActive()) {
      return;
    }
    const label = formatProgressLabel(baseLabel, event);
    if (label) {
      spinner.update(label);
    }
  };
}

export function formatProgressLabel(baseLabel: string, event: AiProgressEvent): string | null {
  switch (event.kind) {
    case "thinking":
      return `${baseLabel} — ${l("thinking", "思考中")}${event.text ? `: ${event.text}` : ""}`;
    case "tool":
      return `${baseLabel} — tool: ${event.name || "?"}${event.text ? ` ${event.text}` : ""}`;
    case "message":
      return event.text ? `${baseLabel} — ${l("response", "応答")}: ${event.text}` : null;
    case "info":
      return `${baseLabel} — ${event.text}`;
    case "stderr":
      return `${baseLabel} — ${event.text}`;
    default:
      return null;
  }
}

export function isToolEligible(skill: SkillManifest): boolean {
  return skill.enabled !== false;
}

export function buildSystemPrompt(
  skills: SkillManifest[],
  preferredSkillId?: string,
  profileMemory?: ProfileMemoryFiles,
): string {
  const lines: string[] = [
    "You are Agent-Sin conversation mode. Talk naturally with the user and call the registered skills below when useful.",
    "You cannot call unregistered skills or run arbitrary CLI commands directly.",
    "",
    "Output language: respond in the same language as the user's most recent message. If the user wrote in Japanese, respond in Japanese; otherwise respond in English. Match the user's level of formality.",
    "",
    "Important constraint: conversation mode cannot rewrite files.",
    "- Conversation mode runs in a read-only sandbox. Do not try to edit, create, or delete skill.yaml, main.py, or arbitrary files.",
    "- If a skill needs to be fixed or a new skill should be created, do not edit it yourself. Hand it to build mode after briefly confirming the direction.",
    "- Do not say that you identified edits but were blocked, or that you could update it if write access were available. Ask only for build-mode handoff when editing is needed.",
    "",
    "Response style:",
    "- Always respond to the user in plain text. Do not use Markdown styling, headings, bullet markers, numbered lists, inline code, fenced code blocks, links, or tables. If content is list-like, write it as plain sentences or simple line breaks. The only exception is the hidden internal fenced block described below.",
    "- Do not volunteer command syntax or usage lists. For typo-like input, infer the intent and answer directly, or ask one short question if needed.",
    "- If the user is naturally asking to create a new skill or edit an existing one, do not start implementing inside conversation mode. Briefly say what should be built or changed, then end with a one-line confirmation in the user's language (e.g. 'Should I switch to build mode to fix this?' / 'ビルドモードに入って直しますか？').",
    "- On any turn that asks for that confirmation, or that says you are handing off to build mode, include one hidden agent-sin-build-suggestion block at the end. If you mention a handoff without the block, no handoff happens.",
    "- If the user has already agreed with a short approval such as 'yes', 'go ahead', 'please do it', はい, お願い, 進めて, you may proceed with the handoff, but the same response must still include the block.",
    "- For agent-sin-build-suggestion, use type=create for a new skill and type=edit for an existing skill. skill_id must be a short kebab-case id. For edits, use an id from the available skills list.",
    "- For edits, never invent umbrella ids such as 'todo'. If the request spans several available skills, explain the split briefly and ask which exact skill should be changed first.",
    "- Do not explain internal storage details such as builtin packaging, workspace copies, or override flags unless the user explicitly asks.",
    "- If the user explicitly asks for help (!help, /help, etc.), another route shows help text. You do not need to create a command list yourself.",
    "",
    "When to call skills:",
    "- Call skills with side effects such as saving, recording, sending, deleting, or registering only when the user explicitly asks.",
    "- Especially for memo-save and other memo-writing skills, call them only when the user directly says to save, record, or memo something. Do not save just because content seems important.",
    "- Save to soul.md or user.md only when the user explicitly asks to write there.",
    "- Add to memory.md only when the conversation contains a strong long-term fact worth preserving, and at most one item per turn:",
    "  - A durable preference, style, or policy the user explicitly wants kept",
    "  - A continuing specification decision, agreement, or operating rule",
    "  - Fixed context that future conversations should repeatedly assume, such as role, environment, stakeholders, or stable personal attributes",
    "- Never write to memory.md for same-day chat, feelings, recent task progress, tool output, logs, code snippets, temporary mood or health, secrets/API keys/tokens, or facts already covered by the long-term profile above.",
    "- A memory.md entry must be one generic sentence or fact. Do not include dates or 'today I...' style wording. If unsure, do not write it.",
    "- Do not make a big announcement when memory.md is updated. Keep the normal response natural.",
    "- If the user pasted a spec, idea, or long text, respond conversationally first and do not decide to save it on your own. If needed, ask briefly whether to save it.",
    "- Call read/search skills only when needed to answer the user's question.",
    "",
    "Tool result handling:",
    "- If the immediately previous turn has a tool result (skill-result block), do not emit the same skill-call again. Use the result and give only the short conclusion in the user's language.",
    "- Do not call the same skill with the same arguments more than once for one request. Once it succeeds, stop and tell the user it is done.",
    "- skill-call blocks in history are past call records. Do not copy them. Emit a new call only when truly needed.",
    "- skill-result JSON may include a data field in addition to summary. If a later skill call needs values such as ids, read them from data instead of asking the user.",
    "- If history already contains the same id and args with a status: ok skill-result, it has already run. Do not rerun it; just say it is already done or already registered.",
    "",
    "How to call side-effect skills:",
    "- For skills marked '(side effect)', do not write a preface or completion text in the response body. Output only the skill-call block.",
    "- Do not write narration such as 'I will add it now', 'Added', or 'I will register it' together with a skill-call. The skill result provides the definitive completion text.",
    "- If arguments need confirmation, do not emit a skill-call. Ask briefly in the body, wait for yes, then emit the call in the next response.",
    "",
    "ToDo handling:",
    "- When the user wants to complete/delete a specific ToDo, first call todo-list, identify the matching item id from data.items, then call todo-done or todo-delete with that id. Do not ask the user for the id.",
    "- Ask briefly only when the matching ToDo cannot be narrowed to one item.",
  ];
  const profileLines = formatProfileMemoryPromptSection(profileMemory);
  if (profileLines.length > 0) {
    lines.push("", "Long-term profile:", ...profileLines);
  }
  if (preferredSkillId && skills.some((skill) => skill.id === preferredSkillId)) {
    lines.push(
      `- This input has been preclassified as intent to run ${preferredSkillId}. If the needed arguments can be inferred from the conversation, call that skill. Ask briefly only when required arguments are missing.`,
    );
  }
  lines.push("", "Available skills:");
  if (skills.length === 0) {
    lines.push("  (none)");
  } else {
    for (const skill of skills) {
      const tag = skill.side_effect ? " (side effect)" : "";
      lines.push(`- ${skill.id}${tag}: ${skill.description || skill.name}`);
      const phrases = skill.invocation?.phrases?.filter((p) => typeof p === "string" && p.trim().length > 0) || [];
      if (phrases.length > 0) {
        lines.push(`  Example phrases: ${phrases.slice(0, 5).join(" / ")}`);
      }
      lines.push(`  Input schema: ${JSON.stringify(skill.input.schema)}`);
    }
  }
  lines.push("");
  lines.push("When calling a skill, include a fenced block in this format:");
  lines.push("```skill-call");
  lines.push('{"id": "<skill-id>", "args": { ... }}');
  lines.push("```");
  lines.push("Multiple blocks are allowed. Run results are passed in the next turn with the `tool` role.");
  lines.push("When asking to create or edit a skill, include exactly one internal block in this format. Without it, build-mode handoff will not happen:");
  lines.push("```agent-sin-build-suggestion");
  lines.push('{"type":"create|edit","skill_id":"<kebab-case-id>","reason":"<short reason>"}');
  lines.push("```");
  lines.push("Conversation mode cannot rewrite files directly. When a skill must be fixed or created, do not write it yourself; ask for confirmation with the block above and hand off to build mode after the user's approval.");
  lines.push("If no skill call is needed, reply naturally in the user's language.");
  return lines.join("\n");
}

function skillCallKey(call: SkillCall): string {
  return `${call.id}:${stableStringify(call.args)}`;
}

function emptyChatFallback(): string {
  return l("I could not produce a reply. Please send it once more.", "返答を作れませんでした。もう一度送ってください。");
}

function emptyReplyRetryPrompt(): string {
  return "Your previous response was empty. Use the user's latest message and the conversation context to produce a short, useful reply now in the user's language. If a skill call is required, emit a valid skill-call block. If build mode is required, include a short visible confirmation question and the hidden build-suggestion block. Do not return an empty response.";
}

function shouldRetryEmptyAssistantReply(assistantText: string, buildSuggestion: ChatBuildSuggestion | null): boolean {
  return !buildSuggestion && parseSkillCalls(assistantText).length === 0 && stripSkillCalls(assistantText).trim().length === 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function parseSkillCalls(text: string): SkillCall[] {
  const calls: SkillCall[] = [];
  for (const block of findInternalControlBlocks(text, [SKILL_CALL_BLOCK])) {
    try {
      const parsed = JSON.parse(block.payload) as {
        id?: unknown;
        skill_id?: unknown;
        skillId?: unknown;
        args?: unknown;
        arguments?: unknown;
        input?: unknown;
      };
      const id = parsed.id ?? parsed.skill_id ?? parsed.skillId;
      if (typeof id !== "string") {
        continue;
      }
      const rawArgs = parsed.args ?? parsed.arguments ?? parsed.input;
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      calls.push({ id, args });
    } catch {
      continue;
    }
  }
  return calls;
}

export function stripSkillCalls(text: string): string {
  return removeInternalControlBlocks(text, [SKILL_CALL_BLOCK]).trim();
}

export function extractSkillCallBlocks(text: string): string {
  const blocks = findInternalControlBlocks(text, [SKILL_CALL_BLOCK]);
  return blocks.map((block) => text.slice(block.start, block.end).trim()).join("\n");
}

export function parseBuildSuggestion(text: string): ChatBuildSuggestion | null {
  for (const block of findInternalControlBlocks(text, [BUILD_SUGGESTION_BLOCK])) {
    try {
      const parsed = JSON.parse(block.payload) as {
        type?: unknown;
        skill_id?: unknown;
        reason?: unknown;
      };
      const type = parsed.type === "edit" ? "edit" : "create";
      const skillId = sanitizeSuggestedSkillId(String(parsed.skill_id || ""));
      if (!skillId) continue;
      return {
        type,
        skill_id: skillId,
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : undefined,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function stripBuildSuggestions(text: string): string {
  return removeInternalControlBlocks(text, [BUILD_SUGGESTION_BLOCK]).trim();
}

export function stripInternalControlBlocks(text: string): string {
  return removeInternalControlBlocks(text, INTERNAL_BLOCK_NAMES)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface InternalControlBlock {
  name: string;
  payload: string;
  start: number;
  end: number;
}

interface TextLine {
  text: string;
  start: number;
  end: number;
}

function findInternalControlBlocks(text: string, names: string[]): InternalControlBlock[] {
  const wanted = new Set(names.map(normalizeInternalBlockName));
  const lines = splitLinesWithOffsets(text);
  const blocks: InternalControlBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.text.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z][A-Za-z0-9_-]*)?\s*$/);
    if (fence) {
      let name = normalizeInternalBlockName(fence[2] || "");
      let payloadStartLine = index + 1;
      if (!name && payloadStartLine < lines.length) {
        const splitName = normalizeInternalBlockName(lines[payloadStartLine].text.trim());
        if (wanted.has(splitName)) {
          name = splitName;
          payloadStartLine += 1;
        }
      }
      if (wanted.has(name)) {
        const closeLine = findClosingFenceLine(lines, payloadStartLine, fence[1]);
        const payloadStart = payloadStartLine < lines.length ? lines[payloadStartLine].start : line.end;
        const payloadEnd = closeLine >= 0 ? lines[closeLine].start : text.length;
        const end = closeLine >= 0 ? lines[closeLine].end : text.length;
        blocks.push({
          name,
          payload: text.slice(payloadStart, payloadEnd).trim(),
          start: line.start,
          end,
        });
        index = closeLine >= 0 ? closeLine : lines.length;
        continue;
      }
    }

    const bareName = normalizeInternalBlockName(line.text.trim());
    if (!wanted.has(bareName)) {
      continue;
    }
    const payloadLine = nextNonEmptyLine(lines, index + 1);
    if (payloadLine < 0) {
      continue;
    }
    const jsonStart = firstNonWhitespaceIndex(text, lines[payloadLine].start);
    if (jsonStart < 0 || text[jsonStart] !== "{") {
      continue;
    }
    const jsonEnd = findJsonObjectEnd(text, jsonStart);
    if (!jsonEnd) {
      continue;
    }
    blocks.push({
      name: bareName,
      payload: text.slice(jsonStart, jsonEnd).trim(),
      start: line.start,
      end: consumeTrailingLineWhitespace(text, jsonEnd),
    });
    index = lineIndexForOffset(lines, jsonEnd);
  }
  return mergeInternalBlocks(blocks);
}

function removeInternalControlBlocks(text: string, names: string[]): string {
  const blocks = findInternalControlBlocks(text, names);
  if (blocks.length === 0) {
    return text;
  }
  let out = "";
  let cursor = 0;
  for (const block of blocks) {
    if (block.start < cursor) {
      continue;
    }
    out += text.slice(cursor, block.start);
    cursor = block.end;
  }
  out += text.slice(cursor);
  return out;
}

function splitLinesWithOffsets(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline >= 0 ? newline + 1 : text.length;
    const contentEnd = newline >= 0 ? newline : end;
    const raw = text.slice(start, contentEnd).replace(/\r$/, "");
    lines.push({ text: raw, start, end });
    start = end;
  }
  if (text.length === 0) {
    lines.push({ text: "", start: 0, end: 0 });
  }
  return lines;
}

function findClosingFenceLine(lines: TextLine[], startLine: number, openingFence: string): number {
  const char = openingFence[0];
  const minLength = openingFence.length;
  for (let index = startLine; index < lines.length; index += 1) {
    const trimmed = lines[index].text.trim();
    if (trimmed.length < minLength) {
      continue;
    }
    if ([...trimmed].every((item) => item === char)) {
      return index;
    }
  }
  return -1;
}

function nextNonEmptyLine(lines: TextLine[], startLine: number): number {
  for (let index = startLine; index < lines.length; index += 1) {
    if (lines[index].text.trim()) {
      return index;
    }
  }
  return -1;
}

function firstNonWhitespaceIndex(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (!/\s/.test(text[index])) {
      return index;
    }
  }
  return -1;
}

function findJsonObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

function consumeTrailingLineWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\r")) {
    index += 1;
  }
  if (text[index] === "\n") {
    index += 1;
  }
  return index;
}

function lineIndexForOffset(lines: TextLine[], offset: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (offset <= lines[index].end) {
      return index;
    }
  }
  return lines.length - 1;
}

function mergeInternalBlocks(blocks: InternalControlBlock[]): InternalControlBlock[] {
  const sorted = blocks.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: InternalControlBlock[] = [];
  for (const block of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && block.start < previous.end) {
      continue;
    }
    merged.push(block);
  }
  return merged;
}

function normalizeInternalBlockName(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function formatSkillCallBlock(call: SkillCall): string {
  return ["```skill-call", safeJson({ id: call.id, args: call.args }), "```"].join("\n");
}

function resolveDirectSkillCall(
  skills: SkillManifest[],
  userText: string,
  preferredSkillId?: string,
): SkillCall | null {
  const normalizedText = normalizeSkillTrigger(userText);
  if (!normalizedText) {
    return null;
  }
  const candidates = skills
    .filter((skill) => skill.output_mode === "raw" && !skill.side_effect && hasNoRequiredArgs(skill))
    .map((skill) => ({
      skill,
      phrases: directSkillPhrases(skill),
    }))
    .filter((entry) =>
      entry.phrases.some((phrase) => normalizeSkillTrigger(phrase) === normalizedText),
    );
  if (preferredSkillId) {
    const preferred = candidates.find((entry) => entry.skill.id === preferredSkillId);
    if (preferred) {
      return { id: preferred.skill.id, args: {} };
    }
  }
  if (candidates.length !== 1) {
    return null;
  }
  return { id: candidates[0].skill.id, args: {} };
}

function directSkillPhrases(skill: SkillManifest): string[] {
  return [
    skill.id,
    skill.name,
    skill.invocation?.command || "",
    ...(skill.invocation?.phrases || []),
  ].filter((phrase) => phrase.trim().length > 0);
}

function hasNoRequiredArgs(skill: SkillManifest): boolean {
  const required = skill.input?.schema?.required;
  return !Array.isArray(required) || required.length === 0;
}

function normalizeSkillTrigger(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/(?:を|の)?(?:一覧|リスト)?(?:出して|表示して|見せて|教えて|ください|お願い|して)$/u, "")
    .replace(/[\s_\-./:：・、。!！?？"'`]+/g, "")
    .trim();
}

function sanitizeSuggestedSkillId(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function toolResultJson(
  id: string,
  status: string,
  summary: string,
  saved: string[] = [],
  data?: unknown,
): string {
  const payload: Record<string, unknown> = { id, status, summary, saved };
  if (data !== undefined) {
    payload.data = data;
  }
  return ["```skill-result", JSON.stringify(payload), "```"].join("\n");
}

export function toAiMessages(
  history: ChatTurn[],
  multimodalTurn?: { index: number; images: AiImagePart[] },
): AiMessage[] {
  return history.map((turn, index) => {
    const role = turn.role === "tool" ? "tool" : turn.role;
    if (multimodalTurn && index === multimodalTurn.index && turn.role === "user") {
      return {
        role,
        content: [
          { type: "text", text: turn.content },
          ...multimodalTurn.images,
        ],
      };
    }
    return {
      role,
      content: turn.content,
    };
  });
}

export function appendHistory(history: ChatTurn[], turn: ChatTurn): void {
  history.push(turn);
  while (history.length > HISTORY_LIMIT) {
    history.shift();
  }
}
