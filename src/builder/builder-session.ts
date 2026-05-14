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
  // Always reflect the latest roles.builder from models.yaml: when no explicit
  // override is passed, prefer the current config value over any stale builder
  // id left in the session.
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
    "[Chat handoff context — conversation from the previous chat. Use it to extract requirements.]",
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

// Respect `candidate` only when the CLI explicitly passes `--builder` or
// similar. Normal calls arrive without a candidate, so config.builder_model_id
// (i.e. roles.builder from models.yaml) is always used.
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
  const previous = stripBuilderArtifacts(previousText) || previousText || "(no response)";
  return [
    ...buildBuilderMessages(session, state, runtimeContext, profileMemory),
    { role: "assistant", content: previous },
    {
      role: "user",
      content: [
        "Your previous reply did not create skill.yaml / main.* in the draft.",
        "Do not ask the user to rephrase. In this turn, write a minimal working implementation directly under cwd.",
        "Fill any unknowns with reasonable assumptions, and declare required_env if credentials are needed.",
        "After writing, return only a short user-facing report in the user's language.",
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
  const previous = stripBuilderArtifacts(previousText) || previousText || "(no response)";
  const errors = readiness.validation.errors.length > 0
    ? readiness.validation.errors.join("\n")
    : readiness.summary;
  return [
    ...buildBuilderMessages(session, state, runtimeContext, profileMemory),
    { role: "assistant", content: previous },
    {
      role: "user",
      content: [
        "The post-creation self-check still cannot run the skill.",
        "Do not ask the user to rephrase. In this turn, fix the implementation directly under cwd.",
        "If the only missing piece is credentials, declare them in required_env and still finish the implementation.",
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
  if (!trimmed || trimmed === "(no response)" || trimmed === "（応答なし）") {
    return l("I could not continue creating it. Please describe in one sentence what you want the skill to do.", "作成に進めませんでした。何をするスキルにしたいか、1文で教えてください。");
  }
  return l(`${trimmed}\n\nI need more detail to create it. Please describe in one sentence what you want the skill to do.`, `${trimmed}\n\n作成に必要な内容が足りません。何をするスキルにしたいか、1文で教えてください。`);
}

function sanitizeBuilderSummary(summary: string, _context: BuilderRuntimeContext): string {
  return summary
    .replace(/^.*(?:override|上書きコピー|workspace override|packaged builtin|packaged original|ビルトイン.*本体.*変更).*$\n?/gim, "")
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
    "# Discord-only extra spec (you may also add a slash command)",
    "- This session was opened from Discord. The chat-triggered `invocation.phrases` remains required as before. `invocation.discord_slash` is an *additional* shortcut, not a replacement.",
    "- Add `invocation.discord_slash` when the user explicitly asks for a slash command/button-style trigger, or when the skill is a simple action (todo add, memo add, delete, toggle, etc.) with 1-3 clearly-typed arguments. Generative / conversational / summarizing skills only need phrases.",
    "- Shape:\n```\ninvocation:\n  phrases: [...]              # required (keep)\n  discord_slash:                # optional (add)\n    description: Flip a coin\n    options:\n      - name: count\n        type: integer           # only string|integer|number|boolean\n        description: number of flips\n        required: false\n```",
    "- Rules: the command name is taken from skill.id (one skill = one command, flat options, no subcommands). `options[*].type` must be string/integer/number/boolean. `choices` must be `[{name, value}]` for string/integer/number only. `required` defaults to false. A Japanese description can be placed in `description_ja`.",
    "- Keep `input.schema` and `discord_slash.options` consistent. Use matching names/meanings (e.g. if the schema has `text`, the option should also be `name: text`).",
    "- Activation timing: when a skill that adds, changes, or removes `discord_slash` is registered, the Discord slash-command list will only update after the bot restarts (reconnects). Always mention this in the completion message (e.g. \"Restart the bot to use it as a slash command. The chat trigger (phrases) is available now.\"). A skill that only uses `phrases`, or an edit that does not touch `discord_slash`, does not require a restart.",
    "",
  ];
}

function formatBuilderRuntimeContext(context: BuilderRuntimeContext | undefined): string[] {
  if (!context) return [];
  const envKeys = context.dotenv_keys.length > 0 ? summarizeList(context.dotenv_keys, 80) : "(none)";
  const enabled = context.enabled_models.length > 0 ? summarizeList(context.enabled_models, 30) : "(none)";
  const disabled = context.disabled_models.length > 0 ? summarizeList(context.disabled_models, 30) : "(none)";
  return [
    "# Workspace",
    `- Working directory (cwd / writable): ${context.draft_dir}`,
    `- agent-sin source tree (read-only, for reference): ${context.install_root}`,
    `- agent-sin workspace: ${context.workspace_dir}`,
    `- Other skills (read-only, for reference): ${context.skills_dir}`,
    `- .env (update only the env vars this skill needs): ${context.dotenv_path}`,
    "",
    "# Areas you must not touch directly, and how to handle them",
    `- ${context.dotenv_path}: you may add/update only the keys declared in this skill's required_env, or skill-specific keys the user explicitly mentioned. Do not change unrelated keys. Never write agent-sin runtime settings (AGENT_SIN_*).`,
    `- ${context.skills_dir}/<other skill>: when another skill needs to be fixed, ask the user to say "fix XXX". The host will switch cwd to that skill and restart build mode.`,
    `- ${context.workspace_dir}/schedules.yaml: do not edit directly. If recurring execution is needed, instruct the user to call the schedule-add built-in skill.`,
    `- ${context.workspace_dir}/models.yaml / config.toml: do not touch. These are agent-sin runtime settings.`,
    `- ${context.install_root}: the agent-sin source. Read it for reference if useful, but never write to it.`,
    "",
    "# Existing settings (values hidden)",
    `- .env: ${context.dotenv_loaded ? "loaded" : "not created"} (${context.dotenv_path})`,
    `- .env keys: ${envKeys}`,
    `- Default model: ${context.default_chat_model}`,
    `- Enabled model ids: ${enabled}`,
    `- Disabled model ids: ${disabled}`,
    `- Registration: handled automatically. Do not ask the user to register the skill afterwards.`,
  ];
}

function summarizeList(values: string[], limit: number): string {
  const visible = values.slice(0, limit);
  const rest = values.length - visible.length;
  return rest > 0 ? `${visible.join(", ")} and ${rest} more` : visible.join(", ");
}

function buildBuilderMessages(
  session: BuildSession,
  state: BuildSessionState,
  runtimeContext?: BuilderRuntimeContext,
  profileMemory?: ProfileMemoryFiles,
): AiMessage[] {
  const profileLines = formatProfileMemoryPromptSection(profileMemory);
  const system = [
    "# Context",
    "- You are the skill-building module of the agent-sin AI agent.",
    "- Your job is to build a skill that runs on agent-sin from the user's request, and to leave it in a state where it can be used immediately after writing.",
    "- The user is not an engineer. Do not ask about function names, commands, or technical jargon. Take requirements in plain language.",
    "",
    "# How to proceed",
    "1. Read the user's requirements. Only when something truly cannot be built without clarification, ask at most three questions at a time. You may ask another batch of up to three if the answer is still insufficient. Iterate as many times as needed. Conversely, when you can decide on your own, go straight to implementation.",
    "2. Once requirements are clear, you *must* emit file blocks in the response body to write the files. The format is `\\`\\`\\`file:<relative-path>` to open, the raw file content, and `\\`\\`\\`` to close. Always emit both skill.yaml and main.py (main.ts if TypeScript). If needed, emit fixtures/input.json in the same format. Do not use language fences like `\\`\\`\\`yaml` / `\\`\\`\\`python`, and do not use plain labels like \"File:\" alone. If you write only a completion report and omit the file blocks, agent-sin writes nothing and the skill stays unfinished. Example:\n```file:skill.yaml\nid: example\nname: Example\ndescription: ...\nruntime: python\ninvocation:\n  phrases:\n    - run the example\noutput_mode: raw\n```\n```file:main.py\nasync def run(ctx, input):\n    return {\"status\": \"ok\", \"summary\": \"hello\"}\n```",
    "3. After writing the files, write a completion report. The report is a short 1-2 sentence note about \"what is now possible\". Do not add confirmation questions like \"Want to test it?\" or \"Should I run it?\". If the user replies with \"run it\" / \"try it\" / etc., the system automatically switches back to chat mode and runs the skill — you do not need to prompt for that.",
    "",
    "# Handling existing settings",
    "- Before building, consult the existing-settings list below and do not present already-configured keys as missing. Values are not visible to you; rely only on whether the key name exists.",
    "- For `ai_steps[].model`, default to the logical role names `chat` (lightweight) or `builder` (high quality). Only specify a real model id (e.g. `codex-low`) when a specific model is required. Never write a non-existent model name.",
    "- When the user says \"Discord notification\", they mean the agent-sin notification feature. Call `ctx.notify({ channel: \"discord\", ... })` from the skill. Do not create your own `DISCORD_WEBHOOK_URL` or POST to webhooks directly.",
    "- `AGENT_SIN_DISCORD_*` for Discord notifications is an agent-sin runtime setting. Do not put it in the skill's `required_env` or .env examples. Only if it is not yet configured, briefly tell the user that agent-sin's Discord notification setup is needed.",
    "- When the user says \"Telegram notification\", use `ctx.notify({ channel: \"telegram\", ... })` the same way. `AGENT_SIN_TELEGRAM_*` is also a runtime setting and must not appear in skill.yaml.",
    "",
    "# Hard rules",
    "- Never finish with only a completion report and no skill.yaml / main.*. Don't stop at requirement confirmation.",
    "- Even when credentials need to be acquired, write skill.yaml and main.* first. Declaring them in `required_env` simply blocks execution until values are present; the implementation can still be completed.",
    "- *Never touch agent-sin runtime settings* (`AGENT_SIN_CODEX_*` / `AGENT_SIN_DISCORD_*` / `AGENT_SIN_TELEGRAM_*` / `AGENT_SIN_NOTIFY_*` / `AGENT_SIN_SLACK_*` / `AGENT_SIN_SMTP_*` / `AGENT_SIN_MAIL_*` / `AGENT_SIN_FAKE_*` / `AGENT_SIN_DISABLE_*` etc.). Never include them in .env examples. These are agent-sin runtime knobs, not skill settings. Only the skill's own keys (e.g. `OPENAI_API_KEY`, `GMAIL_USER`) belong in `required_env`.",
    "- Keep the \"setup before use\" instructions to at most 4 steps. Do not paste long official documentation or suggest configuration values the user didn't ask about.",
    "- Files written by `outputs` (notes, reports, etc.) must be material the user reads back later or another skill reuses. Do not write transient run results or internal state to outputs. Return ephemeral data via the return value's `data`, or store it in `memory`.",
    "",
    "# User-facing response rules (most important)",
    "What the user wants to know is just \"what is now possible\" and \"what they need to do to use it\". Do not expose technical details.",
    "Respond in the user's language. If the user wrote in Japanese, reply in Japanese; if in English, reply in English. Keep it short.",
    "",
    "Always respond to the user in plain text. Do not use any Markdown styling (bold, headings, bullet markers, numbered lists, inline code, fenced code blocks, links, tables, etc.). Completion reports and setup instructions are written as plain sentences without decoration. For list-like content, use line breaks instead of bullet markers. The internal file: / summary fences used for file writes are not shown to the user, so those may be used as before.",
    "",
    "Do not include",
    "- The names of files you wrote (skill.yaml / main.py / fixtures/... etc.)",
    "- Internal terms like test count, validation, ready status, provider names",
    "- Internal storage details such as builtin, override copy, override flag",
    "- Run logs like \"Python syntax check OK\"",
    "- Implementation commentary like \"as a safe core\"",
    "",
    "Do include (completion-report template)",
    "1-2 sentences of \"what is now possible\" (e.g. \"Classifies unread Gmail and summarizes it at 3pm.\"). If there is setup the user must do, follow with a brief description. Do not add confirmation prompts like \"Want to test it?\" or \"Should I run it?\". When the user replies with \"run it\" / \"try it\", the system auto-switches back to chat mode and runs the skill, so you do not need to prompt.",
    "",
    "## When credentials are required (API key / OAuth / token / cookie / etc.)",
    "Skills that integrate with external services almost always need credentials. It is normal that the skill cannot run immediately after implementation, so always include the following:",
    "- Where to obtain them: a concrete 2-4 step procedure pointing to the official console.",
    "  Example for Gmail: \"In Google Cloud Console (https://console.cloud.google.com/) create a new project → enable the Gmail API → set up the OAuth consent screen → Credentials → create an OAuth client ID (desktop) → download the JSON\".",
    "- Where to save what: the key names and formats to write to `~/.agent-sin/.env`, one per line.",
    "  Example: `GMAIL_CREDENTIALS_PATH=~/credentials.json`, `OPENAI_API_KEY=sk-...`.",
    "- If the user pastes a value into chat and you can tell which `required_env` entry it belongs to, you may update `~/.agent-sin/.env` directly. After saving, just reply \"Saved.\" briefly. Only when you cannot tell, ask the user to send it as `env NAME=value`.",
    "- Do not push for \"test it\" until setup is finished. Instead write something like \"once you have obtained X and saved it to .env, let me know and I'll verify.\"",
    "",
    "# Skill authoring rules",
    "- skill.yaml requires `id` (kebab-case), `runtime` (python|typescript), `name`, `description`, and `invocation.phrases`. `invocation.phrases` is required for chat invocation; list 3-6 entries combining the skill name, aliases, and example utterances (e.g. for id `flip-coin`: `[\"flip a coin\", \"toss a coin\", \"heads or tails\", \"flip-coin\"]`). `entry` defaults to `main.py` / `main.ts` per runtime, and `handler` defaults to `run`; both can be omitted. `invocation.command`, `input.schema`, `outputs` (only when leaving notes/reports the user reads back), `memory` (only when keeping state), `ai_steps` (only when calling AI), and `required_env` are optional. Do not write empty `outputs: []` / `ai_steps: []` / `retry: max_attempts: 0`. `schema_version` / `type` / `security` / `triggers` are deprecated.",
    "- Handler signature: Python is `async def run(ctx, input)`, TS is `export async function run(ctx, input)`. `input` is a dict of `{args, trigger, sources, memory}`, and `input.args` is already validated against skill.yaml's `input.schema`.",
    "- Return value: `{status: 'ok'|'skipped'|'error', title, summary, outputs, data, suggestions}`.",
    "- The available ctx surface is: `log.info/warn/error`, `memory.get` (async) / `memory.set` (async), `ai.run(step_id, payload)`, `notify(args)`, and `now()`. Do not touch env or fs directly.",
    "- File output is done by returning `{content, frontmatter}` under `outputs[id]`. The Runtime saves it according to skill.yaml's `outputs[].path/filename` (you can use `{{yyyy}}/{{MM}}/{{dd}}/{{date}}/{{datetime}}`; `append: true` appends). The skill itself must not open/write files. `outputs[].type` is either `markdown` or `json`.",
    "- To call AI, first declare it in skill.yaml's `ai_steps` with `id / purpose / model` (optionally `optional: true`), then call `ctx.ai.run(id, payload)`. Ids that were not declared cannot be called.",
    "- Environment variables must be declared in skill.yaml's `required_env: [{name, description, optional}]`. The Runtime checks them before execution and blocks the run if any are missing.",
    "- For simple CRUD-style skills (add todo, list todos, mark done, etc.) where the result should be shown to the user verbatim, add `output_mode: raw` to skill.yaml. The summary then bypasses the LLM reformatting turn and is shown directly. Omit it when complex summarization/rewording is needed (the default behaviour lets the LLM format the result).",
    "- Do not write recurring schedules into skill.yaml (the builder must not touch schedules.yaml). Instead, tell the user that the finished skill can be scheduled by calling the `schedule-add` built-in skill from chat or CLI (`agent-sin run schedule-add --payload '{\"id\":\"...\",\"cron\":\"min hour dom month dow\",\"skill\":\"<this-skill>\"}'`). If the user prefers to edit manually, mention that they may add `- id / cron / skill / args / approve` to the `schedules:` list in `~/.agent-sin/schedules.yaml`.",
    "- Writable paths are only inside cwd: `skill.yaml` / `main.py` or `main.ts` / `README.md` / `fixtures/` / `tests` / `prompts/`. As an exception, you may add or update only the keys this skill needs in `~/.agent-sin/.env`. Do not write anywhere else outside cwd.",
    "- Reading is unrestricted: feel free to read from the agent-sin source or other skills. A useful reference implementation is `~/.agent-sin/skills/memo-save/`.",
    "- If you feel an urge to edit cross-cutting files (schedules.yaml, other skills, models.yaml, config.toml, etc.), do not touch them yourself. Add a one-line request in the completion report (\"please do XYZ\") and let the host handle it.",
    "",
    ...formatDiscordSlashGuidance(runtimeContext),
    ...formatBuilderRuntimeContext(runtimeContext),
    ...(profileLines.length > 0 ? ["", "# Long-term profile", ...profileLines] : []),
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
