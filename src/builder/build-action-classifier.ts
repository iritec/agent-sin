import type { AppConfig } from "../core/config.js";
import { getAiProvider, type AiMessage } from "../core/ai-provider.js";
import type { ChatTurn } from "../core/chat-engine.js";
import { l, lLines } from "../core/i18n.js";
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
      content: l(
        `Classify the following user reply.\n\n<reply>${userText}</reply>\n\nReturn JSON only.`,
        `次のユーザー発言を分類してください。\n\n<reply>${userText}</reply>\n\nJSONのみで返答してください。`,
      ),
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
  return lLines(
    [
      "You decide how the user is responding to a pending build-mode proposal.",
      "There is a pending proposal:",
      `- type: ${typeLabel}`,
      `- skill_id: ${pending.skill_id}`,
      `- reason: ${pending.reason}`,
      `- original_user_request: ${truncate(pending.original_text, 400)}`,
      "",
      "Decide one of three labels:",
      '- "approve": the user wants to go ahead with the proposal (any natural phrasing of "yes", "do it", "make it", "go", "please", "create it", "let\'s do it", etc., including approvals that bundle additional requirements or constraints).',
      '- "reject": the user wants to cancel or abandon the proposal (e.g. "no", "cancel", "stop", "let\'s talk first", "actually skip it").',
      '- "discuss": the user is asking a clarifying question, providing more requirements without explicit approval, or continuing the conversation without committing.',
      "",
      "If approve and the reply contains extra requirements or constraints beyond the bare approval, copy that extra part into carry_over_text verbatim (in the user's language). Omit pure approval words (yes/つくって/etc.). If there is nothing extra, omit carry_over_text.",
      "",
      "Return exactly one JSON object. No markdown fences:",
      '{"decision":"approve|reject|discuss","carry_over_text":"...","reason":"short why"}',
    ],
    [
      "あなたは、保留中のビルドモード提案に対するユーザーの反応を分類する役割です。",
      "現在の提案:",
      `- 種類: ${pending.type === "edit" ? "既存スキルの編集" : "新規スキルの作成"}`,
      `- skill_id: ${pending.skill_id}`,
      `- 理由: ${pending.reason}`,
      `- もとの依頼文: ${truncate(pending.original_text, 400)}`,
      "",
      "次の3つから1つを選んでください:",
      "- \"approve\": 提案を進めてよいという意思表示。『はい』『つくって』『作って』『やって』『お願い』『進めて』『go』など、自然言語のあらゆる承認形を含む。追加の要件や条件が一緒に書かれていても承認とみなす。",
      "- \"reject\": 提案を取りやめたい・キャンセルしたい意図。『やめて』『キャンセル』『やっぱり違う』など。",
      "- \"discuss\": 明示的な承認/拒否ではなく、追加質問・要件追加・前提確認など会話継続。判断が曖昧なときも discuss にする。",
      "",
      "approve のとき、承認語の他に追加要件や条件が含まれていれば、その部分だけを carry_over_text にそのまま（ユーザーの言葉のまま）入れる。『はい』『つくって』などの単純な承認語は carry_over_text に含めない。追加要件がなければ carry_over_text は省く。",
      "",
      "出力は次の JSON 1個のみ。``` は不要:",
      '{"decision":"approve|reject|discuss","carry_over_text":"...","reason":"短い理由"}',
    ],
  ).join("\n");
}

function buildModeActionPrompt(build: BuildModeState): string {
  const typeLabel = build.type === "edit" ? "editing an existing skill" : "creating a new skill";
  return lLines(
    [
      "You decide how the user wants to proceed inside build mode.",
      "Current build session:",
      `- mode: ${typeLabel}`,
      `- skill_id: ${build.skill_id}`,
      `- original_request: ${truncate(build.original_text, 400)}`,
      "",
      "Choose one of four actions:",
      '- "exit": the user wants to leave build mode and return to plain chat (e.g. "stop", "go back", "やめる", "戻る", "もういい", "中止", "/back" or any natural cancel/exit).',
      '- "register": the user wants to register/install the current draft as a usable skill (e.g. "register it", "install", "登録して", "本登録", "これでOK", "これで保存", "公開して").',
      '- "test": the user wants to test/run the current draft (e.g. "test it", "run it", "動かして", "試して", "テスト").',
      '- "continue": anything else — additional requirements, edits, design discussion, environment variables, default request to keep building.',
      "",
      "If the user is asking to fix or change implementation details, prefer 'continue' over 'register' or 'test'.",
      "If unsure, choose 'continue'.",
      "",
      "Return exactly one JSON object. No markdown fences:",
      '{"action":"exit|register|test|continue","reason":"short why"}',
    ],
    [
      "あなたはビルドモード中のユーザー発言を分類する役割です。",
      "現在のビルドセッション:",
      `- 内容: ${build.type === "edit" ? "既存スキルの編集" : "新規スキル作成"}`,
      `- skill_id: ${build.skill_id}`,
      `- もとの依頼: ${truncate(build.original_text, 400)}`,
      "",
      "次の4つから1つを選んでください:",
      "- \"exit\": ビルドモードから抜けて通常チャットに戻りたい意図。『やめる』『戻る』『中止』『キャンセル』『もういい』『/back』など、自然言語の離脱表現を全て含む。",
      "- \"register\": 現在のドラフトをスキルとして登録/本登録したい意図。『登録して』『これでOK』『本登録』『公開して』『インストール』など。",
      "- \"test\": 現在のドラフトをテスト実行したい意図。『テストして』『動かして』『試して』『run』など。",
      "- \"continue\": 上記以外の全て。追加要件、修正指示、設計の相談、環境変数の提示、引き続き作業を続ける指示など。",
      "",
      "実装の修正・追加要件は『register』『test』ではなく『continue』を選ぶ。迷ったときも『continue』にする。",
      "",
      "出力は次の JSON 1個のみ。``` は不要:",
      '{"action":"exit|register|test|continue","reason":"短い理由"}',
    ],
  ).join("\n");
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}
