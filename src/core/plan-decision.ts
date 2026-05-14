import type { AppConfig } from "./config.js";
import { getAiProvider, type AiMessage } from "./ai-provider.js";
import { l, lLines } from "./i18n.js";

export type PlanDecision = "approve" | "refine";

export interface PlanDecisionInput {
  userText: string;
  currentPlan: string | null;
}

export interface ClassifyPlanDecisionOptions {
  modelId?: string;
}

/**
 * 計画フェーズ中のユーザー発話が「これで進めていい (approve)」か
 * 「直したい (refine)」かを LLM で判定する。
 *
 * キーワード一覧でのヒューリスティック判定は脆くて多言語/口語に弱いので、
 * モデルに『直前のプランとユーザー発話の組み合わせ』として読ませて分類する。
 *
 * 例外的に slash command (`/approve`, `/draft`) と空入力だけはこの関数に来る前に処理する。
 */
export async function classifyPlanDecision(
  config: AppConfig,
  input: PlanDecisionInput,
  options: ClassifyPlanDecisionOptions = {},
): Promise<PlanDecision> {
  const userText = input.userText.trim();
  if (!userText) {
    return "refine";
  }
  const system = buildPlanDecisionSystemPrompt();
  const messages: AiMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: buildPlanDecisionUserPrompt({
        userText,
        currentPlan: input.currentPlan,
      }),
    },
  ];
  let response;
  try {
    response = await getAiProvider()(config, {
      model_id: options.modelId || config.chat_model_id,
      messages,
      temperature: 0,
    });
  } catch {
    // 分類器が落ちたら refine 側に倒す (ユーザの発話を捨てない)
    return "refine";
  }
  return parseDecision(response.text);
}

function buildPlanDecisionSystemPrompt(): string {
  return lLines(
    [
      "You classify Agent-Sin plan approval.",
      "You will receive the plan just shown to the user and the user's reply to it.",
      "Decide whether the user is approving the plan or asking to refine/change/add something.",
      "",
      "Rules:",
      "- Short affirmations (OK, yes, go, proceed, please do it, sounds good, leave it to you, etc.) → approve",
      "- Direct objections or added requirements (want more, also include, remove this, change that, etc.) → refine",
      "- Questions or confirmations → refine",
      "- Ignore punctuation, emojis, politeness, and tone differences. Judge by meaning.",
      "- If unsure, choose refine so the user's extra information is not lost.",
      "",
      "Return exactly one JSON object. No explanation and no ``` fences:",
      '{"decision":"approve|refine","reason":"short reason"}',
    ],
    [
      "あなたは Agent-Sin のプラン承認判定です。",
      "直前にユーザーへ提示したプランと、それに対するユーザー発話が与えられます。",
      "ユーザーの発話が『このプランで進めていい』という承認なのか、『直したい/追加したい』というリファインなのかを判定してください。",
      "",
      "判定ルール:",
      "- 短い肯定 (OK / 了解 / 進めて / お願いします / いいよ / yes / go / それで / 任せる など) → approve",
      "- プランへの直接的な異論や追加要件 (『もっと〜したい』『〜も入れて』『〜は要らない』『〜を変えて』) → refine",
      "- 質問・確認 (『〜はどうなる？』『〜も入る？』) → refine",
      "- 文末の絵文字や記号、敬語、口調の違いで判断を変えない。意味で判断する。",
      "- 迷ったら refine に倒す (ユーザーの追加情報を捨てない)。",
      "",
      "出力は次の JSON 1個のみ。説明文や ``` は不要:",
      '{"decision":"approve|refine","reason":"短い理由"}',
    ],
  ).join("\n");
}

function buildPlanDecisionUserPrompt(args: { userText: string; currentPlan: string | null }): string {
  const lines: string[] = [];
  if (args.currentPlan) {
    lines.push("<current_plan>");
    lines.push(args.currentPlan);
    lines.push("</current_plan>");
  } else {
    lines.push(l("<current_plan>(no plan generated)</current_plan>", "<current_plan>(プラン未生成)</current_plan>"));
  }
  lines.push("<user_reply>");
  lines.push(args.userText);
  lines.push("</user_reply>");
  lines.push(l("Return JSON only.", "JSON のみで返答してください。"));
  return lines.join("\n");
}

function parseDecision(text: string): PlanDecision {
  const stripped = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return "refine";
  }
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    const raw = String(parsed.decision || "").trim().toLowerCase();
    return raw === "approve" ? "approve" : "refine";
  } catch {
    return "refine";
  }
}
