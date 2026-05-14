import type { AppConfig } from "./config.js";
import { getAiProvider, type AiMessage } from "./ai-provider.js";
import type { SkillManifest } from "./skill-registry.js";

export type Intent = "chat" | "skill_create" | "skill_edit" | "skill_run" | "unclear";

export interface IntentResult {
  intent: Intent;
  matched_skill_id?: string;
  matched_draft_id?: string;
  suggested_skill_id?: string;
  confidence: "low" | "med" | "high";
  reason: string;
}

export interface IntentRouterTurn {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface ClassifyOptions {
  history?: IntentRouterTurn[];
  modelId?: string;
  drafts?: IntentDraftCandidate[];
}

export interface IntentDraftCandidate {
  skill_id: string;
  status?: string;
  summary?: string;
}

const FALLBACK: IntentResult = {
  intent: "chat",
  confidence: "low",
  reason: "router fallback",
};

export async function classifyIntent(
  config: AppConfig,
  userText: string,
  skills: SkillManifest[],
  options: ClassifyOptions = {},
): Promise<IntentResult> {
  const trimmed = userText.trim();
  if (!trimmed) {
    return FALLBACK;
  }
  const system = buildRouterSystemPrompt(skills, options.drafts || []);
  const messages: AiMessage[] = [{ role: "system", content: system }];
  for (const turn of options.history || []) {
    messages.push({
      role: turn.role === "tool" ? "tool" : turn.role,
      content: turn.content,
    });
  }
  messages.push({
    role: "user",
    content: `Classify the following user input.\n\n<input>${trimmed}</input>\n\nReturn JSON only.`,
  });

  let response;
  try {
    response = await getAiProvider()(config, {
      model_id: options.modelId || config.chat_model_id,
      messages,
      temperature: 0,
    });
  } catch {
    return FALLBACK;
  }

  const parsed = parseRouterJson(response.text);
  if (!parsed) {
    return FALLBACK;
  }
  return normalizeIntent(parsed, skills, options.drafts || []);
}

export function buildRouterSystemPrompt(
  skills: SkillManifest[],
  drafts: IntentDraftCandidate[] = [],
): string {
  const lines: string[] = [
    "You are Agent-Sin's intent router.",
    "Classify the user's input as one of these:",
    "- skill_create : intent to create a new reusable skill, automation, or tool",
    "- skill_edit   : intent to modify, extend, or change behavior of an existing skill",
    "- skill_run    : intent to run an existing skill as-is",
    "- chat         : conversation, advice, question, research, or other input not intended as a skill",
    "- unclear      : cannot determine",
    "",
    "Rules:",
    "- If the user wants a reusable mechanism, automation, or something they can keep using, classify as skill_create or skill_edit.",
    "- If requirements strongly match an existing skill, prefer skill_run or skill_edit.",
    "- If requirements strongly match an in-progress draft, return skill_create with matched_draft_id and do not create a new suggested_skill_id.",
    "- One-off task requests, opinions, and casual chat are chat.",
    "- If unsure, choose chat rather than unclear.",
    "",
    "<skills>",
  ];
  if (skills.length === 0) {
    lines.push("  <empty/>");
  } else {
    for (const skill of skills) {
      const desc = (skill.description || skill.name || "").replaceAll("\n", " ").slice(0, 200);
      lines.push(
        `  <skill id="${escapeXml(skill.id)}">${escapeXml(desc)}</skill>`,
      );
    }
  }
  lines.push("</skills>");
  lines.push("");
  lines.push("<drafts>");
  if (drafts.length === 0) {
    lines.push("  <empty/>");
  } else {
    for (const draft of drafts.slice(0, 30)) {
      const summary = (draft.summary || "").replaceAll("\n", " ").slice(0, 200);
      const status = (draft.status || "").replaceAll("\n", " ").slice(0, 40);
      lines.push(
        `  <draft id="${escapeXml(draft.skill_id)}" status="${escapeXml(status)}">${escapeXml(summary)}</draft>`,
      );
    }
  }
  lines.push("</drafts>");
  lines.push("");
  lines.push("Return exactly one JSON object. No explanation and no ``` fences:");
  lines.push(
    '{"intent":"chat|skill_create|skill_edit|skill_run|unclear","matched_skill_id":"...","matched_draft_id":"...","suggested_skill_id":"...","confidence":"low|med|high","reason":"..."}',
  );
  lines.push(
    "Include matched_skill_id only when it exactly matches an id in <skills>, matched_draft_id only when it exactly matches an id in <drafts>, and suggested_skill_id only for new skill creation as one kebab-case suggestion.",
  );
  return lines.join("\n");
}

function parseRouterJson(text: string): Record<string, unknown> | null {
  const stripped = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*$/g, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  const slice = stripped.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeIntent(
  raw: Record<string, unknown>,
  skills: SkillManifest[],
  drafts: IntentDraftCandidate[] = [],
): IntentResult {
  const intentRaw = String(raw.intent || "").trim().toLowerCase();
  const intent = (["chat", "skill_create", "skill_edit", "skill_run", "unclear"].includes(intentRaw)
    ? intentRaw
    : "chat") as Intent;
  const confidenceRaw = String(raw.confidence || "low").trim().toLowerCase();
  const confidence = (["low", "med", "high"].includes(confidenceRaw) ? confidenceRaw : "low") as
    | "low"
    | "med"
    | "high";
  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 240) : "";

  const matchedRaw = typeof raw.matched_skill_id === "string" ? raw.matched_skill_id.trim() : "";
  const matchedDraftRaw = typeof raw.matched_draft_id === "string" ? raw.matched_draft_id.trim() : "";
  const suggestedRaw = typeof raw.suggested_skill_id === "string" ? raw.suggested_skill_id.trim() : "";

  const matched = matchedRaw && skills.some((s) => s.id === matchedRaw) ? matchedRaw : undefined;
  const matchedDraft =
    matchedDraftRaw && drafts.some((draft) => draft.skill_id === matchedDraftRaw)
      ? matchedDraftRaw
      : undefined;
  const suggested = suggestedRaw ? sanitizeSkillId(suggestedRaw) : undefined;

  if ((intent === "skill_run" || intent === "skill_edit") && !matched) {
    return {
      intent: intent === "skill_edit" ? "skill_create" : "chat",
      suggested_skill_id: suggested,
      confidence,
      reason: reason || "matched_skill_id missing",
    };
  }

  return {
    intent,
    matched_skill_id: matched,
    matched_draft_id: matchedDraft,
    suggested_skill_id: intent === "skill_create" ? suggested : undefined,
    confidence,
    reason,
  };
}

function sanitizeSkillId(raw: string): string | undefined {
  const cleaned = raw
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned ? cleaned : undefined;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
