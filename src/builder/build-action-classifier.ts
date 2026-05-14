import type { AppConfig } from "../core/config.js";
import { getAiProvider, type AiMessage } from "../core/ai-provider.js";
import type { ChatTurn } from "../core/chat-engine.js";
import type { BuildModeState, PendingHandoff } from "./build-flow.js";

export interface HandoffApprovalDecision {
  decision: "approve" | "reject" | "discuss";
  carry_over_text?: string;
  reason?: string;
}

export interface BuildModeActionDecision {
  action: "exit" | "register" | "test" | "continue";
  reason?: string;
}

interface ClassifyOptions {
  modelId?: string;
}

const RECENT_HISTORY_TURNS = 8;

export async function classifyHandoffApproval(
  config: AppConfig,
  userText: string,
  history: ChatTurn[],
  pending: PendingHandoff,
  options: ClassifyOptions = {},
): Promise<HandoffApprovalDecision> {
  const trimmed = userText.trim();
  if (!trimmed) {
    return { decision: "discuss", reason: "empty input" };
  }
  const system = handoffApprovalPrompt(pending);
  const messages = buildMessages(system, history, trimmed);
  const parsed = await callJsonClassifier(config, messages, options.modelId);
  if (!parsed) {
    return { decision: "discuss", reason: "classifier fallback" };
  }
  const raw = String(parsed.decision || "").trim().toLowerCase();
  const decision: HandoffApprovalDecision["decision"] =
    raw === "approve" ? "approve" : raw === "reject" ? "reject" : "discuss";
  const carryOver = typeof parsed.carry_over_text === "string" ? parsed.carry_over_text.trim() : "";
  return {
    decision,
    carry_over_text: carryOver || undefined,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : undefined,
  };
}

export async function classifyBuildModeAction(
  config: AppConfig,
  userText: string,
  history: ChatTurn[],
  build: BuildModeState,
  options: ClassifyOptions = {},
): Promise<BuildModeActionDecision> {
  const trimmed = userText.trim();
  if (!trimmed) {
    return { action: "continue", reason: "empty input" };
  }
  const system = buildModeActionPrompt(build);
  const messages = buildMessages(system, history, trimmed);
  const parsed = await callJsonClassifier(config, messages, options.modelId);
  if (!parsed) {
    return { action: "continue", reason: "classifier fallback" };
  }
  const raw = String(parsed.action || "").trim().toLowerCase();
  const action: BuildModeActionDecision["action"] =
    raw === "exit" ? "exit"
    : raw === "register" ? "register"
    : raw === "test" ? "test"
    : "continue";
  return {
    action,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : undefined,
  };
}

function buildMessages(system: string, history: ChatTurn[], userText: string): AiMessage[] {
  const recent = history.slice(-RECENT_HISTORY_TURNS).map((turn) => ({
    role: (turn.role === "tool" ? "tool" : turn.role) as AiMessage["role"],
    content: turn.content,
  }));
  return [
    { role: "system", content: system },
    ...recent,
    {
      role: "user",
      content: `Classify the following user reply.\n\n<reply>${userText}</reply>\n\nReturn JSON only.`,
    },
  ];
}

async function callJsonClassifier(
  config: AppConfig,
  messages: AiMessage[],
  modelId?: string,
): Promise<Record<string, unknown> | null> {
  let response;
  try {
    response = await getAiProvider()(config, {
      model_id: modelId || config.chat_model_id,
      messages,
      temperature: 0,
    });
  } catch {
    return null;
  }
  return parseClassifierJson(response.text);
}

function parseClassifierJson(text: string): Record<string, unknown> | null {
  const stripped = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function handoffApprovalPrompt(pending: PendingHandoff): string {
  const typeLabel = pending.type === "edit" ? "edit existing skill" : "create new skill";
  return [
    "You decide how the user is responding to a pending build-mode proposal.",
    "There is a pending proposal:",
    `- type: ${typeLabel}`,
    `- skill_id: ${pending.skill_id}`,
    `- reason: ${pending.reason}`,
    `- original_user_request: ${truncate(pending.original_text, 400)}`,
    "",
    "Decide one of three labels:",
    '- "approve": the user wants to go ahead with the proposal (any natural phrasing in any language: "yes", "do it", "make it", "go", "please", "create it", "let\'s do it", はい, つくって, 作って, やって, お願い, 進めて, etc., including approvals that bundle additional requirements or constraints).',
    '- "reject": the user wants to cancel or abandon the proposal ("no", "cancel", "stop", やめて, キャンセル, やっぱり違う, etc.).',
    '- "discuss": the user is asking a clarifying question, providing more requirements without explicit approval, or continuing the conversation without committing. When in doubt, choose discuss.',
    "",
    "If approve and the reply contains extra requirements or constraints beyond the bare approval, copy that extra part into carry_over_text verbatim (in the user's language). Omit pure approval words (yes / つくって / etc.). If there is nothing extra, omit carry_over_text.",
    "",
    "Return exactly one JSON object. No markdown fences:",
    '{"decision":"approve|reject|discuss","carry_over_text":"...","reason":"short why"}',
  ].join("\n");
}

function buildModeActionPrompt(build: BuildModeState): string {
  const typeLabel = build.type === "edit" ? "editing an existing skill" : "creating a new skill";
  return [
    "You decide how the user wants to proceed inside build mode.",
    "Current build session:",
    `- mode: ${typeLabel}`,
    `- skill_id: ${build.skill_id}`,
    `- original_request: ${truncate(build.original_text, 400)}`,
    "",
    "Choose one of four actions:",
    '- "exit": the user wants to leave build mode and return to plain chat ("stop", "go back", "/back", やめる, 戻る, もういい, 中止, キャンセル, or any natural cancel/exit phrase in any language).',
    '- "register": the user wants to register/install the current draft as a usable skill ("register it", "install", 登録して, 本登録, これでOK, これで保存, 公開して).',
    '- "test": the user wants to test/run the current draft ("test it", "run it", 動かして, 試して, テスト).',
    '- "continue": anything else — additional requirements, edits, design discussion, environment variables, default request to keep building.',
    "",
    "If the user is asking to fix or change implementation details, prefer 'continue' over 'register' or 'test'.",
    "If unsure, choose 'continue'.",
    "",
    "Return exactly one JSON object. No markdown fences:",
    '{"action":"exit|register|test|continue","reason":"short why"}',
  ].join("\n");
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}
