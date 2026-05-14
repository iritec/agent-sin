import type { AppConfig } from "../core/config.js";
import type { ChatTurn } from "../core/chat-engine.js";
import type { AiProgressHandler } from "../core/ai-provider.js";
import { classifyIntent, type IntentResult } from "../core/intent-router.js";
import { listSkillManifests, type SkillManifest } from "../core/skill-registry.js";
import {
  buildDraftWithAgent,
  prepareEditDraft,
  type BuilderHandoffTurn,
} from "./builder-session.js";
import { buildRegisterLines } from "./build-commands.js";
import { loadDotenv, upsertDotenv } from "../core/secrets.js";
import { createBuildSession } from "./builder-session.js";
import { findMissingRequiredEnv } from "../core/runtime.js";
import { loadSkillManifest } from "../core/skill-registry.js";
import {
  classifyBuildModeAction,
  classifyHandoffApproval,
} from "./build-action-classifier.js";
import { detectLocale, l, type Locale } from "../core/i18n.js";

export interface PendingHandoff {
  type: "create" | "edit";
  skill_id: string;
  original_text: string;
  reason: string;
}

export interface PendingBuildExit {
  reason: string;
}

export type BuilderEventSource = "discord" | "telegram" | "cli";

export interface BuildModeState {
  type: "create" | "edit";
  skill_id: string;
  skill_name?: string | null;
  context_seed: BuilderHandoffTurn[];
  context_consumed: boolean;
  original_text: string;
  event_source?: BuilderEventSource;
}

export interface IntentRuntime {
  pending: PendingHandoff | null;
  pending_exit: PendingBuildExit | null;
  preferred_skill_id: string | null;
  progress_detail: boolean;
  enabled: boolean;
  mode: "chat" | "build";
  build: BuildModeState | null;
}

export function createIntentRuntime(enabled = true): IntentRuntime {
  return {
    pending: null,
    pending_exit: null,
    preferred_skill_id: null,
    progress_detail: false,
    enabled,
    mode: "chat",
    build: null,
  };
}

const SLASH_EXIT_COMMANDS = new Set([
  "/back",
  "/chat",
  "/exit-build",
  "!back",
  "!chat",
  "!exit-build",
]);

const SLASH_REGISTER_COMMANDS = new Set(["/register", "!register"]);

const SLASH_TEST_COMMANDS = new Set(["/test", "!test"]);

function isSlashExitCommand(text: string): boolean {
  return SLASH_EXIT_COMMANDS.has(text.trim().toLowerCase());
}

function isSlashRegisterCommand(text: string): boolean {
  return SLASH_REGISTER_COMMANDS.has(text.trim().toLowerCase());
}

function isSlashTestCommand(text: string): boolean {
  return SLASH_TEST_COMMANDS.has(text.trim().toLowerCase());
}

export function parseEnvDirective(text: string): { name: string; value: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^env\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/i);
  if (!match) return null;
  return { name: match[1], value: match[2].trim() };
}

export function isReservedAgentSinEnv(name: string): boolean {
  return /^AGENT_SIN_/i.test(name);
}

export function looksLikeRawSecretValue(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.length < 16 || trimmed.length > 512) return false;
  if (!/^[A-Za-z0-9._\-:/+=~]+$/.test(trimmed)) return false;
  if (!/[0-9]/.test(trimmed) && !/[A-Z]/.test(trimmed)) return false;
  return true;
}

export function extractAutoSaveSecretValue(text: string, envName?: string): string | null {
  const candidates = collectAutoSaveSecretCandidates(text);
  const values = Array.from(
    new Set(
      candidates
        .map((candidate) => normalizeAutoSaveSecretCandidate(candidate, envName))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  return values.length === 1 ? values[0] : null;
}

function collectAutoSaveSecretCandidates(text: string): string[] {
  const candidates: string[] = [];
  const assignmentPattern = /\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*([A-Za-z0-9._\-:/+=~]{16,512})/g;
  for (const match of text.matchAll(assignmentPattern)) {
    candidates.push(match[0], match[1]);
  }
  const tokenPattern = /[A-Za-z0-9_][A-Za-z0-9._\-:/+=~]{15,511}/g;
  for (const match of text.matchAll(tokenPattern)) {
    candidates.push(match[0]);
  }
  return candidates;
}

function normalizeAutoSaveSecretCandidate(raw: string, envName?: string): string | null {
  let value = raw
    .trim()
    .replace(/^[`"'「『]+/g, "")
    .replace(/[`"'」』、。,.]+$/g, "");
  const inlineAssignment = value.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/);
  if (inlineAssignment) {
    value = inlineAssignment[1].trim();
  }
  if (/^https?:\/\//i.test(value) && !allowsUrlSecret(envName)) {
    return null;
  }
  return looksLikeRawSecretValue(value) ? value : null;
}

function allowsUrlSecret(envName: string | undefined): boolean {
  return Boolean(envName && /(?:URL|URI|ENDPOINT|WEBHOOK)/i.test(envName));
}

export async function tryAutoSaveBuildEnv(
  config: AppConfig,
  build: BuildModeState,
  text: string,
): Promise<string[] | null> {
  if (collectAutoSaveSecretCandidates(text).length === 0) return null;
  let manifest;
  try {
    const session = await createBuildSession(config, build.skill_id);
    manifest = await loadSkillManifest(session.draft_dir);
  } catch {
    return null;
  }
  await loadDotenv(config.workspace);
  const missing = findMissingRequiredEnv(manifest).filter(
    (entry) => !isReservedAgentSinEnv(entry.name),
  );
  if (missing.length !== 1) return null;
  const envName = missing[0].name;
  const value = extractAutoSaveSecretValue(text, envName);
  if (!value) return null;
  try {
    const result = await upsertDotenv(config.workspace, [{ key: envName, value }]);
    return [l(`Saved ${envName} to ${result.path}.`, `${envName} を ${result.path} に保存しました。`)];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [l(`Failed to save environment variable: ${message}`, `環境変数の保存に失敗: ${message}`)];
  }
}

export interface BuildHandoffApproval {
  decision: "approve" | "reject" | "discuss";
  carry_over_text?: string;
}

export async function classifyPendingHandoff(
  config: AppConfig,
  text: string,
  history: ChatTurn[],
  intentRuntime: IntentRuntime,
): Promise<BuildHandoffApproval> {
  const pending = intentRuntime.pending;
  if (!pending) {
    return { decision: "discuss" };
  }
  const result = await classifyHandoffApproval(config, text, history, pending);
  return { decision: result.decision, carry_over_text: result.carry_over_text };
}

async function renderEditModeFailureMessage(
  config: AppConfig,
  skillId: string,
  error: unknown,
): Promise<string> {
  const candidates = await findEditCandidates(config, skillId);
  if (candidates.length > 0) {
    const ids = candidates.map((skill) => skill.id).join(", ");
    return l(
      `Could not enter edit mode: "${skillId}" is not a registered skill id. Close matches: ${ids}. Tell me the exact id to edit.`,
      `編集モードに入れませんでした: "${skillId}" は登録済みスキルIDではありません。近い候補: ${ids}。直す対象を正確なIDで指定してください。`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return l(
    `Could not enter edit mode: ${message}`,
    `編集モードに入れませんでした: ${message}`,
  );
}

async function findEditCandidates(config: AppConfig, skillId: string): Promise<SkillManifest[]> {
  let skills: SkillManifest[];
  try {
    skills = await listSkillManifests(config.skills_dir);
  } catch {
    return [];
  }
  const normalized = skillId.trim().toLowerCase();
  if (!normalized) return [];
  const prefixMatches = skills.filter((skill) => skill.id.toLowerCase().startsWith(`${normalized}-`));
  if (prefixMatches.length > 0) {
    return prefixMatches.slice(0, 8);
  }
  const source = tokenizeText(normalized);
  const scored = skills
    .map((skill) => {
      const phrases = skill.invocation?.phrases?.join(" ") || "";
      const target = tokenizeText(`${skill.id} ${skill.name} ${skill.description || ""} ${phrases}`);
      return { skill, score: jaccard(source, target) };
    })
    .filter((item) => item.score >= 0.35)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  return scored.slice(0, 5).map((item) => item.skill);
}

function tokenizeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[　\s]+/g, "-")
      .split(/[^a-z0-9ぁ-んァ-ヶ一-龠]+/)
      .map((token) => stem(token))
      .filter((token) => token.length > 0),
  );
}

function stem(token: string): string {
  const suffixes = ["izer", "izing", "ization", "ize", "er", "ing", "ed", "es", "s"];
  for (const suffix of suffixes) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function renderBuildFooter(
  intentRuntime: IntentRuntime,
  options: { exitPrefix: "!" | "/"; languageHint?: string | string[] },
): string {
  if (intentRuntime.mode !== "build" || !intentRuntime.build) return "";
  const label = intentRuntime.build.skill_name?.trim() || intentRuntime.build.skill_id;
  const locale = inferFooterLocale(options.languageHint);
  if (options.exitPrefix === "!") {
    return chooseFooterText(
      locale,
      `(Currently in build mode for "${label}". Reply "back" to leave)`,
      `（現在：「${label}」のビルドモードです。抜けるには「戻る」と返事してください）`,
    );
  }
  return chooseFooterText(
    locale,
    `(Currently in build mode for "${label}". Reply /back to leave)`,
    `（現在：「${label}」のビルドモードです。抜けるには /back と返事してください）`,
  );
}

function chooseFooterText(locale: Locale, en: string, ja: string): string {
  return locale === "ja" ? ja : en;
}

function inferFooterLocale(languageHint: string | string[] | undefined): Locale {
  const text = Array.isArray(languageHint)
    ? languageHint.join("\n")
    : languageHint || "";
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) {
    return "ja";
  }
  if (/[A-Za-z]/.test(text)) {
    return "en";
  }
  return detectLocale();
}

async function resolveSkillDisplayName(
  config: AppConfig,
  skillId: string,
): Promise<string | null> {
  try {
    const skills = await listSkillManifests(config.skills_dir);
    const manifest = skills.find((item) => item.id === skillId);
    const name = manifest?.name?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether to append the build-mode footer to a reply.
 */
export function shouldShowBuildFooter(opts: {
  intentRuntime: IntentRuntime;
  userText: string;
  replyLines: string[];
  isBuildEntry?: boolean;
}): boolean {
  return opts.intentRuntime.mode === "build" && Boolean(opts.intentRuntime.build);
}

export interface BuildModeHandlerOptions {
  onProgress?: AiProgressHandler;
  /** Kept for compatibility; build mode now exits only through explicit local commands. */
  suggestExitOnOffTopic?: boolean;
  /** Recent chat history used to detect off-topic skill-run / chat messages. */
  history?: ChatTurn[];
}

export interface BuildAutoExitDecision {
  preferred_skill_id: string | null;
  reason: string;
}

async function detectBuildAutoExit(
  config: AppConfig,
  text: string,
  history: ChatTurn[] | undefined,
): Promise<BuildAutoExitDecision | null> {
  const skills = await listSkillManifests(config.skills_dir);
  if (skills.length === 0) return null;
  let result: IntentResult;
  try {
    result = await classifyIntent(config, text, skills, {
      history: (history || []).map((turn) => ({ role: turn.role, content: turn.content })),
    });
  } catch {
    return null;
  }
  // Only auto-exit when the user clearly wants to run an existing skill.
  // We intentionally do NOT auto-exit on plain "chat" intent because the
  // builder agent legitimately receives free-form requests that look like chat.
  if (result.confidence === "low") return null;
  if (result.intent === "skill_run" && result.matched_skill_id) {
    return { preferred_skill_id: result.matched_skill_id, reason: result.reason };
  }
  return null;
}

export async function enterBuildMode(
  config: AppConfig,
  history: ChatTurn[],
  intentRuntime: IntentRuntime,
  hooks: BuildModeHandlerOptions = {},
  extraText?: string,
  eventSource?: BuilderEventSource,
): Promise<string[]> {
  const pending = intentRuntime.pending;
  if (!pending) {
    return [l("There is no pending proposal.", "進行中の提案はありません。")];
  }
  intentRuntime.pending = null;
  intentRuntime.pending_exit = null;
  const seed: BuilderHandoffTurn[] = history.map((turn) => ({
    role: turn.role === "tool" ? "tool" : turn.role,
    content: turn.content,
  }));
  if (pending.type === "edit") {
    try {
      await prepareEditDraft(config, pending.skill_id);
    } catch (error) {
      return [await renderEditModeFailureMessage(config, pending.skill_id, error)];
    }
  }
  intentRuntime.mode = "build";
  intentRuntime.build = {
    type: pending.type,
    skill_id: pending.skill_id,
    skill_name: await resolveSkillDisplayName(config, pending.skill_id),
    context_seed: seed,
    context_consumed: false,
    original_text: pending.original_text,
    event_source: eventSource,
  };
  const initialText = extraText && extraText.trim().length > 0
    ? `${pending.original_text}\n\n[追加要件]\n${extraText.trim()}`
    : pending.original_text;
  return forwardToBuilder(config, intentRuntime.build, initialText, hooks);
}

export async function handleBuildModeMessage(
  config: AppConfig,
  text: string,
  intentRuntime: IntentRuntime,
  hooks: BuildModeHandlerOptions = {},
  eventSource?: BuilderEventSource,
): Promise<string[] | null> {
  const build = intentRuntime.build;
  if (!build) {
    intentRuntime.mode = "chat";
    intentRuntime.pending_exit = null;
    return null;
  }
  if (eventSource && build.event_source !== eventSource) {
    build.event_source = eventSource;
  }

  // Deterministic slash-command exit.
  if (isSlashExitCommand(text)) {
    intentRuntime.mode = "chat";
    intentRuntime.build = null;
    intentRuntime.pending_exit = null;
    return [l("Back to chat.", "◀︎ チャットに戻りました。")];
  }

  // Save env values silently if user voluntarily provides them.
  const envDirective = parseEnvDirective(text);
  if (envDirective) {
    if (isReservedAgentSinEnv(envDirective.name)) {
      return [
        l(
          `${envDirective.name} is an agent-sin runtime setting, so it was not saved as a skill environment variable.`,
          `${envDirective.name} は agent-sin 本体の設定です。スキル用の環境変数としては保存しませんでした。`,
        ),
      ];
    }
    try {
      const result = await upsertDotenv(config.workspace, [
        { key: envDirective.name, value: envDirective.value },
      ]);
      return [l(`Saved ${envDirective.name} to ${result.path}.`, `${envDirective.name} を ${result.path} に保存しました。`)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [l(`Failed to save environment variable: ${message}`, `環境変数の保存に失敗: ${message}`)];
    }
  }

  // User pasted a raw API key value — auto-save into the only missing required_env if any.
  const autoSaved = await tryAutoSaveBuildEnv(config, build, text);
  if (autoSaved) {
    return autoSaved;
  }

  // Deterministic slash-command shortcuts for register / test.
  if (isSlashRegisterCommand(text)) {
    return handleRegisterAction(config, build, intentRuntime);
  }
  if (isSlashTestCommand(text)) {
    return handleTestAction(build, intentRuntime);
  }

  // Classify the user's intent inside build mode (exit / register / test / continue).
  const action = await classifyBuildModeAction(config, text, hooks.history || [], build);
  if (action.action === "exit") {
    intentRuntime.mode = "chat";
    intentRuntime.build = null;
    intentRuntime.pending_exit = null;
    return [l("Back to chat.", "◀︎ チャットに戻りました。")];
  }
  if (action.action === "register") {
    return handleRegisterAction(config, build, intentRuntime);
  }
  if (action.action === "test") {
    return handleTestAction(build, intentRuntime);
  }

  // If the user's message looks like a routine chat / existing-skill request
  // (e.g. "メール調べて…"), quietly leave build mode so the normal chat engine
  // can run skills. Return null so the router falls through to chatRespond.
  const autoExit = await detectBuildAutoExit(config, text, hooks.history);
  if (autoExit) {
    intentRuntime.mode = "chat";
    intentRuntime.build = null;
    intentRuntime.pending_exit = null;
    intentRuntime.preferred_skill_id = autoExit.preferred_skill_id;
    return null;
  }

  return forwardToBuilder(config, build, text, hooks);
}

function handleTestAction(build: BuildModeState, intentRuntime: IntentRuntime): null {
  intentRuntime.mode = "chat";
  intentRuntime.preferred_skill_id = build.skill_id;
  intentRuntime.build = null;
  intentRuntime.pending_exit = null;
  return null;
}

async function handleRegisterAction(
  config: AppConfig,
  build: BuildModeState,
  intentRuntime: IntentRuntime,
): Promise<string[]> {
  try {
    const lines = await buildRegisterLines(config, build.skill_id, {
      overwrite: build.type === "edit",
    });
    intentRuntime.mode = "chat";
    intentRuntime.build = null;
    intentRuntime.pending_exit = null;
    return lines;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      l(`Could not use this skill yet: ${message}`, `登録できませんでした: ${message}`),
      l("After fixing it, ask to register/use it again.", "修正が終わりましたら、もう一度「登録して」とお伝えください。"),
    ];
  }
}

async function forwardToBuilder(
  config: AppConfig,
  build: BuildModeState,
  text: string,
  hooks: BuildModeHandlerOptions,
): Promise<string[]> {
  const seed = build.context_consumed ? [] : build.context_seed;
  build.context_consumed = true;
  try {
    const result = await buildDraftWithAgent(config, build.skill_id, text, {
      handoff: seed,
      onProgress: hooks.onProgress,
      accessMode: "full",
      eventSource: build.event_source,
    });
    const reply = result.summary?.trim();
    return reply ? [reply] : [l("(no response)", "（応答なし）")];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [l(`builder agent error: ${message}`, `builder agent エラー: ${message}`)];
  }
}
