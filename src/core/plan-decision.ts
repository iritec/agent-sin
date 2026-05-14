import type { AppConfig } from "./config.js";
import { getAiProvider, type AiMessage } from "./ai-provider.js";

export type PlanDecision = "approve" | "refine";

export interface PlanDecisionInput {
  userText: string;
  currentPlan: string | null;
}

export interface ClassifyPlanDecisionOptions {
  modelId?: string;
}

/**
 * Classifies whether a user reply during the plan phase is approving the plan
 * ("approve") or asking to refine/change it ("refine"). LLM-based classification
 * keeps the call robust across colloquial and multilingual inputs. Slash
 * commands (`/approve`, `/draft`) and empty input are handled upstream.
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
    return "refine";
  }
  return parseDecision(response.text);
}

function buildPlanDecisionSystemPrompt(): string {
  return [
    "You classify Agent-Sin plan approval.",
    "You will receive the plan just shown to the user and the user's reply to it.",
    "Decide whether the user is approving the plan or asking to refine/change/add something.",
    "",
    "Rules:",
    "- Short affirmations in any language (OK, yes, go, proceed, please do it, sounds good, leave it to you, 了解, 進めて, お願いします, いいよ, それで, 任せる, etc.) → approve",
    "- Direct objections or added requirements (want more, also include, remove this, change that, もっと…, 〜も入れて, 〜は要らない, 〜を変えて, etc.) → refine",
    "- Questions or confirmations → refine",
    "- Ignore punctuation, emojis, politeness, and tone differences. Judge by meaning.",
    "- If unsure, choose refine so the user's extra information is not lost.",
    "",
    "Return exactly one JSON object. No explanation and no ``` fences:",
    '{"decision":"approve|refine","reason":"short reason"}',
  ].join("\n");
}

function buildPlanDecisionUserPrompt(args: { userText: string; currentPlan: string | null }): string {
  const lines: string[] = [];
  if (args.currentPlan) {
    lines.push("<current_plan>");
    lines.push(args.currentPlan);
    lines.push("</current_plan>");
  } else {
    lines.push("<current_plan>(no plan generated)</current_plan>");
  }
  lines.push("<user_reply>");
  lines.push(args.userText);
  lines.push("</user_reply>");
  lines.push("Return JSON only.");
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
