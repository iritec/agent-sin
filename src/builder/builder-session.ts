import { appendFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentSinInstallRoot, loadModels, type AppConfig } from "../core/config.js";
import {
  findSkillManifest,
  listBuiltinSkillIds,
  loadSkillManifest,
  type SkillManifest,
} from "../core/skill-registry.js";
import {
  getAiProvider,
  type AiMessage,
  type AiProgressHandler,
  type AiProviderResponse,
} from "../core/ai-provider.js";
import { findMissingRequiredEnv, runSkill } from "../core/runtime.js";
import {
  loadKnownModelIds,
  validateSkillDirectory,
  validateSkillId,
  type ValidateSkillResult,
} from "../core/skill-scaffold.js";
import { appendConversationLog } from "../core/logger.js";
import { dotenvPath, loadDotenv } from "../core/secrets.js";
import {
  formatProfileMemoryPromptSection,
  readProfileMemoryForPrompt,
  type ProfileMemoryFiles,
} from "../core/profile-memory.js";
import { maybePromoteDailyMemory } from "../core/daily-memory-promotion.js";
import { l } from "../core/i18n.js";

export interface BuildSession {
  skill_id: string;
  workspace: string;
  draft_dir: string;
  logs_dir: string;
  review_path: string;
  session_path: string;
  result_path: string;
}

export interface RegisteredBuildSkill {
  skill_id: string;
  source_dir: string;
  target_dir: string;
}

export interface BuildMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
}

export type BuilderAccessMode = "full" | "approval";

export interface BuildSessionState {
  version: 1;
  skill_id: string;
  builder: string;
  status: "drafting" | "testing" | "ready" | "failed" | "needs_config";
  runtime: "python" | "typescript";
  access_mode: BuilderAccessMode;
  messages: BuildMessage[];
  updated_at: string;
}

export interface BuildDraftResult {
  session: BuildSession;
  state: BuildSessionState;
  files_written: string[];
  summary: string;
  model_id: string;
  provider: string;
}

export interface BuilderHandoffTurn {
  role: "user" | "assistant" | "tool";
  content: string;
}

export type BuilderEventSource = "discord" | "telegram" | "cli";

interface BuilderRuntimeContext {
  dotenv_path: string;
  dotenv_loaded: boolean;
  dotenv_keys: string[];
  default_chat_model: string;
  enabled_models: string[];
  disabled_models: string[];
  workspace_dir: string;
  skills_dir: string;
  install_root: string;
  draft_dir: string;
  event_source?: BuilderEventSource;
}

export interface BuildTestResult {
  session: BuildSession;
  validation: ValidateSkillResult;
  payload: Record<string, unknown>;
  safe_to_register: boolean;
  status: "ready" | "failed" | "needs_config";
  summary: string;
  /** Multi-line tester agent output (traceback / shell output etc.). */
  details?: string;
  missing_env?: Array<{ name: string; description?: string }>;
}

export type BuildReadinessStatus = "ready" | "failed" | "needs_config" | "incomplete";

export interface BuildReadinessResult {
  session: BuildSession;
  validation: ValidateSkillResult;
  payload: Record<string, unknown>;
  safe_to_register: boolean;
  status: BuildReadinessStatus;
  summary: string;
  details?: string;
  missing_env?: Array<{ name: string; description?: string }>;
}

export async function createBuildSession(
  config: AppConfig,
  skillId?: string,
  options: {
    runtime?: "python" | "typescript";
    accessMode?: BuilderAccessMode;
    /** Override the resolved session root. */
    root?: string;
  } = {},
): Promise<BuildSession> {
  const id = skillId || `new-skill-${timestampId()}`;
  validateSkillId(id);

  // Builder writes into the user workspace skill dir. Builder bookkeeping
  // (session.json, events.jsonl, etc.) is hidden under skills/<id>/.builder/.
  const root = options.root ?? (await resolveSessionRoot(config, id));
  const draft = root;
  const builderDir = path.join(root, ".builder");
  const logs = path.join(builderDir, "logs");
  const review = path.join(builderDir, "review.md");
  const sessionPath = path.join(builderDir, "session.json");
  const resultPath = path.join(builderDir, "builder-result.json");

  await mkdir(draft, { recursive: true });
  await mkdir(builderDir, { recursive: true });
  await mkdir(logs, { recursive: true });
  await writeTextIfMissing(
    review,
    `# Registration Review\n\n- skill id: ${id}\n- AI steps: TBD\n- allowed outputs: TBD\n- local test command: TBD\n- registration decision: pending\n`,
  );
  await writeSessionIfMissing(sessionPath, {
    version: 1,
    skill_id: id,
    builder: config.builder_model_id,
    status: "drafting",
    runtime: options.runtime || "python",
    access_mode: options.accessMode || "full",
    messages: [],
    updated_at: new Date().toISOString(),
  });
  return {
    skill_id: id,
    workspace: root,
    draft_dir: draft,
    logs_dir: logs,
    review_path: review,
    session_path: sessionPath,
    result_path: resultPath,
  };
}

export async function buildDraftWithAgent(
  config: AppConfig,
  skillId: string,
  userMessage: string,
  options: {
    runtime?: "python" | "typescript";
    builder?: string;
    handoff?: BuilderHandoffTurn[];
    onProgress?: AiProgressHandler;
    accessMode?: BuilderAccessMode;
    eventSource?: BuilderEventSource;
  } = {},
): Promise<BuildDraftResult> {
  emitBuildProgress(options.onProgress, l("Preparing build", "ビルド準備中"));
  await maybePromoteDailyMemory(config, { eventSource: "build" });
  const session = await createBuildSession(config, skillId, {
    runtime: options.runtime,
    accessMode: options.accessMode,
  });
  emitBuildProgress(options.onProgress, l(`Organizing requirements (${session.skill_id})`, `要件を整理しています (${session.skill_id})`));
  const state = await readBuildState(session);
  // models.yaml の roles.builder を毎回反映させるため、明示指定が無ければ
  // セッションに残った古い builder ID は引き継がず config の最新値を採用する。
  const resolvedBuilder = await resolveBuilderEntry(config, options.builder);
  const handoffMessage = formatHandoffSummary(options.handoff || []);
  const handoffTs = new Date().toISOString();
  const messagesWithHandoff = handoffMessage
    ? [
        ...state.messages,
        {
          role: "system" as const,
          content: handoffMessage,
          ts: handoffTs,
        },
      ]
    : state.messages;
  const nextState: BuildSessionState = {
    ...state,
    builder: resolvedBuilder,
    runtime: options.runtime || state.runtime || "python",
    access_mode: options.accessMode || state.access_mode || "full",
    status: "drafting",
    messages: [
      ...messagesWithHandoff,
      {
        role: "user",
        content: userMessage,
        ts: new Date().toISOString(),
      },
    ],
    updated_at: new Date().toISOString(),
  };
  await writeBuildState(session, nextState);
  await appendBuildEvent(session, "user_message", { content: userMessage });
  await appendConversationLog(config, {
    source: "builder",
    role: "user",
    content: userMessage,
    skill_id: session.skill_id,
    model_id: nextState.builder,
    session_id: session.skill_id,
  });
  const runtimeContext = await collectBuilderRuntimeContext(config, session, options.eventSource);
  const profileMemory = await readProfileMemoryForPrompt(config);

  const filesBefore = await listDraftFiles(session.draft_dir);
  const beforeMtimes = await snapshotMtimes(session.draft_dir, filesBefore);
  emitBuildProgress(options.onProgress, l("AI is implementing", "AIが実装しています"));
  let turn = await runBuilderTurn(config, session, nextState, {
    messages: buildBuilderMessages(session, nextState, runtimeContext, profileMemory),
    onProgress: options.onProgress,
  });
  let filesAfter = await listDraftFiles(session.draft_dir);
  await ensureBuiltinOverrideForSession(config, session);
  let hasSkillSourceFiles = await hasMinimumSkillSourceFiles(session.draft_dir, filesAfter, nextState.runtime);
  let repairedMissingSource = false;
  if (!hasSkillSourceFiles) {
    repairedMissingSource = true;
    emitBuildProgress(options.onProgress, l("Recreating required files", "必要なファイルを作り直しています"));
    await appendBuildEvent(session, "builder_repair_requested", {
      reason: "missing_skill_source_files",
    });
    turn = await runBuilderTurn(config, session, nextState, {
      messages: buildBuilderRepairMessages(session, nextState, turn.response.text, runtimeContext, profileMemory),
      onProgress: options.onProgress,
    });
    filesAfter = await listDraftFiles(session.draft_dir);
    await ensureBuiltinOverrideForSession(config, session);
    hasSkillSourceFiles = await hasMinimumSkillSourceFiles(session.draft_dir, filesAfter, nextState.runtime);
  }
  emitBuildProgress(options.onProgress, l("Checking generated files", "作成したファイルを確認しています"));
  let readiness = hasSkillSourceFiles ? await inspectBuildSessionReadiness(config, session, session.skill_id) : null;
  let repairedVerification = false;
  if (hasSkillSourceFiles && readiness?.status === "failed") {
    repairedVerification = true;
    emitBuildProgress(options.onProgress, l("Fixing verification errors", "動作確認のエラーを修正しています"));
    await appendBuildEvent(session, "builder_repair_requested", {
      reason: "verification_failed",
      summary: readiness.summary,
      errors: readiness.validation.errors,
    });
    turn = await runBuilderTurn(config, session, nextState, {
      messages: buildBuilderVerificationRepairMessages(
        session,
        nextState,
        turn.response.text,
        readiness,
        runtimeContext,
        profileMemory,
      ),
      onProgress: options.onProgress,
    });
    filesAfter = await listDraftFiles(session.draft_dir);
    await ensureBuiltinOverrideForSession(config, session);
    hasSkillSourceFiles = await hasMinimumSkillSourceFiles(session.draft_dir, filesAfter, nextState.runtime);
    emitBuildProgress(options.onProgress, l("Verifying after fixes", "修正後の動作確認をしています"));
    readiness = hasSkillSourceFiles ? await inspectBuildSessionReadiness(config, session, session.skill_id) : null;
  }
  const finalWritten = await detectWrittenFiles(session.draft_dir, filesBefore, beforeMtimes, filesAfter);
  // Use the agent's free-form text as the chat reply. Fall back to legacy summary
  // block if the agent wrapped its reply (older fake providers etc.).
  const rawSummary = turn.parsedSummary || stripBuilderArtifacts(turn.response.text) || l("(no response)", "（応答なし）");
  const summary = hasSkillSourceFiles
    ? sanitizeBuilderSummary(rawSummary, runtimeContext)
    : missingSkillSourceSummary(rawSummary);
  const status = buildStateStatusFromReadiness(hasSkillSourceFiles, readiness);
  emitBuildProgress(options.onProgress, formatBuildStatusProgress(status));
  const finishedState: BuildSessionState = {
    ...nextState,
    status,
    messages: [
      ...nextState.messages,
      {
        role: "assistant",
        content: summary,
        ts: new Date().toISOString(),
      },
    ],
    updated_at: new Date().toISOString(),
  };
  await writeBuildState(session, finishedState);
  await writeBuilderResult(session.result_path, {
    status,
    safe_to_register: readiness?.safe_to_register === true,
    summary,
    readiness_summary: readiness?.summary,
    missing_env: readiness?.missing_env,
    builder: nextState.builder,
    provider: turn.response.provider,
    files_written: finalWritten,
    repaired_missing_source: repairedMissingSource,
    repaired_verification: repairedVerification,
    generated_at: new Date().toISOString(),
  });
  await appendBuildEvent(session, "assistant_draft", {
    builder: nextState.builder,
    provider: turn.response.provider,
    summary,
    files_written: finalWritten,
    repaired_missing_source: repairedMissingSource,
    repaired_verification: repairedVerification,
    status,
  });
  await appendConversationLog(config, {
    source: "builder",
    role: "assistant",
    content: turn.response.text,
    skill_id: session.skill_id,
    model_id: nextState.builder,
    session_id: session.skill_id,
    details: {
      summary,
      files_written: finalWritten,
      provider: turn.response.provider,
      repaired_missing_source: repairedMissingSource,
      repaired_verification: repairedVerification,
      status,
    },
  });
  return {
    session,
    state: finishedState,
    files_written: finalWritten,
    summary,
    model_id: turn.response.model_id,
    provider: turn.response.provider,
  };
}

function emitBuildProgress(onProgress: AiProgressHandler | undefined, text: string): void {
  if (!onProgress) {
    return;
  }
  try {
    onProgress({ kind: "info", text });
  } catch {
    // Progress callbacks must not affect the build result.
  }
}

function formatBuildStatusProgress(status: BuildSessionState["status"]): string {
  switch (status) {
    case "ready":
      return l("Ready to run", "動かせる状態です");
    case "needs_config":
      return l("Waiting for settings", "設定待ちです");
    case "failed":
      return l("Still needs fixes", "まだ修正が必要です");
    case "testing":
      return l("Verifying", "動作確認しています");
    case "drafting":
    default:
      return l("Drafting", "作成途中です");
  }
}

export async function testBuildDraft(
  config: AppConfig,
  skillId: string,
  payload?: Record<string, unknown>,
): Promise<BuildTestResult> {
  const session = await createBuildSession(config, skillId);
  const state = await readBuildState(session);
  await writeBuildState(session, { ...state, status: "testing", updated_at: new Date().toISOString() });
  await appendBuildEvent(session, "test_started", {});

  const readiness = await inspectBuildSessionReadiness(config, session, skillId, payload);
  const status: "ready" | "failed" | "needs_config" =
    readiness.status === "ready" ? "ready" : readiness.status === "needs_config" ? "needs_config" : "failed";

  await writeReview(session.review_path, {
    skillId,
    validation: readiness.validation,
    dryRun: undefined,
    payload: readiness.payload,
    decision: readiness.safe_to_register ? "approved" : "pending",
    summary: readiness.summary,
  });
  await writeBuilderResult(session.result_path, {
    status,
    safe_to_register: readiness.safe_to_register,
    summary: readiness.summary,
    validation: {
      ok: readiness.validation.ok,
      errors: readiness.validation.errors,
      warnings: readiness.validation.warnings,
    },
    missing_env: readiness.missing_env,
    error: !readiness.safe_to_register ? readiness.summary : undefined,
    tested_at: new Date().toISOString(),
  });
  await writeBuildState(session, { ...state, status, updated_at: new Date().toISOString() });
  await appendBuildEvent(session, "test_finished", {
    status,
    safe_to_register: readiness.safe_to_register,
    summary: readiness.summary,
  });

  return {
    session,
    validation: readiness.validation,
    payload: readiness.payload,
    safe_to_register: readiness.safe_to_register,
    status,
    summary: readiness.summary,
    details: readiness.details,
    missing_env: readiness.missing_env,
  };
}

export async function inspectBuildReadiness(
  config: AppConfig,
  skillId: string,
  payload?: Record<string, unknown>,
): Promise<BuildReadinessResult> {
  const session = await createBuildSession(config, skillId);
  return inspectBuildSessionReadiness(config, session, skillId, payload);
}

async function inspectBuildSessionReadiness(
  config: AppConfig,
  session: BuildSession,
  skillId: string,
  payload?: Record<string, unknown>,
): Promise<BuildReadinessResult> {
  const validation = await validateSkillDirectory(session.draft_dir, skillId, {
    knownModelIds: await loadKnownModelIds(config),
  });
  const testPayload = payload ?? (await readFixturePayload(session));
  let missingEnv: Array<{ name: string; description?: string }> = [];
  if (validation.ok && validation.manifest) {
    await loadDotenv(config.workspace);
    missingEnv = findMissingRequiredEnv(validation.manifest);
  }

  let status: BuildReadinessStatus = "failed";
  let summary = "";
  let details = "";
  if (!validation.ok) {
    status = validation.errors.some((error) => /Entry file not found|skill\.yaml/i.test(error))
      ? "incomplete"
      : "failed";
    summary = validation.errors[0] || l("The skill definition is inconsistent.", "スキルの定義に不整合があります。");
  } else if (missingEnv.length > 0) {
    status = "needs_config";
    summary = l(`Required settings are missing: ${missingEnv.map((entry) => entry.name).join(", ")}`, `必要な設定が未入力です: ${missingEnv.map((entry) => entry.name).join(", ")}`);
  } else {
    try {
      const dryRunSkillsDir = path.dirname(session.draft_dir);
      const dryRun = await runSkill(
        { ...config, skills_dir: dryRunSkillsDir },
        skillId,
        testPayload,
        { dryRun: true },
      );
      if (dryRun.result.status === "error") {
        status = "failed";
        summary = dryRun.result.summary || l("The skill failed at runtime.", "実行時にエラーになりました。");
        details = dryRun.result.summary || "";
      } else {
        status = "ready";
        summary = dryRun.result.summary || dryRun.result.title || l("Ready to run.", "動かせる状態です。");
        details = dryRun.result.summary || "";
      }
    } catch (error) {
      status = "failed";
      summary = error instanceof Error ? error.message : String(error);
      details = summary;
    }
  }

  return {
    session,
    validation,
    payload: testPayload,
    safe_to_register: status === "ready",
    status,
    summary,
    details,
    missing_env: missingEnv.length > 0 ? missingEnv : undefined,
  };
}

function buildStateStatusFromReadiness(
  hasSkillSourceFiles: boolean,
  readiness: BuildReadinessResult | null,
): BuildSessionState["status"] {
  if (!hasSkillSourceFiles || !readiness) return "drafting";
  if (readiness.status === "ready") return "ready";
  if (readiness.status === "needs_config") return "needs_config";
  return "failed";
}

export interface BuildDraftSummary {
  skill_id: string;
  status: BuildSessionState["status"];
  runtime: BuildSessionState["runtime"];
  builder: string;
  message_count: number;
  updated_at: string;
  draft_dir: string;
  has_skill_yaml: boolean;
  safe_to_register: boolean;
  summary?: string;
}

export async function listBuildDrafts(config: AppConfig): Promise<BuildDraftSummary[]> {
  const summaries: BuildDraftSummary[] = [];

  // Scan skills_dir for entries that have a .builder/session.json
  let entries;
  try {
    entries = await readdir(config.skills_dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillId = entry.name;
    const skillDir = path.join(config.skills_dir, skillId);
    const sessionPath = path.join(skillDir, ".builder", "session.json");
    let state: BuildSessionState | null = null;
    try {
      const raw = await readFile(sessionPath, "utf8");
      state = JSON.parse(raw) as BuildSessionState;
    } catch {
      continue;
    }
    const hasSkillYaml = await pathExists(path.join(skillDir, "skill.yaml"));
    const result = await readJsonIfExists(path.join(skillDir, ".builder", "builder-result.json"));
    const summary = typeof result?.summary === "string" ? result.summary : undefined;
    summaries.push({
      skill_id: skillId,
      status: state.status || "drafting",
      runtime: state.runtime === "typescript" ? "typescript" : "python",
      builder: state.builder || config.builder_model_id,
      message_count: Array.isArray(state.messages) ? state.messages.length : 0,
      updated_at: state.updated_at || "",
      draft_dir: skillDir,
      has_skill_yaml: hasSkillYaml,
      safe_to_register: Boolean(result && result.safe_to_register === true),
      summary,
    });
  }

  summaries.sort((a, b) => {
    if (a.updated_at && b.updated_at) {
      return b.updated_at.localeCompare(a.updated_at);
    }
    return a.skill_id.localeCompare(b.skill_id);
  });
  return summaries;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function readBuildStatus(config: AppConfig, skillId: string): Promise<{
  session: BuildSession;
  state: BuildSessionState;
  result: Record<string, unknown> | null;
}> {
  const session = await createBuildSession(config, skillId);
  return {
    session,
    state: await readBuildState(session),
    result: await readJsonIfExists(session.result_path),
  };
}

export async function registerBuildSkill(
  config: AppConfig,
  skillId: string,
  _options: { overwrite?: boolean } = {},
): Promise<RegisteredBuildSkill> {
  // Builder writes into the user skill dir (an override copy when editing a
  // builtin). Registration is a no-op: verify skill.yaml is in place at the
  // resolved root and report success.
  const target = await resolveSessionRoot(config, skillId);
  const manifest = await assertRegisterableSkillSource(config, target, skillId);
  return { skill_id: manifest.id, source_dir: target, target_dir: target };
}

function formatHandoffSummary(handoff: BuilderHandoffTurn[]): string {
  const trimmed = handoff
    .filter((turn) => turn.content && turn.content.trim().length > 0)
    .slice(-12);
  if (trimmed.length === 0) {
    return "";
  }
  const lines: string[] = [
    "[Chat handoff context — 直前のチャットでの会話内容です。要件抽出に使ってください]",
  ];
  for (const turn of trimmed) {
    const role = turn.role === "assistant" ? "assistant" : turn.role === "tool" ? "tool" : "user";
    const content = turn.content.replaceAll("```", "´´´").slice(0, 800);
    lines.push(`<${role}>\n${content}\n</${role}>`);
  }
  return lines.join("\n");
}

async function assertRegisterableSkillSource(
  config: AppConfig,
  skillDir: string,
  skillId: string,
): Promise<SkillManifest> {
  const validation = await validateSkillDirectory(skillDir, skillId, {
    knownModelIds: await loadKnownModelIds(config),
  });
  if (validation.ok && validation.manifest) {
    return validation.manifest;
  }
  const hasManifest = await pathExists(path.join(skillDir, "skill.yaml"));
  const isMissingEntry = validation.errors.some((error) => /Entry file not found/i.test(error));
  if (!hasManifest || isMissingEntry) {
    throw new Error(l("Creation is not complete yet. Describe what the skill should do a little more specifically.", "まだ作成が完了していません。何をするスキルかをもう少し具体的に伝えてください。"));
  }
  const hasIdMismatch = validation.errors.some((error) => /does not match/i.test(error));
  if (hasIdMismatch) {
    throw new Error(l("The skill name and save location do not match. Describe the fix again.", "スキルの名前と保存先が一致していません。もう一度、修正内容を伝えてください。"));
  }
  throw new Error(l("The skill definition is inconsistent. Describe the fix again.", "スキルの定義に不整合があります。もう一度、修正内容を伝えてください。"));
}

// CLI で `--builder` などを明示指定したときだけ candidate を尊重する。
// 通常呼び出しでは候補なしで来るので、必ず config.builder_model_id
// (= models.yaml の roles.builder) が採用される。
async function resolveBuilderEntry(config: AppConfig, candidate: string | undefined): Promise<string> {
  const fallback = config.builder_model_id;
  if (!candidate) return fallback;
  try {
    const models = await loadModels(config.workspace);
    if (models.models[candidate]) return candidate;
  } catch {
    // models.yaml unreadable — fall through to fallback
  }
  return fallback;
}

async function runBuilderTurn(
  config: AppConfig,
  session: BuildSession,
  state: BuildSessionState,
  options: {
    messages: AiMessage[];
    onProgress?: AiProgressHandler;
  },
): Promise<{ response: AiProviderResponse; parsedSummary?: string }> {
  emitBuildProgress(options.onProgress, l("Starting builder", "ビルダーを起動しています"));
  const response = await getAiProvider()(config, {
    model_id: state.builder,
    messages: options.messages,
    temperature: 0.2,
    role: "builder",
    onProgress: options.onProgress,
    permission_mode: "bypass",
    cwd: session.draft_dir,
  });
  // Backward compat: if the AI returned legacy fenced file blocks, write them.
  let parsedSummary: string | undefined;
  try {
    const parsed = parseBuilderFiles(response.text);
    parsedSummary = parsed.summary;
    if (Object.keys(parsed.files).length > 0) {
      emitBuildProgress(options.onProgress, l(`Writing ${Object.keys(parsed.files).length} file(s)`, `${Object.keys(parsed.files).length}件のファイルを書き込んでいます`));
      await writeBuilderFiles(session.draft_dir, parsed.files);
    }
  } catch {
    // No fenced blocks — agent wrote (or didn't) directly via cwd.
  }
  return { response, parsedSummary };
}

export async function prepareEditDraft(
  config: AppConfig,
  skillId: string,
): Promise<BuildSession> {
  let manifest: SkillManifest;
  try {
    manifest = await findSkillManifest(config.skills_dir, skillId);
  } catch {
    throw new Error(l(`Skill not found for edit: ${skillId}`, `編集するスキルが見つかりません: ${skillId}`));
  }
  const root = await resolveSessionRoot(config, skillId, manifest);
  const session = await createBuildSession(config, skillId, {
    runtime: manifest.runtime,
    root,
  });
  if (manifest.source === "builtin") {
    await appendBuildEvent(session, "builtin_override_prepared", {
      source_dir: manifest.dir,
      target_dir: session.draft_dir,
    });
  }
  return session;
}

export async function prepareRepairDraft(
  config: AppConfig,
  manifest: SkillManifest,
): Promise<BuildSession> {
  return prepareEditDraft(config, manifest.id);
}

/**
 * Resolve the skill directory the builder should treat as its working root.
 *
 * - User skills (or brand new skills without a manifest yet) → `skills_dir/<id>/`.
 * - Builtin skills → copy into `skills_dir/<id>/` with `override: true` set,
 *   so the packaged `builtin-skills/<id>/` stays untouched.
 */
async function resolveSessionRoot(
  config: AppConfig,
  skillId: string,
  preloadedManifest?: SkillManifest,
): Promise<string> {
  let manifest: SkillManifest | null = preloadedManifest ?? null;
  if (!manifest) {
    try {
      manifest = await findSkillManifest(config.skills_dir, skillId);
    } catch {
      manifest = null;
    }
  }
  if (!manifest || manifest.source !== "builtin") {
    return path.join(config.skills_dir, skillId);
  }
  const target = path.join(config.skills_dir, skillId);
  await mkdir(config.skills_dir, { recursive: true });
  if (!(await pathExists(path.join(target, "skill.yaml")))) {
    await cp(manifest.dir, target, { recursive: true, force: false, errorOnExist: false });
  }
  await ensureOverrideFlag(path.join(target, "skill.yaml"));
  return target;
}

async function ensureBuiltinOverrideForSession(config: AppConfig, session: BuildSession): Promise<void> {
  const builtinIds = await listBuiltinSkillIds();
  if (!builtinIds.has(session.skill_id)) return;
  const manifestPath = path.join(session.draft_dir, "skill.yaml");
  if (!(await pathExists(manifestPath))) return;
  if (!isPathInside(path.resolve(config.skills_dir), path.resolve(session.draft_dir))) return;
  await ensureOverrideFlag(manifestPath);
}

async function ensureOverrideFlag(manifestPath: string): Promise<void> {
  const raw = await readFile(manifestPath, "utf8");
  const next = /^override:\s+/m.test(raw)
    ? raw.replace(/^override:\s+.*$/m, "override: true")
    : `${raw.replace(/\s+$/g, "")}\noverride: true\n`;
  await writeFile(manifestPath, next, "utf8");
}

function buildBuilderRepairMessages(
  session: BuildSession,
  state: BuildSessionState,
  previousText: string,
  runtimeContext?: BuilderRuntimeContext,
  profileMemory?: ProfileMemoryFiles,
): AiMessage[] {
  const previous = stripBuilderArtifacts(previousText) || previousText || "（応答なし）";
  return [
    ...buildBuilderMessages(session, state, runtimeContext, profileMemory),
    { role: "assistant", content: previous },
    {
      role: "user",
      content: [
        "直前の返答では draft に skill.yaml / main.* が作られていません。",
        "ユーザーに言い直しを求めず、このターンで cwd 直下に最小限動く実装を書いてください。",
        "不明点は一般的な仮定で補い、認証情報が必要なら required_env に宣言してください。",
        "完了後はユーザー向けの短い報告だけ返してください。",
      ].join("\n"),
    },
  ];
}

function buildBuilderVerificationRepairMessages(
  session: BuildSession,
  state: BuildSessionState,
  previousText: string,
  readiness: BuildReadinessResult,
  runtimeContext?: BuilderRuntimeContext,
  profileMemory?: ProfileMemoryFiles,
): AiMessage[] {
  const previous = stripBuilderArtifacts(previousText) || previousText || "（応答なし）";
  const errors = readiness.validation.errors.length > 0
    ? readiness.validation.errors.join("\n")
    : readiness.summary;
  return [
    ...buildBuilderMessages(session, state, runtimeContext, profileMemory),
    { role: "assistant", content: previous },
    {
      role: "user",
      content: [
        "作成後の自己確認でまだ動かせませんでした。",
        "ユーザーに言い直しを求めず、このターンで cwd 直下の実装を修正してください。",
        "認証情報が必要なだけの場合は required_env に宣言し、実装は完成させてください。",
        "",
        "<verification_result>",
        errors,
        "</verification_result>",
      ].join("\n"),
    },
  ];
}

function missingSkillSourceSummary(rawSummary: string): string {
  const trimmed = rawSummary.trim();
  if (!trimmed || trimmed === "（応答なし）") {
    return l("I could not continue creating it. Please describe in one sentence what you want the skill to do.", "作成に進めませんでした。何をするスキルにしたいか、1文で教えてください。");
  }
  return l(`${trimmed}\n\nI need more detail to create it. Please describe in one sentence what you want the skill to do.`, `${trimmed}\n\n作成に必要な内容が足りません。何をするスキルにしたいか、1文で教えてください。`);
}

function sanitizeBuilderSummary(summary: string, _context: BuilderRuntimeContext): string {
  return summary
    .replace(/^.*(?:override|上書きコピー|workspace override|packaged builtin|packaged original|ビルトイン.*本体.*変更).*$\n?/gim, "")
    .replace(/準備が(?:全部)?終わってから[^\n。]*[「『]?登録して[」』]?[^\n。]*[。]?/g, "準備ができたら、そのまま使えます。")
    .replace(/[「『]?登録して[」』]?と言って(?:ください|もらえれば使えます)[。]?/g, "そのまま使えます。")
    .replace(/そこから登録します/g, "そこから確認します")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function collectBuilderRuntimeContext(
  config: AppConfig,
  session: BuildSession,
  eventSource?: BuilderEventSource,
): Promise<BuilderRuntimeContext> {
  const envPath = await dotenvPath(config.workspace);
  const dotenvKeys = await readDotenvKeyNames(envPath);
  await loadDotenv(config.workspace);

  let enabledModels: string[] = [];
  let disabledModels: string[] = [];
  try {
    const models = await loadModels(config.workspace);
    const entries = Object.entries(models.models || {});
    enabledModels = entries
      .filter(([, model]) => model.enabled !== false)
      .map(([id, model]) => formatModelSummary(id, model));
    disabledModels = entries
      .filter(([, model]) => model.enabled === false)
      .map(([id, model]) => formatModelSummary(id, model));
  } catch {
    enabledModels = [];
    disabledModels = [];
  }

  return {
    dotenv_path: envPath,
    dotenv_loaded: dotenvKeys !== null,
    dotenv_keys: dotenvKeys || [],
    default_chat_model: config.chat_model_id,
    enabled_models: enabledModels,
    disabled_models: disabledModels,
    workspace_dir: config.workspace,
    skills_dir: config.skills_dir,
    install_root: agentSinInstallRoot(),
    draft_dir: session.draft_dir,
    event_source: eventSource,
  };
}

async function readDotenvKeyNames(envPath: string): Promise<string[] | null> {
  let raw = "";
  try {
    raw = await readFile(envPath, "utf8");
  } catch {
    return null;
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    keys.push(match[1]);
  }
  return keys;
}

function formatModelSummary(
  id: string,
  model: { model?: string; provider?: string; type?: string },
): string {
  const target = String(model.model || model.provider || model.type || "").trim();
  return target ? `${id}(${target})` : id;
}

export function formatDiscordSlashGuidance(
  context: { event_source?: BuilderEventSource } | undefined,
): string[] {
  if (!context || context.event_source !== "discord") return [];
  return [
    "# Discord セッション限定の追加仕様（スラッシュコマンドも併設できる）",
    "- このセッションは Discord から開かれている。`invocation.phrases` によるチャット発火は今まで通り必須で残す。`discord_slash` はそれに**追加**するショートカットで、置き換えではない。",
    "- ユーザーが『/コマンドで叩きたい』『スラコマで』『ボタンで』など Discord ネイティブで呼びたい意図を出した場合、または引数が1〜3個で値が明確な単純な操作系スキル(todo追加・メモ追加・削除・トグルなど)を作る場合は、`invocation.discord_slash` を併設する。AI生成・対話・要約系は phrases だけで十分。",
    "- 書き方:\n```\ninvocation:\n  phrases: [...]              # 必須(残す)\n  discord_slash:                # 追加(任意)\n    description: コインを投げる\n    options:\n      - name: count\n        type: integer           # string|integer|number|boolean のみ\n        description: 回数\n        required: false\n```",
    "- ルール: コマンド名は skill.id がそのまま使われる。サブコマンドは作らない(1スキル=1コマンド、フラットなオプション)。`options[*].type` は string/integer/number/boolean のみ。`choices` は string/integer/number のみで `[{name, value}]`。`required` は省略時 false。日本語の説明は `description_ja` に書ける。",
    "- input.schema と discord_slash.options は整合させる。同名・同義の引数で書く(例: schema に `text` があれば option も `name: text`)。",
    "- 反映タイミング: `discord_slash` を**新規に追加・変更・削除**したスキルを登録した時は、Discord 側のスラッシュコマンド一覧に出るまで Bot の再起動(再接続)が必要。登録完了メッセージにその旨を必ず添える(例: 『スラコマとして使うには Bot の再起動が必要です。チャット起動(phrases)は今すぐ使えます』)。`phrases` だけのスキルや、既存スキルの本体ロジックだけ直した場合は再起動不要。",
    "",
  ];
}

function formatBuilderRuntimeContext(context: BuilderRuntimeContext | undefined): string[] {
  if (!context) return [];
  const envKeys = context.dotenv_keys.length > 0 ? summarizeList(context.dotenv_keys, 80) : "なし";
  const enabled = context.enabled_models.length > 0 ? summarizeList(context.enabled_models, 30) : "なし";
  const disabled = context.disabled_models.length > 0 ? summarizeList(context.disabled_models, 30) : "なし";
  return [
    "# 作業場所",
    `- 作業ディレクトリ(cwd / 書き込み許可): ${context.draft_dir}`,
    `- agent-sin 本体(参考用に読み取りのみ): ${context.install_root}`,
    `- agent-sin ワークスペース: ${context.workspace_dir}`,
    `- 他スキル置き場(参考用に読み取りのみ): ${context.skills_dir}`,
    `- .env(スキルに必要な環境変数だけ更新可): ${context.dotenv_path}`,
    "",
    "# 直接触ってはいけない領域と対応ルート",
    `- ${context.dotenv_path}: このスキルの required_env に書いたキー、またはユーザーが明示したスキル用キーだけ追記・更新してよい。既存の無関係なキーは変更しない。agent-sin 本体設定(AGENT_SIN_*)は絶対に書かない。`,
    `- ${context.skills_dir}/<別スキル>: 別スキルを直すときはユーザーに『○○ を直したい』と返してもらう。host 側が cwd をそのスキルに切り替えてビルドモードを再起動する。`,
    `- ${context.workspace_dir}/schedules.yaml: 直接編集しない。定期実行が必要なら schedule-add などの組み込みスキル経由をユーザーに案内する。`,
    `- ${context.workspace_dir}/models.yaml / config.toml: 触らない。agent-sin 本体の設定。`,
    `- ${context.install_root}: agent-sin 本体ソース。理解の参考に読むのは OK、書き込みは禁止。`,
    "",
    "# 既存設定（値は非表示）",
    `- .env: ${context.dotenv_loaded ? "読み込み済み" : "未作成"} (${context.dotenv_path})`,
    `- .env内のキー: ${envKeys}`,
    `- 既定モデル: ${context.default_chat_model}`,
    `- 有効なモデルID: ${enabled}`,
    `- 無効なモデルID: ${disabled}`,
    `- 登録方式: 自動登録済み。完了後に登録依頼は不要`,
  ];
}

function summarizeList(values: string[], limit: number): string {
  const visible = values.slice(0, limit);
  const rest = values.length - visible.length;
  return rest > 0 ? `${visible.join(", ")} ほか${rest}件` : visible.join(", ");
}

function buildBuilderMessages(
  session: BuildSession,
  state: BuildSessionState,
  runtimeContext?: BuilderRuntimeContext,
  profileMemory?: ProfileMemoryFiles,
): AiMessage[] {
  const profileLines = formatProfileMemoryPromptSection(profileMemory);
  const system = [
    "# 状況",
    "- きみは AIエージェント agent-sin のスキル作成機能。",
    "- 仕事はユーザーの要望に合わせて agent-sin で動くスキルを作って、書き終わった瞬間から使える状態にすること。",
    "- ユーザーはエンジニアではない。関数名・コマンド・技術用語は聞かない。普段の言葉で要望を受け取る。",
    "",
    "# 進め方",
    "1. ユーザーの要件を読む。要件が固まらないと作れないことだけ、一度に最大3つまでまとめて聞いていい。返答がまだ足りなければ再度3つまで聞き直してOK。要件が固まるまで何回往復しても構わない。逆に、判断できる範囲なら聞かずに最短で実装に進む。",
    "2. 要件が固まったら、応答本文に**必ず**ファイルブロックを並べてファイルを書き出す。形式は `\\`\\`\\`file:<相対パス>` で開いて、内容をそのまま書き、`\\`\\`\\`` で閉じる。skill.yaml と main.py(TypeScript なら main.ts) を必ず両方出す。必要なら fixtures/input.json も同じ形式で。`\\`\\`\\`yaml` `\\`\\`\\`python` などの言語フェンスは使わず、「ファイル:」のような日本語ラベルも単独で使わない。完了報告だけ書いてファイルブロックを省くと agent-sin は何も書き込まないので、スキルは未完成のままになる。例:\n```file:skill.yaml\nid: example\nname: 例\ndescription: ...\nruntime: python\ninvocation:\n  phrases:\n    - 例を実行\noutput_mode: raw\n```\n```file:main.py\nasync def run(ctx, input):\n    return {\"status\": \"ok\", \"summary\": \"hello\"}\n```",
    "3. ファイルを書いた後で完了報告を書く。完了報告は『何ができるようになったか』を 1〜2 文で伝える短い文章にする。『テストしますか？』『動かしますか？』のような確認質問は付けない。ユーザーが『動かして』『試して』のようにこのスキルを動かしたいと返したら、システム側が自動でチャットモードに切り替えて実際にスキルを実行するので、きみは何もしなくていい。",
    "",
    "# 既存設定の扱い",
    "- 作成前に下の既存設定一覧を確認し、既にあるキーを未設定として案内しない。値は見えない前提で、キー名の有無だけを使う。",
    "- `ai_steps[].model` は基本的に論理ロール名 `chat`（軽量応答）か `builder`（高品質生成）を指定する。特定モデルが必要な場合だけ実モデルID（例: `codex-low`）を書く。存在しないモデル名は書かない。",
    "- ユーザーが『Discord通知』と言った場合は agent-sin の通知機能のこと。スキルからは `ctx.notify({ channel: \"discord\", ... })` を呼ぶ。独自の `DISCORD_WEBHOOK_URL` を作ったり直接WebhookへPOSTしない。",
    "- Discord通知に必要な `AGENT_SIN_DISCORD_*` は agent-sin 本体の設定なので、skill.yaml の `required_env` や `.env` 保存例に書かない。設定済みでない場合だけ、agent-sin のDiscord通知設定が必要だと短く案内する。",
    "- ユーザーが『Telegram通知』と言った場合も同じく `ctx.notify({ channel: \"telegram\", ... })` を使う。`AGENT_SIN_TELEGRAM_*` は本体設定なので skill.yaml には書かない。",
    "",
    "# 禁止事項（厳守）",
    "- skill.yaml と main.* を書かずに完了報告だけ書くのは厳禁。仕様確認だけで終わらない。",
    "- 認証情報の取得が必要なときも、まず skill.yaml と main.* は先に書く。`required_env` で宣言しておけば、値が入るまで実行されないだけで実装は進められる。",
    "- **agent-sin 本体の運用設定 (`AGENT_SIN_CODEX_*` / `AGENT_SIN_DISCORD_*` / `AGENT_SIN_TELEGRAM_*` / `AGENT_SIN_NOTIFY_*` / `AGENT_SIN_SLACK_*` / `AGENT_SIN_SMTP_*` / `AGENT_SIN_MAIL_*` / `AGENT_SIN_FAKE_*` / `AGENT_SIN_DISABLE_*` など) には絶対に触れない**。`.env` 保存例にも入れない。これらは agent-sin 本体の動作設定であってスキルの設定ではない。スキルが必要とするキー（例: `OPENAI_API_KEY`、`GMAIL_USER` 等のスキル固有キー）だけを `required_env` に書く。",
    "- ユーザーへの『使う前の準備』案内は最大 4 ステップまで。長い公式ドキュメントの引用や、ユーザーが頼んでいない設定値の提案を混ぜない。",
    "- outputs に書き出すファイル(メモ・レポート等)は、ユーザーが後から読み返したり別スキルで再利用する素材になるものだけ。一時的な実行結果や内部状態を outputs に残さない。一時データは戻り値の `data` で返すか、`memory` に置く。",
    "",
    "# ユーザーへの返答ルール（最重要）",
    "ユーザーが知りたいのは『何ができるようになったか』と『使うために自分は何をすればいいか』だけ。技術詳細は出さない。",
    "ユーザーへの返答はユーザーの言語に合わせる。英語の依頼なら英語、日本語の依頼なら日本語で短く返す。",
    "",
    "ユーザーへの応答は必ずプレーンテキストで返す。Markdown 記法（**太字**、# 見出し、- や * の箇条書き、1. 番号付きリスト、バッククォートのインラインコード、3連バッククォートのコードブロック、[リンク](url)、表 など）は一切使わない。完了報告も準備の案内も装飾なしの普通の文章で書く。リスト的な内容も箇条書き記号を使わず、改行で区切るだけにする。ファイル書き込み用の file:/summary フェンスはユーザーには表示されない内部用なので、これだけは従来通り使ってよい。",
    "",
    "書かないこと",
    "- 作ったファイル名（skill.yaml / main.py / fixtures/... など）の列挙",
    "- テスト件数・validation・ready 判定・provider 名などの内部用語",
    "- ビルトイン、上書きコピー、override フラグなどの内部保存方式",
    "- 『Python構文チェック OK』のような実行ログ",
    "- 『安全な中核として』のような実装の説明",
    "",
    "書くこと（完了報告のテンプレ）",
    "何ができるようになったかを 1〜2 文（例:『Gmail の未読を分類して、15時にレポートにまとめます』）。使うために必要な準備があれば続けて短く書く。『テストしますか？』『動かしますか？』のような確認質問は付けない。ユーザーから『動かして』『試して』と返ってきたら自動でチャットモードに戻って実行されるので、こちらから促す必要はない。",
    "",
    "## 認証情報（APIキー / OAuth / トークン / cookie など）が必要なとき",
    "外部サービス連携をするスキルは、ほぼ必ず認証情報の取得が要る。実装した時点では“まだ動かない”のが普通なので、必ず以下を案内する。",
    "- どこから取得するか: 公式コンソールの場所と手順を 2〜4 ステップで具体的に書く。",
    "  例: Gmail → 『Google Cloud Console (https://console.cloud.google.com/) で新規プロジェクト作成 → 「Gmail API」 を有効化 → OAuth 同意画面を設定 → 認証情報 → OAuth クライアント ID（デスクトップ）を作成 → JSON をダウンロード』",
    "- どこに何を保存するか: `~/.agent-sin/.env` に書くキー名と形式を 1 行ずつ提示する。",
    "  例: `GMAIL_CREDENTIALS_PATH=/Users/you/credentials.json`、`OPENAI_API_KEY=sk-...`",
    "- ユーザーが値を直接チャットに貼ってきて、それが required_env のどれに入るか判断できる場合は、あなたが `~/.agent-sin/.env` を直接更新してよい。保存したら『設定しました』とだけ短く返す。判断できない場合だけ `env NAME=値` の形式で送るよう短く案内する。",
    "- 準備が終わるまで『テストして』を促さない。代わりに『〜を取得して .env に保存できたら教えてください、そこから動作確認します』と書く。",
    "",
    "# スキルの作り方ルール",
    "- skill.yaml の必須は `id`(kebab-case) / `runtime`(python|typescript) / `name` / `description` / `invocation.phrases` の5つ。`invocation.phrases` はチャットからの呼び出しに必須で、スキル名・別名・代表的な発話を3〜6個並べる（例: id が `flip-coin` なら `[\"コイントス\", \"コイン投げて\", \"表か裏\", \"flip-coin\"]`）。`entry` は省略時 runtime 別に `main.py` / `main.ts`、`handler` は省略時 `run` で省略OK。`invocation.command`, `input.schema`, `outputs`(ユーザーが読み返すメモ・レポートを残すときだけ), `memory`(状態を持つときだけ), `ai_steps`(AI を呼ぶときだけ), `required_env` は必要に応じて書く。空の `outputs: []` / `ai_steps: []` / `retry: max_attempts: 0` は冗長なので書かない。`schema_version` / `type` / `security` / `triggers` は廃止済み。",
    "- handler シグネチャ: Python は `async def run(ctx, input)`、TS は `export async function run(ctx, input)`。`input` は `{args, trigger, sources, memory}` の dict で、`input.args` は skill.yaml の `input.schema` で検証済み。",
    "- 戻り値は `{status: 'ok'|'skipped'|'error', title, summary, outputs, data, suggestions}`。",
    "- ctx で使えるのは `log.info/warn/error`、`memory.get`(async)/`memory.set`(async)、`ai.run(step_id, payload)`、`notify(args)`、`now()` のみ。env や fs を直接触らない。",
    "- ファイル出力は `outputs[id]` に `{content, frontmatter}` を返すだけ。Runtime が skill.yaml の `outputs[].path/filename`(`{{yyyy}}/{{MM}}/{{dd}}/{{date}}/{{datetime}}` 使用可、`append: true` で追記) に従って保存する。スキル側で open/write しない。`outputs[].type` は `markdown` か `json`。",
    "- AI を呼ぶときは skill.yaml の `ai_steps` に `id / purpose / model`(任意で `optional: true`) を宣言してから `ctx.ai.run(id, payload)`。未宣言の id は呼べない。",
    "- 環境変数は skill.yaml の `required_env: [{name, description, optional}]` で宣言。Runtime が実行前にチェックして、足りなければ実行を止める。",
    "- 結果をそのままユーザーに返したい単純なCRUD系スキル（todo追加・一覧・完了など）では skill.yaml に `output_mode: raw` を付けると、LLM の再整形ターンを挟まず summary がそのままユーザー画面に出る。複雑な要約・言い換えが要る場合は付けない（既定動作で LLM が整形する）。",
    "- 定期実行は skill.yaml には書かない(builder自身は schedules.yaml を触らない)。代わりに、できあがったスキルを定期実行したい旨をユーザーに伝え、会話モードまたは CLI から `schedule-add` ビルトインスキルを呼ぶように案内する(`agent-sin run schedule-add --payload '{\"id\":\"...\",\"cron\":\"min hour dom month dow\",\"skill\":\"<this-skill>\"}'`)。手書きしたい場合は `~/.agent-sin/schedules.yaml` の `schedules:` 配列に `- id / cron / skill / args / approve` を追記する選択肢もある。",
    "- 書き込んでいいのは cwd 直下: `skill.yaml` / `main.py` または `main.ts` / `README.md` / `fixtures/` / `tests` / `prompts/`。例外として、このスキルの設定に必要なキーだけ `~/.agent-sin/.env` に追記・更新してよい。それ以外は cwd の外に書き込まない。",
    "- 読み取りは agent-sin 本体や他スキルにも自由に行ってよい。参考実装は `~/.agent-sin/skills/memo-save/`。",
    "- 横断ファイル(schedules.yaml / 他スキル / models.yaml / config.toml など) を変えたい衝動が出たら、自分では触らず、ユーザー向けに『○○してほしい』と1行で書いて完了報告に含める。host 側が対応する。",
    "",
    ...formatDiscordSlashGuidance(runtimeContext),
    ...formatBuilderRuntimeContext(runtimeContext),
    ...(profileLines.length > 0 ? ["", l("# Long-term profile", "# 長期プロフィール"), ...profileLines] : []),
    "",
    `Skill id: ${session.skill_id}`,
    `Runtime: ${state.runtime}`,
  ].join("\n");

  const messages: AiMessage[] = [{ role: "system", content: system }];
  for (const message of state.messages) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }
  return messages;
}

function parseBuilderFiles(text: string): { summary?: string; files: Record<string, string> } {
  // Preferred format: one fenced block per file.
  //   ```file:<path>
  //   <raw content>
  //   ```
  // Fallbacks accept what models tend to emit naturally:
  //   ファイル: skill.yaml
  //   ```yaml
  //   ...
  //   ```
  // Plus an optional summary block (```summary ... ```).
  const files: Record<string, string> = {};
  const filePattern = /```file:\s*([^\n`]+?)\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(text)) !== null) {
    const rawName = match[1].trim();
    if (!rawName) continue;
    files[normalizeBuilderFilePath(rawName)] = match[2];
  }
  if (Object.keys(files).length === 0) {
    extractLabeledFenceFiles(text, files);
  }
  if (Object.keys(files).length === 0) {
    // Backward-compat: try the legacy ```builder-files JSON block once.
    const legacy = parseLegacyBuilderFilesBlock(text);
    if (legacy) return legacy;
    throw new Error(l("Builder did not return any ```file:<path> blocks.", "ビルダーが ```file:<path> ブロックを返しませんでした。"));
  }
  const summaryMatch = text.match(/```summary\s*\n([\s\S]*?)\n```/);
  const summary = summaryMatch ? summaryMatch[1].trim() : undefined;
  return { summary, files };
}

// Accept "ファイル: <path>" / "File: <path>" / "## <path>" labels followed by a
// language-tagged fenced block. Many models default to this when asked to write
// files without a strict format instruction.
function extractLabeledFenceFiles(text: string, files: Record<string, string>): void {
  const labelPattern =
    /(?:^|\n)[ \t#*]*(?:ファイル|File|file|FILE)\s*[:：]\s*`?([^\n`]+?)`?[ \t]*\r?\n+```[a-zA-Z0-9_+\-.]*\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(text)) !== null) {
    const rawName = match[1].trim();
    if (!rawName) continue;
    try {
      files[normalizeBuilderFilePath(rawName)] = match[2];
    } catch {
      // unsafe / disallowed path — silently skip so other files still write.
    }
  }
}

function parseLegacyBuilderFilesBlock(
  text: string,
): { summary?: string; files: Record<string, string> } | null {
  const match = text.match(/```builder-files[^\n]*\n([\s\S]*?)```/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(extractJsonBody(match[1])) as {
      summary?: unknown;
      files?: unknown;
    };
    const files = parsed.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    const normalized: Record<string, string> = {};
    for (const [name, content] of Object.entries(files as Record<string, unknown>)) {
      if (typeof content !== "string") return null;
      normalized[normalizeBuilderFilePath(name)] = content;
    }
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      files: normalized,
    };
  } catch {
    return null;
  }
}

function extractJsonBody(content: string): string {
  // Some models prefix the fenced body with a language hint like "JSON\n" or
  // "json\n" before the actual object. Strip leading non-JSON whitespace and
  // optional language hints, then take from the first { to the matching }.
  const trimmed = content.replace(/^\s*(?:json|JSON)\s*[\r\n]+/, "").trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return trimmed;
  return trimmed.slice(start);
}

function normalizeBuilderFilePath(name: string): string {
  const normalized = path.posix.normalize(name.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(l(`Unsafe builder file path: ${name}`, `安全でないビルダーファイルパスです: ${name}`));
  }
  const allowed =
    normalized === "skill.yaml" ||
    normalized === "main.py" ||
    normalized === "main.ts" ||
    normalized === "README.md" ||
    normalized.startsWith("fixtures/") ||
    normalized.startsWith("tests/") ||
    normalized.startsWith("prompts/");
  if (!allowed) {
    throw new Error(l(`Builder may not write file: ${name}`, `ビルダーはこのファイルを書き込めません: ${name}`));
  }
  return normalized;
}

const DRAFT_IGNORE_DIRS = new Set(["__pycache__", "node_modules", ".pytest_cache", ".mypy_cache", "dist", "build"]);
const DRAFT_IGNORE_FILE_SUFFIXES = [".pyc", ".pyo"];

async function hasMinimumSkillSourceFiles(
  draftDir: string,
  files: string[],
  runtime: BuildSessionState["runtime"],
): Promise<boolean> {
  const normalized = new Set(files.map((file) => file.replaceAll("\\", "/")));
  if (!normalized.has("skill.yaml")) {
    return false;
  }
  try {
    const manifest = await loadSkillManifest(draftDir);
    return normalized.has(manifest.entry.replaceAll("\\", "/"));
  } catch {
    return runtime === "typescript" ? normalized.has("main.ts") : normalized.has("main.py");
  }
}

function stripBuilderArtifacts(text: string): string {
  return text
    .replace(/```summary\s*\n([\s\S]*?)\n```/g, "$1")
    .replace(/```builder-files[^\n]*\n[\s\S]*?\n```/gi, "")
    .replace(/```file:[^\n]*\n[\s\S]*?\n```/g, "")
    .trim();
}

async function listDraftFiles(draftDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name as string;
      if (name.startsWith(".")) continue;
      if (DRAFT_IGNORE_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const rp = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        await walk(full, rp);
      } else if (entry.isFile()) {
        if (DRAFT_IGNORE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
        out.push(rp);
      }
    }
  }
  await walk(draftDir, "");
  return out.sort();
}

async function snapshotMtimes(draftDir: string, files: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const file of files) {
    const t = await safeMtime(path.join(draftDir, file));
    if (t !== undefined) map.set(file, t);
  }
  return map;
}

async function detectWrittenFiles(
  draftDir: string,
  filesBefore: string[],
  beforeMtimes: Map<string, number>,
  filesAfter: string[],
): Promise<string[]> {
  const written: string[] = [];
  for (const file of filesAfter) {
    if (!filesBefore.includes(file)) {
      written.push(file);
      continue;
    }
    const previous = beforeMtimes.get(file);
    const current = await safeMtime(path.join(draftDir, file));
    if (previous !== undefined && current !== undefined && current > previous) {
      written.push(file);
    }
  }
  return written.sort();
}

async function safeMtime(file: string): Promise<number | undefined> {
  try {
    const info = await stat(file);
    return info.mtimeMs;
  } catch {
    return undefined;
  }
}

async function writeBuilderFiles(draftDir: string, files: Record<string, string>): Promise<string[]> {
  const written: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(draftDir, relative);
    const resolved = path.resolve(target);
    const root = path.resolve(draftDir);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(l(`Builder file escaped draft dir: ${relative}`, `ビルダーファイルが下書きディレクトリの外に出ました: ${relative}`));
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    written.push(relative);
  }
  return written.sort();
}

async function writeSessionIfMissing(file: string, state: BuildSessionState): Promise<void> {
  try {
    await stat(file);
  } catch {
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

async function readBuildState(session: BuildSession): Promise<BuildSessionState> {
  const raw = await readFile(session.session_path, "utf8");
  const parsed = JSON.parse(raw) as BuildSessionState;
  return {
    ...parsed,
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    runtime: parsed.runtime === "typescript" ? "typescript" : "python",
    status: parsed.status || "drafting",
    access_mode: parsed.access_mode === "approval" ? "approval" : "full",
  };
}

async function writeBuildState(session: BuildSession, state: BuildSessionState): Promise<void> {
  await writeFile(session.session_path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function appendBuildEvent(session: BuildSession, event: string, details: Record<string, unknown>): Promise<void> {
  await appendFile(
    path.join(session.logs_dir, "events.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), event, details })}\n`,
    "utf8",
  );
}

async function readFixturePayload(session: BuildSession): Promise<Record<string, unknown>> {
  const fixture = path.join(session.draft_dir, "fixtures", "input.json");
  const parsed = await readJsonIfExists(fixture);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  // Accept both flat args ({"text": ...}) and the wrapped form ({"args": {...}}).
  const obj = parsed as Record<string, unknown>;
  if (
    "args" in obj &&
    obj.args &&
    typeof obj.args === "object" &&
    !Array.isArray(obj.args) &&
    Object.keys(obj).length === 1
  ) {
    return obj.args as Record<string, unknown>;
  }
  return obj;
}

async function readJsonIfExists(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeBuilderResult(file: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeReview(
  file: string,
  input: {
    skillId: string;
    validation: ValidateSkillResult;
    dryRun?: unknown;
    payload: Record<string, unknown>;
    decision: "approved" | "pending";
    summary: string;
  },
): Promise<void> {
  const manifest = input.validation.manifest;
  const aiSteps = manifest?.ai_steps?.map((step) => step.id).join(", ") || "none";
  const outputs = manifest?.outputs?.map((output) => `${output.id}:${output.type}`).join(", ") || "none";
  const lines = [
    "# Registration Review",
    "",
    `- skill id: ${input.skillId}`,
    `- AI steps: ${aiSteps}`,
    `- allowed outputs: ${outputs}`,
    `- local test command: agent-sin build test ${input.skillId}`,
    `- validation errors: ${input.validation.errors.length}`,
    `- validation warnings: ${input.validation.warnings.length}`,
    `- registration decision: ${input.decision}`,
    "",
    "## Summary",
    "",
    input.summary,
    "",
    "## Test Payload",
    "",
    "```json",
    JSON.stringify(input.payload, null, 2),
    "```",
    "",
  ];
  if (input.validation.errors.length > 0) {
    lines.push("## Errors", "", ...input.validation.errors.map((error) => `- ${error}`), "");
  }
  if (input.validation.warnings.length > 0) {
    lines.push("## Warnings", "", ...input.validation.warnings.map((warning) => `- ${warning}`), "");
  }
  await writeFile(file, lines.join("\n"), "utf8");
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

async function writeTextIfMissing(file: string, text: string): Promise<void> {
  try {
    await stat(file);
  } catch {
    await writeFile(file, text, "utf8");
  }
}
