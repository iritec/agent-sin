import type { AppConfig } from "./config.js";
import { getAiProvider, type AiMessage, type AiPermissionMode, type AiProgressHandler } from "./ai-provider.js";
import type { SkillManifest } from "./skill-registry.js";
import {
  formatProfileMemoryPromptSection,
  readProfileMemoryForPrompt,
  type ProfileMemoryFiles,
} from "./profile-memory.js";

export interface PlannerHandoffTurn {
  role: "user" | "assistant" | "tool";
  content: string;
}

export interface PlanContext {
  type: "create" | "edit";
  skill_id: string;
  history: PlannerHandoffTurn[];
  original_text: string;
  existing_manifest?: SkillManifest | null;
  refine_input?: string;
  previous_plan?: string;
  onProgress?: AiProgressHandler;
  permission_mode?: AiPermissionMode;
}

export interface PlanResult {
  text: string;
  model_id: string;
  provider: string;
}

export async function planSkill(config: AppConfig, ctx: PlanContext): Promise<PlanResult> {
  const profileMemory = await readProfileMemoryForPrompt(config);
  const messages = buildPlannerMessages(ctx, profileMemory);
  const response = await getAiProvider()(config, {
    model_id: config.builder_model_id || config.chat_model_id,
    messages,
    temperature: 0.2,
    role: "builder",
    onProgress: ctx.onProgress,
    permission_mode: ctx.permission_mode,
  });
  return {
    text: extractPlanText(response.text),
    model_id: response.model_id,
    provider: response.provider,
  };
}

function buildPlannerMessages(ctx: PlanContext, profileMemory?: ProfileMemoryFiles): AiMessage[] {
  const system = [
    "You are a skill design assistant.",
    "The user may not be an engineer. From the conversation and the user's requirements, write a short plain-language plan that lets them immediately understand what the skill will do.",
    "",
    "Output language: write the plan in the same language as the user's most recent message. If the user wrote in Japanese, write the plan in Japanese; otherwise write in English.",
    "",
    "Goal: before implementation starts, the user should be able to decide 'this is fine' or 'I want to change this'.",
    "Do not use technical terms such as manifest, runtime, manual/cron, or AI step. Use everyday language.",
    "",
    "Most important rules:",
    "- Treat requirements already stated in <request> or <chat_history> as facts, not guesses, and carry them into the plan.",
    "- If the user already said specific things such as 'every hour', 'summarize at 3pm', 'list spam/read/not urgent', or 'improve by learning', include them directly and do not ask again.",
    "- For points the user has not mentioned, choose reasonable defaults and put them in the plan. It is fine to decide; the user can correct it.",
    "- Only if you truly need confirmation, add at most 1 or 2 short questions at the end. Zero questions is preferred.",
    "- Do not ask again about already-stated content by turning it into examples or multiple-choice questions.",
    "- If <previous_plan> is provided, do not repeat the same questions already asked there. Reflect answers if present; otherwise choose defaults and proceed.",
    "",
    "Writing style:",
    "- Free format. Do not force a fixed template or headings such as '## What to do'.",
    "- Keep it short and focused, roughly a few lines to 10 lines.",
    "- Put confirmation questions at the end only if needed. Omit them when not needed.",
    "",
    "Other:",
    "- For edits (type=edit), respect the current settings and make clear what will change.",
    "- The output is shown directly on screen. Do not add surrounding explanation or ``` fences.",
  ].join("\n");

  const messages: AiMessage[] = [{ role: "system", content: system }];

  const contextLines: string[] = [
    `<mode>${ctx.type}</mode>`,
    `<skill_id>${ctx.skill_id}</skill_id>`,
  ];
  const profileLines = formatProfileMemoryPromptSection(profileMemory);
  if (profileLines.length > 0) {
    contextLines.push("<profile_memory>", ...profileLines, "</profile_memory>");
  }
  if (ctx.existing_manifest) {
    const m = ctx.existing_manifest;
    contextLines.push(
      "<existing_skill>",
      `  id: ${m.id}`,
      `  name: ${m.name}`,
      `  description: ${m.description || ""}`,
      `  runtime: ${m.runtime}`,
      "</existing_skill>",
    );
  }
  if (ctx.history.length > 0) {
    contextLines.push("<chat_history>");
    for (const turn of ctx.history.slice(-12)) {
      const role = turn.role === "assistant" ? "assistant" : turn.role === "tool" ? "tool" : "user";
      contextLines.push(`  <${role}>${truncate(turn.content, 600)}</${role}>`);
    }
    contextLines.push("</chat_history>");
  }
  contextLines.push("<request>");
  contextLines.push(truncate(ctx.original_text, 1200));
  contextLines.push("</request>");
  if (ctx.previous_plan) {
    contextLines.push("<previous_plan>");
    contextLines.push(truncate(ctx.previous_plan, 1500));
    contextLines.push("</previous_plan>");
  }
  if (ctx.refine_input) {
    contextLines.push("<refine_request>");
    contextLines.push(truncate(ctx.refine_input, 600));
    contextLines.push("</refine_request>");
    contextLines.push("→ Update the plan by applying <refine_request> to <previous_plan>.");
  } else {
    contextLines.push("→ Create the initial plan from the information above.");
  }
  messages.push({ role: "user", content: contextLines.join("\n") });
  return messages;
}

function extractPlanText(raw: string): string {
  const fenced = raw.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }
  return raw.trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}
