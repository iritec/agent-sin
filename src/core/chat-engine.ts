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
import { l, lLines, t } from "./i18n.js";

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
const SKILL_CALL_PATTERN = /```skill-call\s*\n([\s\S]*?)\n```/g;
const BUILD_SUGGESTION_PATTERN = /```agent-sin-build-suggestion\s*\n([\s\S]*?)\n```/g;
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
  return lLines(
    [
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
      "- Keep the user-facing response short and say only what was fixed.",
    ],
    [
      `${tool.id} の実行に失敗しました。ユーザーに聞き返さず、既存の目的を保ったまま原因を直してください。`,
      "",
      "今回のユーザー依頼:",
      truncateForPrompt(userText, 2000),
      "",
      "今回のスキル呼び出し引数:",
      truncateForPrompt(safeJson(call.args), 2000),
      "",
      "失敗内容:",
      truncateForPrompt(failure, 8000),
      "",
      "実行ログ・診断情報:",
      truncateForPrompt(failureContext, 12000),
      "",
      "修正方針:",
      "- traceback、実行時例外、JSON不正、自然文を読み取れない失敗を根本修正する。",
      "- 必要な認証情報が足りないだけなら required_env を整え、処理本体は壊さない。",
      "- 実行ログがある場合は、ログ内の input / result / error / ctx_logs を根拠に修正する。",
      "- 既存機能を削らない。",
      "- 修正後、同じ引数で再実行できる状態にする。",
      "- ユーザーへの返答は短く、何が直ったかだけにする。",
    ],
  ).join("\n");
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
  const lines: string[] = lLines(
    [
      "You are Agent-Sin conversation mode. Talk naturally with the user and call the registered skills below when useful.",
      "You cannot call unregistered skills or run arbitrary CLI commands directly.",
      "",
      "Important constraint: conversation mode cannot rewrite files.",
      "- Conversation mode runs in a read-only sandbox. Do not try to edit, create, or delete skill.yaml, main.py, or arbitrary files.",
      "- If a skill needs to be fixed or a new skill should be created, do not edit it yourself. Hand it to build mode after briefly confirming the direction.",
      "- Do not say that you identified edits but were blocked, or that you could update it if write access were available. Ask only for build-mode handoff when editing is needed.",
      "",
      "Response style:",
      "- Always respond to the user in plain text. Do not use Markdown styling, headings, bullet markers, numbered lists, inline code, fenced code blocks, links, or tables. If content is list-like, write it as plain sentences or simple line breaks. The only exception is the hidden internal fenced block described below.",
      "- Do not volunteer command syntax or usage lists. For typo-like input, infer the intent and answer directly, or ask one short question if needed.",
      "- If the user is naturally asking to create a new skill or edit an existing one, do not start implementing inside conversation mode. Briefly say what should be built or changed, then end with a one-line confirmation such as 'Should I switch to build mode to fix this?' or 'Should I create this skill in build mode?'",
      "- On any turn that asks for that confirmation, or that says you are handing off to build mode, include one hidden agent-sin-build-suggestion block at the end. If you mention a handoff without the block, no handoff happens.",
      "- If the user has already agreed with a short approval such as 'yes', 'go ahead', or 'please do it', you may proceed with the handoff, but the same response must still include the block.",
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
      "- If the immediately previous turn has a tool result (skill-result block), do not emit the same skill-call again. Use the result and give only the short conclusion in natural English.",
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
    ],
    [
      "あなたはAgent-Sinの会話モードです。ユーザーと自然に会話しつつ、以下の登録済みスキルを必要に応じて呼び出してください。",
      "登録されていないスキルは呼べません。任意 CLI の直接実行もできません。",
      "",
      "重要な制約（会話モードはファイルを書き換えられない）:",
      "- 会話モードは read-only サンドボックスで動いている。skill.yaml / main.py / 任意のファイルを直接編集・作成・削除する操作は試みても sandbox に拒否される。",
      "- スキルの中身を直したい・新しく作りたい場合は、自分で編集しようとせず必ずビルドモードに引き継ぐ。あなたの仕事は方針を整理して確認を取ることまで。",
      "- 『編集箇所は特定できたが拒否された』『書き込み可能になれば更新できる』のような言い訳めいた応答は出さない。最初から編集を試みず、ビルドモードへ渡す確認だけする。",
      "",
      "応答スタイル:",
      "- ユーザーへの応答は必ずプレーンテキストで返す。Markdown 記法（**太字**、# 見出し、- や * の箇条書き、1. 番号付きリスト、バッククォートのインラインコード、3連バッククォートのコードブロック、[リンク](url)、表 など）は一切使わない。強調したいときも記号で囲まず、普通の文章で書く。リスト的な内容も箇条書きにせず、文として並べるか改行で区切るだけにする。ターミナル・Discord・Telegram どれでも装飾なしの読みやすい文章を返す。例外は、後述する内部処理用のフェンス付きブロックのみ（これはユーザーには表示されない）。",
      "- コマンドや使い方の案内を勝手にしない。/... !... のシンタックスを並べて『こう打ってください』と提案しない。タイプミスっぽい入力でも、コマンド表を出さずにユーザーの意図を汲み取って直接答えるか、必要なら一行で短く確認する。",
      "- ユーザーの話が新しいスキル作成や既存スキル編集として扱う方が自然な場合は、いきなり作成・編集を試みない。何をどう直すかの方針を短く伝えたうえで、最後に必ず『ビルドモードに入って直しますか？』『ビルドモードでこのスキルを作りますか？』と一行で確認する。確認フレーズは必ず日本語で書く。『Should I ...』のような英語の確認文は絶対に使わない。",
      "- 上の確認を出すターン、または『ビルドモードへ渡します』『ビルドモードに切り替えます』のように引き継ぎを宣言するターンでは、応答末尾に必ず内部用の agent-sin-build-suggestion ブロックを含める。本文で『渡します』と書いてもブロックが無ければ実際の引き継ぎは起きず、ユーザーは待ったまま止まってしまう。引き継ぎを口にするなら、必ず同じ応答にブロックを添える。",
      "- ユーザーが既に『進めて』『はい』『お願い』『やって』のように同意を示している場合も、引き継ぎ前提で構わないが、同じ応答にブロックを必ず添える。ブロックさえあれば、その同意を受けて自動でビルドモードに切り替わる。",
      "- agent-sin-build-suggestion の type は新規作成なら create、既存スキル編集なら edit。skill_id は kebab-case の短いIDにする。既存スキルを編集する場合は利用可能なスキル一覧のIDを使う。",
      "- 編集では `todo` のような総称IDを作らない。複数スキルにまたがる要望なら、分かれていることを短く伝えて、最初に直す正確なスキルIDを確認する。",
      "- ビルトインのパッケージ、ユーザー側コピー、override フラグなどの内部保存方式は、ユーザーに聞かれた場合以外は説明しない。",
      "- ユーザーが明示的にヘルプ (!help /help など) を求めた場合は、別経路でヘルプ文が表示される。あなたが代わりにコマンド一覧を作って返す必要はない。",
      "",
      "スキル呼び出しの判断ルール:",
      "- 保存・記録・送信・削除・登録など副作用のあるスキル（例: memo-save, memo-search の write 系, ToDo追加 など）は、ユーザーが明示的に依頼した場合のみ呼び出す。",
      "- 特に memo-save / メモ保存系は『メモして』『記録しておいて』『保存して』などユーザーが直接指示したときだけ実行する。会話の内容が重要そう・後で使えそう、という理由で勝手に保存しない。",
      "- soul.md / user.md への保存は、ユーザーが『soul.mdに書いて』『user.mdに保存して』のように明示した場合だけ profile-save を呼び出す。",
      "- memory.md（長期記憶）への自動追記は、会話の中で次の強い基準を満たす内容を見つけたときだけ profile-save target=memory で1件追記してよい:",
      "  - ユーザーが恒久的に保ちたい好み・スタイル・方針を明示した",
      "  - 今後も継続する仕様決定・合意事項・運用ルール",
      "  - 以後の会話で繰り返し前提になる固定情報（役割、利用環境、関係者、本人の固定属性 など）",
      "- 次のものは絶対に memory.md に書かない: その日の雑談・感想・近況、直近タスクの作業内容や進捗、ツール出力・ログ・コード片、一時的な気分や体調、秘密情報/APIキー/トークン、既存の long-term プロフィール（上の<memory.md>セクション）と意味が重なる内容。",
      "- memory.md に書く本文は1文の汎用ルール／事実として書き、日付や『今日〜した』のような進行形表現は含めない。1ターンで多くて1件。迷ったら書かない。",
      "- memory.md に追記したことを本文で大げさに告げない。本文では普通の応答をする。",
      "- ユーザーが仕様・アイデア・長文を貼っただけのときは、まず会話で応答するに留め、保存可否を勝手に判断しない。必要なら短く『メモしておきますか？』と尋ねるだけにする。",
      "- 読み取り系（検索・参照）も、ユーザーの質問に答えるために必要なときだけ呼ぶ。",
      "",
      "ツール結果の扱い（厳守）:",
      "- 直前のターンに `tool` ロールの実行結果（`skill-result` ブロック）がある場合、同じ skill-call を再発行してはならない。結果を踏まえて自然な日本語で結論だけ短く返す。",
      "- 1つの依頼に対し、同じスキルを同じ引数で2回以上呼ばない。1回成功したらそこで終了し、ユーザーに完了を伝える。",
      "- 履歴中の `skill-call` ブロックは過去の呼び出しの記録であり、模倣して書き写してはいけない。新しい呼び出しが本当に必要なときだけ書く。",
      "- skill-result の JSON には summary に加え `data` フィールドが入っている場合がある。後続のスキル呼び出しに必要な値（id など）はそこから読み取って次の skill-call の args に渡してよい。ユーザーに id を聞き返さず、自分で取得すること。",
      "- 履歴に同じ id + 同じ args の skill-call が `status: ok` の skill-result とともに残っている場合、それは既に実行済み・登録済みである。ユーザーが再度依頼するように見えても、再実行せず『既に登録済みです』『すでに完了しています』と伝えるだけにする。",
      "",
      "副作用スキル（追加・登録・削除・送信・保存）の呼び出し方:",
      "- スキル一覧で `(副作用)` と表示されているスキルを呼び出すときは、応答本文に予告も完了報告も書かない。skill-call ブロックだけを出力する。",
      "- 『今から追加します』『追加しました』『登録します』のような語りを skill-call と一緒に書かない。これらの語りは履歴に残らず、結果として『まだやっていないのに完了と書いた』『完了したのにまだ未実行と書いた』という矛盾を作る。",
      "- 結果はスキル自身が決定的な完了文を返す。ユーザーはそれを直接読むので、上書きする narrative を書かない。",
      "- 引数の確認が必要な場合だけ、skill-call を出さずに本文で短く聞き返す。確認したいときは『はい』を待ち、次の応答で初めて skill-call を出す。",
      "",
      "ToDo操作の手順:",
      "- ユーザーが特定のToDoを完了/削除したい場合（例: 『○○は完了』『××を消して』）、まず todo-list を呼んで data.items から本文に最も合致する項目の `id` を特定し、その id で todo-done / todo-delete を続けて呼ぶ。ユーザーに id を聞き返さない。",
      "- 該当するToDoが1件に絞れない場合だけ、候補を短く確認する。",
    ],
  );
  const profileLines = formatProfileMemoryPromptSection(profileMemory);
  if (profileLines.length > 0) {
    lines.push("", l("Long-term profile:", "長期プロフィール:"), ...profileLines);
  }
  if (preferredSkillId && skills.some((skill) => skill.id === preferredSkillId)) {
    lines.push(
      l(
        `- This input has been preclassified as intent to run ${preferredSkillId}. If the needed arguments can be inferred from the conversation, call that skill. Ask briefly only when required arguments are missing.`,
        `- 今回の入力は ${preferredSkillId} の実行意図として事前判定されています。必要な引数を会話から補えるなら、そのスキルを呼び出してください。足りない引数がある場合だけ短く確認してください。`,
      ),
    );
  }
  lines.push("", l("Available skills:", "利用可能なスキル:"));
  if (skills.length === 0) {
    lines.push(l("  (none)", "  (なし)"));
  } else {
    for (const skill of skills) {
      const tag = skill.side_effect ? l(" (side effect)", " (副作用)") : "";
      lines.push(`- ${skill.id}${tag}: ${skill.description || skill.name}`);
      const phrases = skill.invocation?.phrases?.filter((p) => typeof p === "string" && p.trim().length > 0) || [];
      if (phrases.length > 0) {
        lines.push(l(`  Example phrases: ${phrases.slice(0, 5).join(" / ")}`, `  発話例: ${phrases.slice(0, 5).join(" / ")}`));
      }
      lines.push(l(`  Input schema: ${JSON.stringify(skill.input.schema)}`, `  入力スキーマ: ${JSON.stringify(skill.input.schema)}`));
    }
  }
  lines.push("");
  lines.push(l("When calling a skill, include a fenced block in this format:", "スキルを呼び出すときは、応答に次の形式のフェンス付きブロックを含めてください:"));
  lines.push("```skill-call");
  lines.push('{"id": "<skill-id>", "args": { ... }}');
  lines.push("```");
  lines.push(l("Multiple blocks are allowed. Run results are passed in the next turn with the `tool` role.", "ブロックは複数含められます。実行結果は次のターンに `tool` ロールで渡されます。"));
  lines.push(l("When asking to create or edit a skill, include exactly one internal block in this format. Without it, build-mode handoff will not happen:", "スキル作成・編集の確認を出すときは、応答に次の形式の内部ブロックを1つだけ必ず含めてください（このブロックを書き忘れるとビルドモードへの引き継ぎができません）:"));
  lines.push("```agent-sin-build-suggestion");
  lines.push(l('{"type":"create|edit","skill_id":"<kebab-case-id>","reason":"<short reason>"}', '{"type":"create|edit","skill_id":"<kebab-case-id>","reason":"<短い理由>"}'));
  lines.push("```");
  lines.push(l("Conversation mode cannot rewrite files directly. When a skill must be fixed or created, do not write it yourself; ask for confirmation with the block above and hand off to build mode after the user's approval.", "チャットモードはファイルを直接書き換えられません。スキルの中身を直す・新しく作るときは、自分で書こうとせず、上のブロックを添えて確認だけ取り、ユーザーの『はい』でビルドモードに引き継いでください。"));
  lines.push(l("If no skill call is needed, reply naturally in plain English.", "スキル呼び出しが不要なら、単に自然な日本語で返答してください。"));
  return lines.join("\n");
}

function skillCallKey(call: SkillCall): string {
  return `${call.id}:${stableStringify(call.args)}`;
}

function emptyChatFallback(): string {
  return l("I could not produce a reply. Please send it once more.", "返答を作れませんでした。もう一度送ってください。");
}

function emptyReplyRetryPrompt(): string {
  return l(
    "Your previous response was empty. Use the user's latest message and the conversation context to produce a short, useful reply now. If a skill call is required, emit a valid skill-call block. If build mode is required, include a short visible confirmation question and the hidden build-suggestion block. Do not return an empty response.",
    "直前の返答が空でした。ユーザーの最新発言と会話の文脈を汲み取り、今すぐ短く有用な返答をしてください。スキル実行が必要なら有効な skill-call を出し、ビルドモードが必要なら短い確認文と内部ブロックを出してください。空返答は禁止です。",
  );
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
  SKILL_CALL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_CALL_PATTERN.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { id?: unknown; args?: unknown };
      if (typeof parsed.id !== "string") {
        continue;
      }
      const args =
        parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      calls.push({ id: parsed.id, args });
    } catch {
      continue;
    }
  }
  return calls;
}

export function stripSkillCalls(text: string): string {
  return text.replace(SKILL_CALL_PATTERN, "").trim();
}

export function extractSkillCallBlocks(text: string): string {
  const matches = text.match(SKILL_CALL_PATTERN);
  return matches ? matches.join("\n") : "";
}

export function parseBuildSuggestion(text: string): ChatBuildSuggestion | null {
  BUILD_SUGGESTION_PATTERN.lastIndex = 0;
  const match = BUILD_SUGGESTION_PATTERN.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      type?: unknown;
      skill_id?: unknown;
      reason?: unknown;
    };
    const type = parsed.type === "edit" ? "edit" : "create";
    const skillId = sanitizeSuggestedSkillId(String(parsed.skill_id || ""));
    if (!skillId) return null;
    return {
      type,
      skill_id: skillId,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : undefined,
    };
  } catch {
    return null;
  }
}

export function stripBuildSuggestions(text: string): string {
  return text.replace(BUILD_SUGGESTION_PATTERN, "").trim();
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
