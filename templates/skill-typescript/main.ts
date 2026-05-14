// Agent-Sin Skill (TypeScript) - template
//
// Export run(ctx, input) directly; do not default-export it.
// Runtime provides:
//
//   ctx.log.info(msg) / warn / error    writes to logs/runs/<run-id>.json and events.jsonl
//   ctx.memory.get(key) / set(key, v)   persists under skill.yaml memory.namespace
//   ctx.ai.run(step_id, payload)        calls an ai_steps entry declared in skill.yaml
//   ctx.notify(args)                    notifies Discord/Telegram/macOS/Mail/Slack/stderr (auto recommended)
//   ctx.now()                           current time as an ISO8601 string
//
// See src/skills-sdk/types.ts for SkillInput / SkillResult.
// Runtime handles saving, notifications, and cron; skills should not touch fs directly.

interface SkillCtx {
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  // Prefer input.memory for reads; writes use await ctx.memory.set.
  memory: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<boolean>;
  };
  ai: { run: (stepId: string, payload: unknown) => Promise<unknown> };
  notify: (args: {
    title: string;
    body: string;
    subtitle?: string;
    sound?: boolean;
    channel?: "auto" | "macos" | "discord" | "telegram" | "slack" | "mail" | "stderr";
    to?: string;
    discordThreadId?: string;
    telegramThreadId?: string;
  }) => Promise<{ ok: boolean; channel: string; detail?: string }>;
  now: () => string;
}

interface SkillInput {
  args: Record<string, unknown>;
  trigger: { type: string; id: string; time: string };
  sources: Record<string, unknown> & { locale?: string };
  memory: Record<string, unknown>;
}

function locale(input: SkillInput): "en" | "ja" {
  return String(input.sources?.locale || "").toLowerCase().startsWith("ja") ? "ja" : "en";
}

function tr(input: SkillInput, en: string, ja: string): string {
  return locale(input) === "ja" ? ja : en;
}

export async function run(ctx: SkillCtx, input: SkillInput) {
  const text = String(input.args?.text ?? "").trim();

  if (!text) {
    return {
      status: "skipped" as const,
      title: tr(input, "No input", "入力なし"),
      summary: tr(input, "Skipped because text is empty.", "text が空のためスキップしました"),
      outputs: {},
      data: {},
      suggestions: [],
    };
  }

  ctx.log.info(`example-ts-skill: processing ${text.length} chars`);

  const previous = Number(input.memory?.runs ?? 0);
  const runs = previous + 1;
  await ctx.memory.set("runs", runs);

  const timestamp = input.trigger?.time || ctx.now();
  const content = `- ${timestamp} ${text}\n`;

  return {
    status: "ok" as const,
    title: tr(input, "Processed", "処理しました"),
    summary: tr(input, `Saved text (total ${runs} run(s))`, `text を保存しました (累計 ${runs} 回)`),
    outputs: {
      note: {
        content,
        frontmatter: { tags: ["example-ts"] },
      },
    },
    data: { length: text.length, runs },
    suggestions: [],
  };
}
