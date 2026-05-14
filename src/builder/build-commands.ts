import type { AppConfig } from "../core/config.js";
import type { AiProgressHandler } from "../core/ai-provider.js";
import { l } from "../core/i18n.js";
import {
  buildDraftWithAgent,
  createBuildSession,
  inspectBuildReadiness,
  listBuildDrafts,
  readBuildStatus,
  registerBuildSkill,
  testBuildDraft,
  type BuilderAccessMode,
} from "./builder-session.js";

export async function buildLines(
  config: AppConfig,
  skillId: string | undefined,
  options: {
    prompt?: string;
    runtime?: "python" | "typescript";
    builder?: string;
    accessMode?: BuilderAccessMode;
    onProgress?: AiProgressHandler;
  } = {},
): Promise<string[]> {
  const session = await createBuildSession(config, skillId, {
    runtime: options.runtime,
    accessMode: options.accessMode,
  });
  const lines = [
    l(`Build workspace ready: ${session.workspace}`, `ビルド用ワークスペース準備完了: ${session.workspace}`),
    `Draft: ${session.draft_dir}`,
    `Review: ${session.review_path}`,
    l('Next: agent-sin build chat <skill-id> "what to build"', '次: agent-sin build chat <skill-id> "作りたい内容"'),
    l("Test: agent-sin build test <skill-id>", "テスト: agent-sin build test <skill-id>"),
    l("Use: the skill is saved under skills/<skill-id> as soon as files are written", "利用: ファイルが書かれた時点で skills/<skill-id> 配下に保存されています"),
  ];
  if (!options.prompt?.trim()) {
    return lines;
  }
  const result = await buildDraftWithAgent(config, session.skill_id, options.prompt, {
    runtime: options.runtime,
    builder: options.builder,
    accessMode: options.accessMode,
    onProgress: options.onProgress,
  });
  return [
    l(`Build draft updated: ${result.session.skill_id}`, `ビルドドラフトを更新しました: ${result.session.skill_id}`),
    `Builder: ${result.model_id} (${result.provider})`,
    l(`Summary: ${result.summary}`, `要約: ${result.summary}`),
    ...result.files_written.map((file) => `  + ${file}`),
    l(`Next: agent-sin build test ${result.session.skill_id}`, `次: agent-sin build test ${result.session.skill_id}`),
  ];
}

export async function buildChatLines(
  config: AppConfig,
  skillId: string,
  message: string,
  options: { onProgress?: AiProgressHandler } = {},
): Promise<string[]> {
  const result = await buildDraftWithAgent(config, skillId, message, {
    onProgress: options.onProgress,
  });
  return [
    l(`Build draft updated: ${result.session.skill_id}`, `ビルドドラフトを更新しました: ${result.session.skill_id}`),
    `Builder: ${result.model_id} (${result.provider})`,
    l(`Summary: ${result.summary}`, `要約: ${result.summary}`),
    ...result.files_written.map((file) => `  + ${file}`),
    l(`Next: agent-sin build test ${result.session.skill_id}`, `次: agent-sin build test ${result.session.skill_id}`),
  ];
}

export async function buildTestLines(
  config: AppConfig,
  skillId: string,
  payload?: Record<string, unknown>,
): Promise<string[]> {
  const result = await testBuildDraft(config, skillId, payload);
  if (result.missing_env && result.missing_env.length > 0) {
    const lines = [l("Waiting for settings. These required values are missing:", "設定待ちです。必要な値がまだ入っていません:")];
    for (const entry of result.missing_env) {
      lines.push(`  - ${entry.name}${entry.description ? ` - ${entry.description}` : ""}`);
    }
    lines.push(l("After saving them, ask to test again.", "保存できたら、もう一度「テストして」と伝えてください。"));
    return lines;
  }
  if (result.safe_to_register) {
    return [l(`✅ Ready to run. ${result.summary || ""}`, `✅ 動かせる状態です。${result.summary || ""}`).trim(), l("Ready to use.", "登録できます。")];
  }
  // failed
  const lines = [l(`❌ Still needs fixes. ${result.summary || ""}`, `❌ まだ直す必要があります。${result.summary || ""}`).trim()];
  for (const error of result.validation.errors) {
    lines.push(`[error] ${error}`);
  }
  if (result.details) {
    const tail = result.details.split("\n").slice(0, 20);
    lines.push("```", ...tail, "```");
  }
  return lines;
}

export async function buildStatusLines(config: AppConfig, skillId: string): Promise<string[]> {
  const status = await readBuildStatus(config, skillId);
  const userState = buildUserState(config, status.result, status.state.status);
  const lines = [
    `${status.state.skill_id}: ${userState}`,
  ];
  if (status.result) {
    if (typeof status.result.summary === "string") {
      lines.push(status.result.summary);
    }
    const missing = Array.isArray(status.result.missing_env) ? status.result.missing_env : [];
    for (const entry of missing) {
      if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
        lines.push(l(`Required setting: ${(entry as { name: string }).name}`, `必要な設定: ${(entry as { name: string }).name}`));
      }
    }
  }
  return lines;
}

export async function buildRegisterLines(
  config: AppConfig,
  skillId: string,
  options: { overwrite?: boolean } = {},
): Promise<string[]> {
  const readiness = await inspectBuildReadiness(config, skillId);
  if (readiness.status === "needs_config") {
    const lines = [l("Waiting for settings. Save these required values before using it:", "設定待ちです。登録前に必要な値を保存してください:")];
    for (const entry of readiness.missing_env || []) {
      lines.push(`  - ${entry.name}${entry.description ? ` - ${entry.description}` : ""}`);
    }
    return lines;
  }
  if (!readiness.safe_to_register) {
    return [
      readiness.status === "incomplete" ? l("Not complete yet. Describe what you want a little more.", "未完成です。もう少し要望を伝えてください。") : l("Still needs fixes.", "まだ直す必要があります。"),
      readiness.summary,
    ].filter(Boolean);
  }
  const registered = await registerBuildSkill(config, skillId, options);
  return [l(`✅ "${registered.skill_id}" is ready and can be called from chat.`, `✅ "${registered.skill_id}" は登録済みです。チャットから呼び出せます。`)];
}

export async function buildListLines(config: AppConfig): Promise<string[]> {
  const drafts = await listBuildDrafts(config);
  if (drafts.length === 0) {
    return [
      l("No skill drafts.", "作成中のスキルはありません。"),
      l("Create one: agent-sin build [skill-id] --prompt \"...\"", "新規作成: agent-sin build [skill-id] --prompt \"…\""),
    ];
  }
  const lines = [
    l(`Skill drafts (${drafts.length}):`, `作成中のスキル (${drafts.length}):`),
    l("id\tstatus\tupdated", "id\t状態\tupdated"),
  ];
  for (const draft of drafts) {
    const updated = draft.updated_at ? draft.updated_at.replace("T", " ").replace(/\..*$/, "") : "-";
    lines.push(`${draft.skill_id}\t${buildUserState(config, { safe_to_register: draft.safe_to_register }, draft.status)}\t${updated}`);
  }
  lines.push("");
  lines.push(l("To continue, send a request with that skill name.", "続きは、そのスキル名を指定して要望を送ってください。"));
  return lines;
}

function buildUserState(
  _config: AppConfig,
  result: Record<string, unknown> | null,
  status?: string,
): string {
  if (status === "needs_config" || result?.status === "needs_config") return l("needs config", "設定待ち");
  if (result?.safe_to_register === true || status === "ready") {
    return l("ready", "登録済み");
  }
  return l("drafting", "未完成");
}
