export interface SkillInput {
  args: Record<string, unknown>;
  trigger: {
    type: string;
    id: string;
    time: string;
  };
  sources: Record<string, unknown>;
  memory: Record<string, unknown>;
}

export type NotifyChannel = "auto" | "macos" | "discord" | "telegram" | "slack" | "mail" | "stderr";

export interface NotifyArgs {
  title: string;
  body: string;
  subtitle?: string;
  sound?: boolean;
  channel?: NotifyChannel;
  to?: string;
  discordThreadId?: string;
  telegramThreadId?: string;
}

export interface NotifyOutcome {
  ok: boolean;
  channel: string;
  detail?: string;
}

export interface SkillResult {
  status: "ok" | "skipped" | "error";
  title: string;
  summary: string;
  outputs: Record<
    string,
    {
      content?: string;
      frontmatter?: Record<string, unknown>;
      [key: string]: unknown;
    }
  >;
  data: Record<string, unknown>;
  suggestions: string[];
}
