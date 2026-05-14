import {
  chatRespond,
  type ChatBuildSuggestion,
  type ChatProgressEvent,
  type ChatTurn,
} from "../core/chat-engine.js";
import type { AppConfig } from "../core/config.js";
import type { AiImagePart, AiProgressHandler } from "../core/ai-provider.js";
import {
  classifyPendingHandoff,
  enterBuildMode,
  handleBuildModeMessage,
  type IntentRuntime,
} from "./build-flow.js";
import { l } from "../core/i18n.js";

export interface BuildProgressReporter {
  onProgress: AiProgressHandler;
  flush(): Promise<void>;
}

export interface RouteConversationMessageOptions {
  config: AppConfig;
  text: string;
  history: ChatTurn[];
  intentRuntime: IntentRuntime;
  eventSource: "discord" | "telegram";
  images?: AiImagePart[];
  createBuildProgress(): BuildProgressReporter;
  onBuildStart?(): Promise<void>;
  onBuildDone?(): Promise<void>;
  onChatProgress?(event: ChatProgressEvent): void;
  onAiProgress?: AiProgressHandler;
}

export async function routeConversationMessage(
  options: RouteConversationMessageOptions,
): Promise<string[]> {
  const {
    config,
    text,
    history,
    intentRuntime,
    eventSource,
    images = [],
  } = options;

  if (intentRuntime.mode === "build") {
    await options.onBuildStart?.();
    const buildProgress = options.createBuildProgress();
    const lines = await handleBuildModeMessage(config, text, intentRuntime, {
      suggestExitOnOffTopic: true,
      onProgress: buildProgress.onProgress,
      history,
    }, eventSource);
    await buildProgress.flush();
    await options.onBuildDone?.();
    if (lines !== null) {
      return lines;
    }
    // lines === null means handleBuildModeMessage auto-exited build mode;
    // fall through so the normal chat engine (with skills) handles this turn.
  }

  if (intentRuntime.pending && !text.startsWith("/")) {
    const approval = await classifyPendingHandoff(config, text, history, intentRuntime);
    if (approval.decision === "approve") {
      await options.onBuildStart?.();
      const buildProgress = options.createBuildProgress();
      const lines = await enterBuildMode(
        config,
        history,
        intentRuntime,
        { onProgress: buildProgress.onProgress },
        approval.carry_over_text,
        eventSource,
      );
      await buildProgress.flush();
      await options.onBuildDone?.();
      return lines;
    }
    if (approval.decision === "reject") {
      intentRuntime.pending = null;
      await options.onBuildDone?.();
      return [l("OK. Continuing in chat.", "わかりました。チャットを続けます。")];
    }
    // "discuss" → keep pending, fall through to chatRespond.
  }

  let modelFailed = false;
  const lines = await chatRespond(config, text, history, {
    eventSource,
    preferredSkillId: intentRuntime.preferred_skill_id || undefined,
    userImages: images,
    onChatProgress: (event) => {
      if (event.kind === "model_failed") {
        modelFailed = true;
      }
      options.onChatProgress?.(event);
    },
    onAiProgress: options.onAiProgress,
    onBuildSuggestion: (suggestion) => setPendingBuildSuggestion(intentRuntime, suggestion, text),
  });
  intentRuntime.preferred_skill_id = null;
  if (modelFailed && lines.length === 0) {
    return [l("The model call failed.", "モデル呼び出しでエラーになりました。")];
  }
  return lines;
}

function setPendingBuildSuggestion(
  intentRuntime: IntentRuntime,
  suggestion: ChatBuildSuggestion,
  userText: string,
): void {
  if (!intentRuntime.enabled || intentRuntime.mode !== "chat") return;
  intentRuntime.pending = {
    type: suggestion.type,
    skill_id: suggestion.skill_id,
    original_text: userText,
    reason: suggestion.reason || "chat build suggestion",
  };
  intentRuntime.pending_exit = null;
}
