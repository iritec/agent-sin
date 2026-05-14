#!/usr/bin/env node
import path from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  findAgentSinServiceProcesses,
  getServiceProvider,
  isSchedulerCommandLine,
  isSchedulerProcessRunning,
  serviceLabel,
} from "../core/service.js";
import {
  configPath,
  defaultWorkspace,
  ensureDailyMemoIndexSchedule,
  ensureWorkspaceDirs,
  loadConfig,
  loadModels,
  modelsPath,
  setRoleModel,
  setupWorkspace,
  SetupRequiredError,
  writeModelsYaml,
  detectAvailableProviders,
  deriveSetupChoiceId,
  deriveSetupChoicePairIds,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
  type SetupModelChoice,
  type AppConfig,
  type ModelConfig,
  type ModelRole,
  type SetupWorkspaceOptions,
} from "../core/config.js";
import { migrateLegacyBuiltinCopies } from "../core/builtin-skills.js";
import { setSkillEnabled } from "../core/skill-settings.js";
import {
  exportWorkspace,
  formatBytes,
  importWorkspace,
  listArchiveEntries,
  pathExists,
} from "../core/transfer.js";
import {
  appendEventLog,
  dailyConversationMemoryFile,
  listRunLogs,
  readEventLog,
  readRunLog,
  type EventLogSource,
} from "../core/logger.js";
import { runSkill } from "../core/runtime.js";
import { listSkillManifests, type SkillManifest } from "../core/skill-registry.js";
import type { BuilderAccessMode } from "../builder/builder-session.js";
import {
  buildChatLines,
  buildLines,
  buildListLines,
  buildStatusLines,
  buildTestLines,
} from "../builder/build-commands.js";
import {
  classifyPendingHandoff,
  enterBuildMode,
  handleBuildModeMessage,
  renderBuildFooter,
  type BuildModeHandlerOptions,
  type IntentRuntime,
} from "../builder/build-flow.js";
import { scaffoldSkill, validateInstalledSkill, type SkillRuntimeChoice } from "../core/skill-scaffold.js";
import { ensureDotenvSkeleton, getApiKeyResolution, loadDotenv, maskKey, readDotenvKeys, upsertDotenv } from "../core/secrets.js";
import { loadSchedules, matchesCron, nextRunAfter, type ScheduleEntry } from "../core/scheduler.js";
import {
  appendProfileMemory,
  ensureProfileMemoryFiles,
  parseProfileMemoryTarget,
  profileMemoryPath,
  readProfileMemoryFiles,
  type ProfileMemoryTarget,
} from "../core/profile-memory.js";
import {
  maybePromoteDailyMemory,
  promoteDailyMemory,
  type DailyMemoryPromotionResult,
} from "../core/daily-memory-promotion.js";
import { notify } from "../core/notifier.js";
import { consumeUpdateBanner, scheduleUpdateCheck } from "../core/update-notifier.js";
import { shutdownSharedCodexAppServer } from "../runtimes/codex-app-server.js";
import { runDiscordBot } from "../discord/bot.js";
import {
  extractTelegramIdentityCandidates,
  runTelegramBot,
  type TelegramIdentityCandidate,
  type TelegramUpdate,
} from "../telegram/bot.js";
import { Spinner } from "./spinner.js";
import {
  formatModelRow,
  modelSummary,
  modelsLines,
  skillsLines,
} from "../core/info-lines.js";
import { inferLocaleFromText, l, lLines, t, withLocale } from "../core/i18n.js";
import { agentSinVersion, agentSinVersionFresh } from "../core/version.js";
import {
  appendHistory,
  chatRespond,
  makeSpinnerProgress,
  type ChatBuildSuggestion,
  type ChatTurn,
} from "../core/chat-engine.js";

type OptionValue = string | boolean | Array<string | boolean>;
type Options = Record<string, OptionValue> & { _: string[] };


async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(agentSinVersion());
    return 0;
  }

  try {
    const dotenv = await loadDotenv();
    if (dotenv.permission_warning) {
      console.error(`[agent-sin] ${l("warning", "警告")}: ${dotenv.permission_warning}`);
    }
    if (shouldAutoSetup(command)) {
      await ensureWorkspaceInitialized();
    }
    switch (command) {
      case "setup":
        return await cmdSetup(args);
      case undefined:
        return await cmdChat(args);
      case "start":
        return await cmdStart(args);
      case "chat":
        return await cmdChat(args);
      case "skills":
        return await cmdSkills(args);
      case "run":
        return await cmdRun(args);
      case "build":
        return await cmdBuild(args);
      case "models":
        return await cmdModels(args);
      case "model":
        return await cmdModel(args);
      case "logs":
        return await cmdLogs(args);
      case "config":
        return await cmdConfig();
      case "skill":
        return await cmdSkill(args);
      case "profile":
        return await cmdProfile(args);
      case "daemon":
        return await cmdDaemon(args);
      case "gateway":
        return await cmdGateway(args);
      case "service":
        return await cmdService(args);
      case "schedules":
        return await cmdSchedules(args);
      case "notify":
        return await cmdNotify(args);
      case "discord":
        return await cmdDiscord(args);
      case "telegram":
        return await cmdTelegram(args);
      case "export":
        return await cmdExport(args);
      case "import":
        return await cmdImport(args);
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      default:
        console.error(l(`Unknown command: ${command}`, `不明なコマンドです: ${command}`));
        printHelp();
        return 1;
    }
  } catch (error) {
    if (error instanceof SetupRequiredError) {
      console.error(error.message);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    await tryLogCliError(command, args, message);
    return 1;
  }
}

function shouldAutoSetup(command: string | undefined): boolean {
  switch (command) {
    case "setup":
    case "help":
    case "--help":
    case "-h":
    case "notify":
    case "export":
    case "import":
      return false;
    default:
      return true;
  }
}

async function ensureWorkspaceInitialized(): Promise<void> {
  const file = configPath();
  try {
    await stat(file);
    const config = await loadConfig();
    await ensureWorkspaceDirs(config);
    await migrateLegacyBuiltinCopies(config.skills_dir);
    await ensureProfileMemoryFiles(config);
    await ensureDailyMemoIndexSchedule(config);
    return;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  console.log(l("agent-sin: first run. Creating workspace...", "agent-sin: 初回起動です。ワークスペースを作成します…"));
  const config = await setupWorkspace({});
  console.log(`Workspace: ${config.workspace}`);
  console.log(l(`Default model: ${config.chat_model_id}`, `既定モデル: ${config.chat_model_id}`));
  console.log("");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function tryLogCliError(command: string | undefined, args: string[], message: string): Promise<void> {
  try {
    const config = await loadConfig();
    await appendEventLog(config, {
      level: "error",
      source: "cli",
      event: "command_failed",
      message,
      details: { command: command || "<none>", args },
    });
  } catch {
    // Logging must not mask the original error.
  }
}

async function cmdStart(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.daemon || options.gateway) {
    return cmdGateway(args.filter((arg) => arg !== "--daemon" && arg !== "--gateway"));
  }
  if (options.service) {
    return cmdService(["start"]);
  }
  if (options.install_service) {
    return cmdService(["install"]);
  }
  if (options.status) {
    return cmdService(["status"]);
  }
  return cmdChat(args);
}

async function cmdSetup(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    printSetupHelp();
    return 0;
  }

  let setupOptions: SetupWorkspaceOptions;
  try {
    setupOptions = shouldPromptSetup(options)
      ? await promptSetupOptions(optionsToSetupOptions(options))
      : optionsToSetupOptions(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("");
    console.error(l(`x setup was interrupted: ${message}`, `✗ setup を中断しました: ${message}`));
    console.error(l("  Run `agent-sin setup` again to retry.", "  入力をやり直す場合はもう一度 `agent-sin setup` を実行してください。"));
    return 1;
  }
  const config = await setupWorkspace(setupOptions);
  await applyCodexCliOptions(config, options);
  console.log(l(`Workspace ready: ${config.workspace}`, `ワークスペース準備完了: ${config.workspace}`));
  console.log(`Config: ${configPath(config.workspace)}`);
  console.log(`Notes: ${config.notes_dir}`);
  console.log(`Skills: ${config.skills_dir}`);
  console.log(l(`Default model: ${config.chat_model_id}`, `既定モデル: ${config.chat_model_id}`));
  console.log(l(`Builder: ${config.builder_model_id}`, `ビルダー: ${config.builder_model_id}`));
  console.log(l("Next: agent-sin start", "次: agent-sin start"));
  return 0;
}

// CLI 引数 (--chat-codex-model など) で渡された値だけを反映する。
// 対話的な追加プロンプトは promptSetupOptions が担当するので、ここでは聞かない。
async function applyCodexCliOptions(config: AppConfig, options: Options): Promise<void> {
  const mChat = stringOption(options["chat-codex-model"]) || stringOption(options["codex-model"]);
  const eChat = stringOption(options["chat-effort"]) || stringOption(options["codex-effort"]);
  const mBuilder = stringOption(options["builder-codex-model"]);
  const eBuilder = stringOption(options["builder-effort"]) || stringOption(options["codex-builder-effort"]);

  const updates: Array<{ entry: string; model?: string; effort?: string }> = [];
  if (mChat || eChat) {
    updates.push({ entry: config.chat_model_id, model: mChat, effort: eChat });
  }
  if (mBuilder || eBuilder) {
    updates.push({ entry: config.builder_model_id, model: mBuilder, effort: eBuilder });
  }
  if (updates.length === 0) return;

  const written = await applyModelEntryUpdates(config, updates);
  if (written.length > 0) {
    console.log("");
    console.log(l("Updated models.yaml:", "models.yaml を更新しました:"));
    for (const line of written) {
      console.log(`  ${line}`);
    }
  }
}

async function applyModelEntryUpdates(
  config: AppConfig,
  updates: Array<{ entry: string; model?: string; effort?: string }>,
): Promise<string[]> {
  const models = await loadModels(config.workspace);
  const lines: string[] = [];
  for (const update of updates) {
    const entry = models.models[update.entry];
    if (!entry) continue;
    const fields: string[] = [];
    if (update.model) {
      entry.model = update.model;
      fields.push(`model=${update.model}`);
    }
    if (update.effort) {
      entry.effort = update.effort;
      fields.push(`effort=${update.effort}`);
    }
    if (fields.length > 0) {
      lines.push(`${update.entry}: ${fields.join(", ")}`);
    }
  }
  if (lines.length > 0) {
    await writeModelsYaml(modelsPath(config.workspace), models);
  }
  return lines;
}

async function cmdSkills(args: string[] = []): Promise<number> {
  const sub = args[0];
  if (sub === "restore") {
    return cmdSkillsRestore();
  }
  if (sub === "enable" || sub === "disable") {
    return cmdSkillsToggle(sub, args.slice(1));
  }
  if (sub && sub !== "list") {
    console.error(l(`Unknown subcommand: skills ${sub}`, `不明なサブコマンドです: skills ${sub}`));
    console.error(l("Usage: agent-sin skills [list|enable <id>|disable <id>|restore]", "使い方: agent-sin skills [list|enable <id>|disable <id>|restore]"));
    return 1;
  }
  const config = await loadConfig();
  const lines = await skillsLines(config);
  for (const line of lines) {
    console.log(line);
  }
  return 0;
}

async function cmdSkillsToggle(action: "enable" | "disable", rest: string[]): Promise<number> {
  const id = rest[0];
  if (!id) {
    console.error(l(`Usage: agent-sin skills ${action} <skill-id>`, `使い方: agent-sin skills ${action} <skill-id>`));
    return 1;
  }
  const config = await loadConfig();
  const skills = await listSkillManifests(config.skills_dir);
  const skill = skills.find((entry) => entry.id === id);
  if (!skill) {
    console.error(l(`Skill not found: ${id}`, `スキルが見つかりません: ${id}`));
    return 1;
  }
  const enabled = action === "enable";
  const { changed } = await setSkillEnabled(config.workspace, id, enabled);
  if (!changed) {
    console.log(
      enabled
        ? l(`${id} is already enabled.`, `${id} は既に有効です。`)
        : l(`${id} is already disabled.`, `${id} は既に無効です。`),
    );
    return 0;
  }
  console.log(enabled ? l(`Enabled ${id}.`, `${id} を有効化しました。`) : l(`Disabled ${id}.`, `${id} を無効化しました。`));
  return 0;
}

async function cmdSkillsRestore(): Promise<number> {
  const config = await loadConfig();
  const report = await migrateLegacyBuiltinCopies(config.skills_dir);
  if (
    report.deleted.length === 0 &&
    report.archived.length === 0 &&
    report.retained.length === 0
  ) {
    console.log(l("No workspace copies of core skills were found. Already in sync.", "コアスキルの workspace 内コピーは見つかりませんでした。整合済みです。"));
    return 0;
  }
  if (report.deleted.length > 0) {
    console.log(l(`Resynced and deleted: ${report.deleted.join(", ")}`, `再同期 (削除) しました: ${report.deleted.join(", ")}`));
  }
  if (report.archived.length > 0) {
    console.log(l("Archived changed copies:", "差分があったため退避しました:"));
    for (const entry of report.archived) {
      console.log(`  - ${entry.id} → ${entry.archivePath}`);
    }
  }
  if (report.retained.length > 0) {
    console.log(l(`Kept because override: true: ${report.retained.join(", ")}`, `override: true で保持中: ${report.retained.join(", ")}`));
  }
  return 0;
}

async function cmdRun(args: string[]): Promise<number> {
  const [skillId, ...rest] = args;
  if (!skillId) {
    console.error(l("Usage: agent-sin run <skill-id> [--key value]", "使い方: agent-sin run <skill-id> [--key value]"));
    return 1;
  }

  const options = parseOptions(rest);
  const payload = options.payload ? parseJsonOption(options.payload, "--payload") : optionsToArgs(options);
  const approved = Boolean(options.approve);
  delete payload.approve;
  if (options._.length > 0) {
    const positional = options._.join(" ");
    if (skillId === "memo-search" && !("query" in payload)) {
      payload.query = positional;
    } else if (
      ["todo-done", "todo-delete"].includes(skillId) &&
      !("id" in payload)
    ) {
      payload.id = positional;
    } else if (!("text" in payload)) {
      payload.text = positional;
    }
  }

  const config = await loadConfig();
  const response = await runSkill(config, skillId, payload, { approved });
  console.log(response.result.title);
  if (response.result.summary) {
    console.log(response.result.summary);
  }
  for (const saved of response.saved_outputs.filter((item) => item.show_saved !== false)) {
    console.log(l(`saved: ${saved.path}`, `保存: ${saved.path}`));
  }
  if (response.memory_path) {
    console.log(l(`memory: ${response.memory_path}`, `記憶: ${response.memory_path}`));
  }
  if (response.attempts > 1) {
    console.log(l(`attempts: ${response.attempts}`, `試行回数: ${response.attempts}`));
  }
  console.log(`run: ${response.run_id}`);
  return response.result.status === "error" ? 1 : 0;
}

async function cmdChat(args: string[]): Promise<number> {
  const config = await loadConfig();
  scheduleUpdateCheck(config.workspace);
  const history: ChatTurn[] = [];
  if (args.length > 0) {
    const lines = await handleChatMessage(config, args.join(" "), history);
    const banner = await consumeUpdateBanner(config.workspace, { force: true });
    if (banner) {
      console.log(banner);
    }
    for (const line of lines) {
      console.log(line);
    }
    return 0;
  }
  // For the interactive session, always hit the registry on startup. Render the
  // banner *after* the ascii banner so it stays visible on small terminals.
  const startupUpdateBanner = await consumeUpdateBanner(config.workspace, { force: true });
  await warnIfSchedulesNeedService(config);
  const intentRuntime: IntentRuntime = {
    pending: null,
    pending_exit: null,
    preferred_skill_id: null,
    progress_detail: false,
    enabled: true,
    mode: "chat",
    build: null,
  };

  const state: ChatState = {
    config,
    models: await loadModels(config.workspace),
    skills: await listSkillManifests(config.skills_dir),
  };
  const rl = createInterface({
    input,
    output,
    completer: (line: string) => completeChatLine(line, state),
  });
  if (uiActive()) {
    for (const line of renderStartupBanner(state)) {
      console.log(line);
    }
  } else {
    console.log(l("agent-sin chat. /help / /reset / /exit  (Tab completion)", "agent-sin chat. /help / /reset / /exit  (Tabで補完)"));
    console.log(l("mode: chat  |  build/edit mode is suggested automatically when useful", "mode: chat  |  必要に応じてビルド/編集モードに自動で切替提案します"));
  }
  if (startupUpdateBanner) {
    console.log("");
    console.log(uiActive() ? formatChatLine(startupUpdateBanner) : startupUpdateBanner);
  }
  while (true) {
    let raw: string;
    const frameTop = renderInputFrameTop();
    if (frameTop) {
      console.log(frameTop);
    }
    try {
      raw = await rl.question(renderInputPromptPrefix(intentRuntime, state.config.chat_model_id));
    } catch {
      rl.close();
      return 0;
    }
    const frameBottom = renderInputFrameBottom();
    if (frameBottom) {
      console.log(frameBottom);
      const status = renderStatusLine(state, intentRuntime);
      if (status) {
        console.log(status);
      }
      console.log("");
    }
    const text = raw.trim();
    if (["exit", "quit", "/exit", "/quit"].includes(text)) {
      rl.close();
      return 0;
    }
    if (text === "/model" || text === "/model chat" || text === "/model builder") {
      const presetRole = text === "/model chat" ? "chat" : text === "/model builder" ? "builder" : undefined;
      await refreshChatState(state);
      const lines = await interactiveModelPicker(state, rl, presetRole);
      for (const line of lines) {
        console.log(formatChatLine(line));
      }
      continue;
    }
    if (text === "/skills" || text === "skills" || text === "/skills --all" || text === "skills --all") {
      await refreshChatState(state);
      const showAll = text.endsWith("--all");
      const lines = await interactiveSkillsPicker(state, rl, { showAll });
      for (const line of lines) {
        console.log(formatChatLine(line));
      }
      continue;
    }
    const lines = await handleChatMessage(state.config, text, history, intentRuntime);
    scheduleUpdateCheck(state.config.workspace);
    const banner = await consumeUpdateBanner(state.config.workspace);
    if (banner) {
      console.log(formatChatLine(banner));
    }
    for (const line of lines) {
      console.log(formatChatLine(line));
    }
    // モデル変更系のスキル (model-add / model-set) が呼ばれた場合に
    // 次ターンへ反映できるよう、毎ターン state を再読込する。Discord / Telegram も
    // 同じパターン (refreshStateConfig)。
    await refreshChatState(state);
  }
}

interface ChatState {
  config: AppConfig;
  models: ModelConfig;
  skills: SkillManifest[];
}

async function refreshChatState(state: ChatState): Promise<void> {
  state.config = await loadConfig();
  state.models = await loadModels(state.config.workspace);
  state.skills = await listSkillManifests(state.config.skills_dir);
}

const SLASH_COMMANDS = [
  "/skills",
  "/run",
  "/models",
  "/model",
  "/build",
  "/logs",
  "/config",
  "/profile",
  "/reset",
  "/help",
  "/exit",
];

function completeChatLine(line: string, state: ChatState): [string[], string] {
  const skillIds = state.skills.map((skill) => skill.id);
  const modelIds = Object.keys(state.models.models);

  if (line.startsWith("/run ")) {
    const partial = line.slice(5);
    const hits = skillIds.filter((id) => id.startsWith(partial));
    return [hits.map((id) => `/run ${id}`), line];
  }
  if (line.startsWith("/model chat ") || line.startsWith("/model builder ")) {
    const role = line.startsWith("/model chat ") ? "chat" : "builder";
    const partial = line.slice(`/model ${role} `.length);
    const hits = modelIds.filter((id) => id.startsWith(partial));
    return [hits.map((id) => `/model ${role} ${id}`), line];
  }
  if (line.startsWith("/model set ")) {
    const partial = line.slice(11);
    const hits = modelIds.filter((id) => id.startsWith(partial));
    return [hits.map((id) => `/model set ${id}`), line];
  }
  if (line.startsWith("/model ")) {
    const partial = line.slice(7);
    const candidates = ["chat", "builder", "set", ...modelIds];
    const hits = candidates.filter((id) => id.startsWith(partial));
    return [hits.map((id) => `/model ${id}`), line];
  }
  if (line.startsWith("/build ")) {
    const partial = line.slice(7);
    const candidates = ["list", "chat", "test", "status", ...skillIds];
    const hits = candidates.filter((id) => id.startsWith(partial));
    return [hits.map((id) => `/build ${id}`), line];
  }
  if (line.startsWith("/")) {
    const hits = SLASH_COMMANDS.filter((command) => command.startsWith(line));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  }
  return [[], line];
}

async function interactiveModelPicker(
  state: ChatState,
  rl: ReturnType<typeof createInterface>,
  presetRole?: ModelRole,
): Promise<string[]> {
  const chatId = state.config.chat_model_id;
  const builderId = state.config.builder_model_id;
  const chatEntry = state.models.models[chatId];
  const builderEntry = state.models.models[builderId];

  let role = presetRole;
  if (!role) {
    console.log(l("Which role do you want to change?", "どちらを変更しますか?"));
    console.log(l(`  1) chat     current: ${chatEntry ? modelSummary(chatId, chatEntry) : chatId}`, `  1) chat     現在: ${chatEntry ? modelSummary(chatId, chatEntry) : chatId}`));
    console.log(l(`  2) builder  current: ${builderEntry ? modelSummary(builderId, builderEntry) : builderId}`, `  2) builder  現在: ${builderEntry ? modelSummary(builderId, builderEntry) : builderId}`));
    const answer = (await rl.question(l("Enter a number (Enter to cancel): ", "番号を入力 (Enterでキャンセル): "))).trim();
    if (!answer) {
      return [l("No changes made.", "変更しませんでした。")];
    }
    if (answer === "1" || answer.toLowerCase() === "chat") {
      role = "chat";
    } else if (answer === "2" || answer.toLowerCase() === "builder") {
      role = "builder";
    } else {
      return [l("Invalid selection.", "無効な選択です。")];
    }
  }

  const entries = Object.entries(state.models.models);
  console.log(l(`Available models (set for ${role}):`, `利用可能モデル (${role} に設定):`));
  entries.forEach(([id, model], index) => {
    const formatted = formatModelRow(id, model, chatId, builderId);
    console.log(`  ${String(index + 1).padStart(2)}) ${formatted}`);
  });
  const pick = (await rl.question(l("Enter a number (Enter to keep current): ", "番号を入力 (Enterで変更しない): "))).trim();
  if (!pick) {
    return [l("No changes made.", "変更しませんでした。")];
  }
  const num = Number.parseInt(pick, 10);
  if (!Number.isInteger(num) || num < 1 || num > entries.length) {
    return [l("Invalid selection.", "無効な選択です。")];
  }
  const [newId] = entries[num - 1];
  try {
    await setRoleModel(role, newId);
    await refreshChatState(state);
    return [l(`Default ${role} model: ${newId}`, `既定の ${role} モデル: ${newId}`)];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function summarizeBuiltinPrefixes(skills: SkillManifest[]): string {
  const prefixes = new Set<string>();
  for (const skill of skills) {
    const dash = skill.id.indexOf("-");
    prefixes.add(dash > 0 ? skill.id.slice(0, dash) : skill.id);
  }
  return Array.from(prefixes).sort().join(" / ");
}

async function interactiveSkillsPicker(
  state: ChatState,
  rl: ReturnType<typeof createInterface>,
  options: { showAll?: boolean } = {},
): Promise<string[]> {
  if (state.skills.length === 0) {
    return [l("No skills registered.", "登録済みのスキルはありません。")];
  }
  const showAll = options.showAll === true;
  const userSkills = state.skills.filter((skill) => skill.source !== "builtin");
  const builtinSkills = state.skills.filter((skill) => skill.source === "builtin");
  const visible = showAll ? state.skills : userSkills;

  console.log(l("Registered skills:", "登録済みスキル:"));
  if (visible.length === 0) {
    console.log(l("  (no user-created skills yet)", "  (ユーザースキルはまだありません)"));
  } else {
    visible.forEach((skill, index) => {
      const enabled = skill.enabled === false ? l("disabled", "無効") : l("enabled", "有効");
      const builtin = skill.source === "builtin" ? " [builtin]" : "";
      console.log(`  ${String(index + 1).padStart(2)}) ${skill.id}${builtin}\t${skill.name}\t${enabled}`);
    });
  }
  if (!showAll && builtinSkills.length > 0) {
    const groups = summarizeBuiltinPrefixes(builtinSkills);
    console.log("");
    console.log(l(
      `Builtins (${builtinSkills.length}): ${groups}  —  /skills --all to expand`,
      `ビルトイン (${builtinSkills.length} 個): ${groups}  ─  /skills --all で展開`,
    ));
  }
  const pick = (await rl.question(l("Enter a number (Enter to go back): ", "番号を入力 (Enterで戻る): "))).trim();
  if (!pick) {
    return [];
  }
  const num = Number.parseInt(pick, 10);
  if (!Number.isInteger(num) || num < 1 || num > visible.length) {
    return [l("Invalid selection.", "無効な選択です。")];
  }
  const skill = visible[num - 1];
  const isBuiltin = skill.source === "builtin";
  console.log("");
  console.log(`■ ${skill.id} (${skill.name})${isBuiltin ? " [builtin]" : ""}`);
  console.log(`  runtime: ${skill.runtime} / ${skill.enabled === false ? l("disabled", "無効") : l("enabled", "有効")}`);
  if (skill.description) {
    console.log(`  ${skill.description}`);
  }
  console.log(`  dir: ${skill.dir}`);
  console.log("");
  if (isBuiltin) {
    console.log(l("i Builtin skills are loaded from the package and cannot be deleted here.", "ℹ ビルトインスキルはパッケージから読み込まれるため、ここから削除はできません。"));
    return [];
  }
  const action = (await rl.question(l("[d] delete / [Enter] back: ", "[d] 削除 / [Enter] 戻る: "))).trim().toLowerCase();
  if (action !== "d" && action !== "delete") {
    return [];
  }
  const confirm = (await rl.question(l(`Delete "${skill.id}"? [y/N]: `, `本当に "${skill.id}" を削除しますか? [y/N]: `))).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    return [l("Deletion canceled.", "削除をキャンセルしました。")];
  }
  try {
    await rm(skill.dir, { recursive: true, force: true });
    await refreshChatState(state);
    return [l(`Deleted skill: ${skill.id}`, `スキルを削除しました: ${skill.id}`)];
  } catch (error) {
    return [l(`Delete failed: ${error instanceof Error ? error.message : String(error)}`, `削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`)];
  }
}

async function cmdBuild(args: string[]): Promise<number> {
  const config = await loadConfig();
  if (args[0] === "list") {
    const lines = await buildListLines(config);
    for (const line of lines) {
      console.log(line);
    }
    return 0;
  }
  if (args[0] === "register") {
    console.error(
      l(
        "agent-sin build register is deprecated. Builder writes directly to ~/.agent-sin/skills/<id>/, so there is no registration step.",
        "agent-sin build register は廃止されました。Builder が ~/.agent-sin/skills/<id>/ に直接書き込むので、登録ステップはありません。",
      ),
    );
    return 1;
  }
  if (args[0] === "test") {
    const [skillId, ...rest] = args.slice(1);
    if (!skillId) {
      console.error(l("Usage: agent-sin build test <skill-id> [--payload '{...}']", "使い方: agent-sin build test <skill-id> [--payload '{...}']"));
      return 1;
    }
    const options = parseOptions(rest);
    const lines = await buildTestLines(config, skillId, buildPayloadFromOptions(options));
    for (const line of lines) {
      console.log(line);
    }
    // ✅ marks the success path in the new conversational format.
    return lines.some((line) => line.startsWith("✅") || line.includes("登録できます")) ? 0 : 1;
  }
  if (args[0] === "chat") {
    const [skillId, ...messageParts] = args.slice(1);
    if (!skillId || messageParts.length === 0) {
      console.error(l('Usage: agent-sin build chat <skill-id> "message"', '使い方: agent-sin build chat <skill-id> "メッセージ"'));
      return 1;
    }
    const message = messageParts.join(" ");
    const lines = await withCliBuildHooks(config, message, (hooks) =>
      buildChatLines(config, skillId, message, { onProgress: hooks.onProgress }),
    );
    for (const line of lines) {
      console.log(line);
    }
    return 0;
  }
  if (args[0] === "status") {
    const skillId = args[1];
    if (!skillId) {
      console.error(l("Usage: agent-sin build status <skill-id>", "使い方: agent-sin build status <skill-id>"));
      return 1;
    }
    const lines = await buildStatusLines(config, skillId);
    for (const line of lines) {
      console.log(line);
    }
    return 0;
  }

  const options = parseOptions(args);
  const [skillId, ...messageParts] = options._;
  const prompt = stringOption(options.prompt) || messageParts.join(" ");
  const runtime = stringOption(options.runtime);
  const builder = stringOption(options.builder);
  const accessRaw = stringOption(options["access-mode"]);
  const accessMode: BuilderAccessMode | undefined =
    accessRaw === "full" ? "full" : accessRaw === "approval" ? "approval" : undefined;
  const lines = await withCliBuildHooks(config, prompt || skillId || "build", (hooks) =>
    buildLines(config, skillId, {
      prompt,
      runtime: runtime === "typescript" ? "typescript" : runtime === "python" ? "python" : undefined,
      builder,
      accessMode,
      onProgress: hooks.onProgress,
    }),
  );
  for (const line of lines) {
    console.log(line);
  }
  return 0;
}


async function cmdSkill(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "new":
      return cmdSkillNew(rest);
    case "validate":
      return cmdSkillValidate(rest);
    case "test":
      return cmdSkillTest(rest);
    default:
      console.error(
        l(
          "Usage:\n" +
            "  agent-sin skill new <id> [--runtime python|typescript] [--name ...] [--description ...]\n" +
            "  agent-sin skill validate <id>\n" +
            "  agent-sin skill test <id> [--payload '{...}'] [--key value]",
          "使い方:\n" +
            "  agent-sin skill new <id> [--runtime python|typescript] [--name ...] [--description ...]\n" +
            "  agent-sin skill validate <id>\n" +
            "  agent-sin skill test <id> [--payload '{...}'] [--key value]",
        ),
      );
      return 1;
  }
}

async function cmdSkillNew(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const id = String(options._[0] || "").trim();
  if (!id) {
    console.error(l("Usage: agent-sin skill new <id> [--runtime python|typescript] [--name ...] [--description ...]", "使い方: agent-sin skill new <id> [--runtime python|typescript] [--name ...] [--description ...]"));
    return 1;
  }
  const runtimeRaw = stringOption(options.runtime) || "python";
  if (runtimeRaw !== "python" && runtimeRaw !== "typescript") {
    console.error(l(`Invalid runtime: ${runtimeRaw} (allowed: python, typescript)`, `runtime が不正です: ${runtimeRaw} (使用可: python, typescript)`));
    return 1;
  }
  const config = await loadConfig();
  const result = await scaffoldSkill(config, {
    id,
    runtime: runtimeRaw as SkillRuntimeChoice,
    name: stringOption(options.name),
    description: stringOption(options.description),
  });
  console.log(l(`Created skill: ${result.skill_id}`, `スキルを作成しました: ${result.skill_id}`));
  console.log(l(`Path: ${result.skill_dir}`, `パス: ${result.skill_dir}`));
  for (const file of result.files) {
    console.log(`  + ${file}`);
  }
  console.log(l("Next:", "次:"));
  console.log(`  ${process.env.EDITOR || "$EDITOR"} ${result.entry_path}`);
  console.log(`  agent-sin skill validate ${result.skill_id}`);
  console.log(`  agent-sin skill test ${result.skill_id} --payload '{"text":"hello"}'`);
  await appendEventLog(config, {
    level: "info",
    source: "build",
    event: "skill_scaffolded",
    message: `Created ${result.skill_id} (${result.runtime})`,
    details: { skill_id: result.skill_id, runtime: result.runtime, files: result.files.length },
  });
  return 0;
}

async function cmdSkillValidate(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const id = String(options._[0] || "").trim();
  if (!id) {
    console.error(l("Usage: agent-sin skill validate <id>", "使い方: agent-sin skill validate <id>"));
    return 1;
  }
  const config = await loadConfig();
  const result = await validateInstalledSkill(config, id);
  for (const error of result.errors) {
    console.log(`[error] ${error}`);
  }
  for (const warning of result.warnings) {
    console.log(`[warn]  ${warning}`);
  }
  if (result.ok && result.manifest) {
    const manifest = result.manifest;
    console.log(
      `[ok] ${manifest.id} (${manifest.runtime})`,
    );
    console.log(`     dir:     ${result.skill_dir}`);
    console.log(`     entry:   ${path.join(result.skill_dir, manifest.entry)}`);
    console.log(`     outputs: ${manifest.outputs.length}`);
    if (manifest.ai_steps && manifest.ai_steps.length > 0) {
      console.log(`     ai:      ${manifest.ai_steps.map((step) => step.id).join(", ")}`);
    }
    if (manifest.memory) {
      console.log(
        `     memory:  ${manifest.memory.namespace} (read=${manifest.memory.read ?? false}, write=${manifest.memory.write ?? false})`,
      );
    }
  }
  await appendEventLog(config, {
    level: result.ok ? "info" : "error",
    source: "build",
    event: "skill_validated",
    message: result.ok ? `valid ${id}` : `invalid ${id} (${result.errors.length} error(s))`,
    details: {
      skill_id: id,
      ok: result.ok,
      errors: result.errors.length,
      warnings: result.warnings.length,
    },
  });
  return result.ok ? 0 : 1;
}

async function cmdSkillTest(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const id = String(options._[0] || "").trim();
  if (!id) {
    console.error(l("Usage: agent-sin skill test <id> [--payload '{...}'] [--key value]", "使い方: agent-sin skill test <id> [--payload '{...}'] [--key value]"));
    return 1;
  }

  const payload = buildPayloadFromOptions(options) || {};
  const positional = options._.slice(1);
  if (positional.length > 0 && !("text" in payload)) {
    payload.text = positional.join(" ");
  }

  const config = await loadConfig();
  const response = await runSkill(config, id, payload, { dryRun: true });
  console.log(`[dry-run] ${response.result.status} ${response.result.title}`);
  if (response.result.summary) {
    console.log(`          ${response.result.summary}`);
  }
  if (response.result.outputs && Object.keys(response.result.outputs).length > 0) {
    console.log(l("          would save outputs:", "          保存予定の出力:"));
    for (const [outputId, output] of Object.entries(response.result.outputs)) {
      const preview = JSON.stringify(output).slice(0, 200);
      console.log(`            ${outputId}: ${preview}${preview.length >= 200 ? "..." : ""}`);
    }
  }
  if (response.result.data && Object.keys(response.result.data).length > 0) {
    console.log(`          data: ${JSON.stringify(response.result.data)}`);
  }
  if (response.result.suggestions && response.result.suggestions.length > 0) {
    for (const suggestion of response.result.suggestions) {
      console.log(l(`          suggest: ${suggestion}`, `          提案: ${suggestion}`));
    }
  }
  console.log(l(`run: ${response.run_id} (no files saved, no memory updates)`, `run: ${response.run_id} (ファイル保存なし、記憶更新なし)`));
  return response.result.status === "error" ? 1 : 0;
}

async function cmdProfile(args: string[]): Promise<number> {
  const config = await loadConfig();
  const lines = await profileLines(config, args);
  for (const line of lines) {
    console.log(line);
  }
  return 0;
}

async function profileLines(config: AppConfig, args: string[]): Promise<string[]> {
  const [sub = "show", ...rest] = args;
  if (sub === "init") {
    const files = await ensureProfileMemoryFiles(config);
    return [
      l("profile memory ready", "プロフィール記憶を準備しました"),
      `soul: ${files.paths.soul}`,
      `user: ${files.paths.user}`,
      `memory: ${files.paths.memory}`,
      `daily: ${dailyConversationMemoryFile(config)}`,
    ];
  }
  if (sub === "path" || sub === "paths") {
    return [
      `soul: ${profileMemoryPath(config, "soul")}`,
      `user: ${profileMemoryPath(config, "user")}`,
      `memory: ${profileMemoryPath(config, "memory")}`,
      `daily: ${dailyConversationMemoryFile(config)}`,
    ];
  }
  if (sub === "append") {
    const target = parseProfileMemoryTarget(rest[0]);
    const text = rest.slice(1).join(" ").trim();
    if (!target || !text) {
      return [l("Usage: agent-sin profile append <soul|user|memory> <text>", "使い方: agent-sin profile append <soul|user|memory> <text>")];
    }
    const file = await appendProfileMemory(config, target, text);
    return [l(`saved: ${file}`, `保存: ${file}`)];
  }
  if (sub === "promote") {
    const options = parseOptions(rest);
    const result = await promoteDailyMemory(config, {
      date: stringOption(options.date) || stringOption(options._[0]),
      force: Boolean(options.force),
      dryRun: Boolean(options.dry_run),
      modelId: stringOption(options.model),
      eventSource: "cli",
    });
    return formatPromotionLines(result, Boolean(options.dry_run));
  }
  if (sub === "show") {
    const target = parseProfileMemoryTarget(rest[0]);
    return showProfileLines(config, target);
  }
  const target = parseProfileMemoryTarget(sub);
  if (target) {
    return showProfileLines(config, target);
  }
  return [
    l("Usage:", "使い方:"),
    "  agent-sin profile show [soul|user|memory]",
    "  agent-sin profile append <soul|user|memory> <text>",
    "  agent-sin profile promote [--date YYYY-MM-DD] [--force] [--dry-run]",
    "  agent-sin profile path",
  ];
}

function formatPromotionLines(result: DailyMemoryPromotionResult, dryRun = false): string[] {
  const prefix = dryRun ? "[dry-run] " : "";
  if (result.status === "promoted") {
    return [
      l(`${prefix}promoted: ${result.date} → memory.md (${result.items.length} item(s))`, `${prefix}昇格: ${result.date} → memory.md (${result.items.length}件)`),
      ...result.items.map((item) => `- ${item}`),
    ];
  }
  if (result.status === "reviewed") {
    return [l(`${prefix}reviewed: ${result.date} (no long-term memory items)`, `${prefix}確認済み: ${result.date} (長期記憶項目なし)`)];
  }
  if (result.status === "skipped") {
    return [l(`skipped: ${result.date} already reviewed`, `スキップ: ${result.date} は確認済みです`)];
  }
  return [`${result.status}: ${result.message || result.date}`];
}

async function showProfileLines(config: AppConfig, target?: ProfileMemoryTarget): Promise<string[]> {
  const files = await readProfileMemoryFiles(config);
  const lines: string[] = [];
  const targets: ProfileMemoryTarget[] = target ? [target] : ["soul", "user", "memory"];
  for (const item of targets) {
    lines.push(`${item}: ${files.paths[item]}`);
    lines.push(files[item].trim() || l("(empty)", "(空)"));
  }
  return lines;
}

function buildPayloadFromOptions(options: Options): Record<string, unknown> | undefined {
  let payload: Record<string, unknown> = {};
  const payloadOption = stringOption(options.payload);
  if (payloadOption) {
    payload = parseJsonOption(payloadOption, "--payload");
  }
  const reservedKeys = new Set(["_", "payload"]);
  for (const [key, value] of Object.entries(options)) {
    if (reservedKeys.has(key)) {
      continue;
    }
    if (value === true) {
      payload[key] = true;
    } else if (typeof value === "string" || typeof value === "number") {
      payload[key] = value;
    }
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

async function cmdModels(args: string[] = []): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "keys") {
    return cmdModelsKeys(rest);
  }
  const config = await loadConfig();
  const lines = await modelsLines(config);
  for (const line of lines) {
    console.log(line);
  }
  return 0;
}

async function cmdModelsKeys(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const filter = stringOption(options.provider);
  const targets: Array<{ id: string; provider: string; fallbacks: string[] }> = [
    { id: "openai", provider: "openai", fallbacks: [] },
    { id: "gemini", provider: "gemini", fallbacks: ["google"] },
    { id: "anthropic", provider: "anthropic", fallbacks: [] },
  ];
  const list = filter ? targets.filter((target) => target.id === filter) : targets;
  if (list.length === 0) {
    console.error(l(`Unknown provider: ${filter}`, `不明なプロバイダです: ${filter}`));
    return 1;
  }
  let missing = 0;
  for (const target of list) {
    const resolution = getApiKeyResolution(target.provider, target.fallbacks);
    if (resolution.keys.length === 0) {
      console.log(`${target.id.padEnd(10)} ${l("not set", "未設定")}`);
      missing += 1;
      continue;
    }
    const sources = new Set(resolution.sources.map((source) => source.envVar));
    console.log(
      `${target.id.padEnd(10)} ${l(`${resolution.keys.length} key(s)`, `${resolution.keys.length}個のキー`)}  via ${[...sources].join(", ")}`,
    );
    for (const [index, key] of resolution.keys.entries()) {
      console.log(`           ${index + 1}) ${maskKey(key)}`);
    }
  }
  if (options.check) {
    return missing > 0 ? 1 : 0;
  }
  return 0;
}

async function cmdModel(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "set" || rest.length === 0) {
    console.error(l("Usage: agent-sin model set <model-id>", "使い方: agent-sin model set <model-id>"));
    console.error("       agent-sin model set chat <model-id>");
    console.error("       agent-sin model set builder <model-id>");
    return 1;
  }
  let role: ModelRole = "chat";
  let modelId: string;
  if (rest[0] === "chat" || rest[0] === "builder") {
    role = rest[0];
    modelId = rest[1] || "";
  } else {
    modelId = rest[0];
  }
  if (!modelId) {
    console.error(l(`Usage: agent-sin model set ${role} <model-id>`, `使い方: agent-sin model set ${role} <model-id>`));
    return 1;
  }
  const lines = await modelSetLines(role, modelId);
  for (const line of lines) {
    console.log(line);
  }
  return 0;
}

async function modelSetLines(role: ModelRole, modelId: string): Promise<string[]> {
  const config = await setRoleModel(role, modelId);
  const current = role === "chat" ? config.chat_model_id : config.builder_model_id;
  return [l(`Default ${role} model: ${current}`, `既定の ${role} モデル: ${current}`)];
}

async function cmdLogs(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const config = await loadConfig();
  const lines = await logsLines(config, options);
  for (const line of lines) {
    console.log(line);
  }
  return 0;
}

async function logsLines(config: AppConfig, options: Options): Promise<string[]> {
  if (typeof options.run === "string") {
    const record = await readRunLog(config, options.run);
    return [JSON.stringify(record, null, 2)];
  }
  if (options.events) {
    const tail = parsePositiveIntOption(options.tail, 50);
    const source = typeof options.source === "string" ? (options.source as EventLogSource) : undefined;
    const level = typeof options.level === "string" ? (options.level as "info" | "warn" | "error") : undefined;
    const entries = await readEventLog(config, { tail, source, level });
    if (entries.length === 0) {
      return [l("No events.", "イベントはありません。")];
    }
    return entries.map((entry) => {
      const detail = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
      const msg = entry.message ? ` ${entry.message}` : "";
      return `${entry.ts}\t${entry.level}\t${entry.source}\t${entry.event}${msg}${detail}`;
    });
  }
  const skill = typeof options.skill === "string" ? options.skill : undefined;
  const records = await listRunLogs(config, skill);
  if (records.length === 0) {
    return [l("No run logs.", "実行ログはありません。")];
  }
  return records
    .slice(0, 20)
    .map((record) => `${record.finished_at}\t${record.status}\t${record.skill_id}\t${record.run_id}`);
}

function parsePositiveIntOption(value: OptionValue | undefined, fallback: number): number {
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return fallback;
}

async function cmdConfig(): Promise<number> {
  const config = await loadConfig();
  const lines = configLines(config);
  for (const line of lines) {
    console.log(line);
  }
  return 0;
}

function configLines(config: AppConfig): string[] {
  return [
    `workspace: ${config.workspace}`,
    `config: ${configPath(config.workspace)}`,
    `notes_dir: ${config.notes_dir}`,
    `skills_dir: ${config.skills_dir}`,
    `memory_dir: ${config.memory_dir}`,
    `index_dir: ${config.index_dir}`,
    `logs_dir: ${config.logs_dir}`,
    `chat_model: ${config.chat_model_id}`,
    `builder: ${config.builder_model_id}`,
  ];
}

async function handleChatMessage(
  config: AppConfig,
  text: string,
  history: ChatTurn[],
  intentRuntime?: IntentRuntime,
): Promise<string[]> {
  return withLocale(inferLocaleFromText(text), () =>
    handleChatMessageLocalized(config, text, history, intentRuntime),
  );
}

async function handleChatMessageLocalized(
  config: AppConfig,
  text: string,
  history: ChatTurn[],
  intentRuntime?: IntentRuntime,
): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    return [l("Please enter a message.", "入力してください。")];
  }
  if (["help", "/help"].includes(trimmed)) {
    return chatHelpLines();
  }
  if (trimmed === "/reset") {
    history.length = 0;
    if (intentRuntime) {
      intentRuntime.pending = null;
    }
    return [t("chat.history_reset")];
  }
  if (intentRuntime?.mode === "build") {
    const buildLines = await withCliBuildHooks(config, trimmed, (hooks) =>
      handleBuildModeMessage(config, trimmed, intentRuntime, { ...hooks, suggestExitOnOffTopic: true }),
    );
    if (buildLines !== null) {
      return appendCliBuildFooter(intentRuntime, buildLines, trimmed);
    }
    // Auto-exited to chat: fall through and process this message as a chat reply.
  }
  if (intentRuntime?.pending && !trimmed.startsWith("/")) {
    const approval = await classifyPendingHandoff(config, trimmed, history, intentRuntime);
    if (approval.decision === "approve") {
      appendHistory(history, { role: "user", content: trimmed });
      const lines = await withCliBuildHooks(config, trimmed, (hooks) =>
        enterBuildMode(config, history, intentRuntime, hooks, approval.carry_over_text),
      );
      return appendCliBuildFooter(intentRuntime, lines, trimmed);
    }
    if (approval.decision === "reject") {
      intentRuntime.pending = null;
      return [l("OK. Staying in chat mode.", "了解。チャットモードのままにします。")];
    }
    // "discuss" → keep pending, fall through to chatRespond.
  }
  if (trimmed === "skills" || trimmed === "/skills") {
    return skillsLines(config);
  }
  if (trimmed === "/models") {
    return modelsLines(config);
  }
  if (trimmed === "/config") {
    return configLines(config);
  }
  if (trimmed === "/profile" || trimmed.startsWith("/profile ")) {
    const rest = trimmed === "/profile" ? ["show"] : trimmed.split(/\s+/).slice(1);
    return profileLines(config, rest);
  }
  if (trimmed === "/logs" || trimmed.startsWith("/logs ")) {
    const rest = trimmed === "/logs" ? [] : trimmed.split(/\s+/).slice(1);
    return logsLines(config, parseOptions(rest));
  }
  if (trimmed.startsWith("/model ")) {
    const parts = trimmed.split(/\s+/).slice(1);
    let role: ModelRole = "chat";
    let modelId: string | undefined;
    if (parts[0] === "set") {
      parts.shift();
    }
    if (parts[0] === "chat" || parts[0] === "builder") {
      role = parts[0];
      modelId = parts[1];
    } else {
      modelId = parts[0];
    }
    if (!modelId) {
      return [l("Usage: /model [chat|builder] <model-id>", "使い方: /model [chat|builder] <model-id>")];
    }
    return modelSetLines(role, modelId);
  }
  if (trimmed === "/build" || trimmed.startsWith("/build ")) {
    const rest = trimmed === "/build" ? [] : trimmed.split(/\s+/).slice(1);
    if (rest[0] === "list") {
      return buildListLines(config);
    }
    if (rest[0] === "register") {
      return [
        l(
          "/build register is deprecated. Builder writes directly to skills/<id>/, so there is no registration step.",
          "/build register は廃止されました。Builder が skills/<id>/ に直接書き込むので、登録ステップはありません。",
        ),
      ];
    }
    if (rest[0] === "test") {
      return buildChatTestCommand(config, rest);
    }
    if (rest[0] === "chat") {
      return buildChatDraftCommand(config, rest);
    }
    if (rest[0] === "status") {
      return buildChatStatusCommand(config, rest);
    }
    const [skillId, ...messageParts] = rest;
    return withCliBuildHooks(config, messageParts.join(" "), (hooks) =>
      buildLines(config, skillId, { prompt: messageParts.join(" "), onProgress: hooks.onProgress }),
    );
  }
  if (trimmed.startsWith("/run ")) {
    const [, skillId, ...rest] = trimmed.split(/\s+/);
    const text = rest.join(" ");
    const payload = chatRunPayload(skillId, text);
    const response = await runSkill(config, skillId, payload);
    return [response.result.title, response.result.summary].filter(Boolean);
  }

  const preferredSkillId = intentRuntime?.preferred_skill_id || undefined;
  if (intentRuntime) {
    intentRuntime.preferred_skill_id = null;
  }
  const chatLines = await chatWithModel(config, trimmed, history, preferredSkillId, intentRuntime);
  return chatLines;
}

function appendCliBuildFooter(intentRuntime: IntentRuntime, lines: string[], userText = ""): string[] {
  const footer = renderBuildFooter(intentRuntime, {
    exitPrefix: "/",
    languageHint: [userText, ...lines],
  });
  if (!footer) return lines;
  if (lines.some((line) => line.trim() === footer)) return lines;
  return [...lines, "", footer];
}

function setPendingBuildSuggestion(
  intentRuntime: IntentRuntime | undefined,
  suggestion: ChatBuildSuggestion,
  userText: string,
): void {
  if (!intentRuntime || intentRuntime.mode !== "chat") return;
  intentRuntime.pending = {
    type: suggestion.type,
    skill_id: suggestion.skill_id,
    original_text: userText,
    reason: suggestion.reason || "chat build suggestion",
  };
  intentRuntime.pending_exit = null;
}

const BRAND_GREEN_ANSI = "38;2;24;160;104";

function renderPromptLabel(modelId: string, intentRuntime: IntentRuntime): string {
  const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (codes: string, text: string): string =>
    useColor ? `\x1b[${codes}m${text}\x1b[0m` : text;
  if (intentRuntime.mode === "build" && intentRuntime.build) {
    const isEdit = intentRuntime.build.type === "edit";
    const modeTag = isEdit ? "edit" : "build";
    const modeColor = isEdit ? "1;33" : "1;36";
    return `${paint(modeColor, `[${modeTag}:${intentRuntime.build.skill_id}]`)}`;
  }
  return `${paint(BRAND_GREEN_ANSI, "[chat]")} ${modelId}`;
}

// ---------- Claude Code-style TUI helpers ----------

interface UiContext {
  color: boolean;
  ascii: boolean;
  width: number;
}

function uiContext(): UiContext {
  const tty = Boolean(process.stdout.isTTY);
  const ascii =
    process.env.AGENT_SIN_ASCII === "1" ||
    process.env.TERM === "dumb" ||
    !!process.env.AGENT_SIN_PLAIN_UI;
  const cols = process.stdout.columns;
  return {
    color: tty && !process.env.NO_COLOR,
    ascii,
    width: Math.max(40, Math.min(typeof cols === "number" && cols > 0 ? cols : 80, 80)),
  };
}

function uiActive(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.AGENT_SIN_PLAIN_UI !== "1";
}

function paintCode(codes: string, text: string, ctx?: UiContext): string {
  const c = ctx ?? uiContext();
  return c.color ? `\x1b[${codes}m${text}\x1b[0m` : text;
}

interface BoxGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

function boxChars(ctx: UiContext): BoxGlyphs {
  if (ctx.ascii) {
    return { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  }
  return { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
}

type GlyphName = "spark" | "bullet" | "arrow" | "check" | "cross" | "prompt" | "dot";

function glyph(name: GlyphName, ctx: UiContext): string {
  if (ctx.ascii) {
    const map: Record<GlyphName, string> = {
      spark: "*",
      bullet: "*",
      arrow: "->",
      check: "v",
      cross: "x",
      prompt: ">",
      dot: "·",
    };
    return map[name];
  }
  const map: Record<GlyphName, string> = {
    spark: "✻",
    bullet: "●",
    arrow: "→",
    check: "✓",
    cross: "✕",
    prompt: "›",
    dot: "·",
  };
  return map[name];
}

const SMALL_BLOCK_FONT: Record<string, string[]> = {
  A: ["▄▀▄", "█▀█", "▀ ▀"],
  G: ["█▀▀", "█ ▄", "▀▀▀"],
  E: ["█▀▀", "█▀▀", "▀▀▀"],
  N: ["█▄ █", "█ ██", "▀  ▀"],
  T: ["▀█▀", " █ ", " ▀ "],
  "-": ["   ", "───", "   "],
  S: ["▄▀▀", "▀▀▄", "▄▄▀"],
  I: ["█", "█", "▀"],
};

function smallBlockTitle(text: string): string[] {
  const rows: string[] = ["", "", ""];
  const chars = text.toUpperCase().split("");
  chars.forEach((ch, idx) => {
    const figure = SMALL_BLOCK_FONT[ch];
    if (!figure) {
      return;
    }
    for (let i = 0; i < 3; i++) {
      rows[i] += figure[i];
      if (idx < chars.length - 1) {
        rows[i] += " ";
      }
    }
  });
  return rows;
}

function renderStartupBanner(state: ChatState): string[] {
  if (!uiActive()) {
    return [];
  }
  const ctx = uiContext();
  const dim = (text: string) => paintCode("90", text, ctx);
  const bold = (text: string) => paintCode("1", text, ctx);
  const accent = (text: string) => paintCode(BRAND_GREEN_ANSI, text, ctx);
  const dot = dim(glyph("dot", ctx));

  const modelDisplay = resolveDisplayModel(state);

  if (ctx.ascii) {
    return [
      "",
      `  ${bold("agent-sin")}  ${dim("v" + AGENT_SIN_VERSION)}  ${dot}  ${dim("model:")} ${modelDisplay}`,
      `  ${dim("/help · /reset · /exit")}`,
      "",
    ];
  }

  const indent = "  ";
  const title = smallBlockTitle("AGENT-SIN").map((line) => `${indent}${accent(line)}`);
  return [
    "",
    ...title,
    "",
    `${indent}${bold("agent-sin")}  ${dim("v" + AGENT_SIN_VERSION)}  ${dot}  ${dim("model:")} ${modelDisplay}`,
    `${indent}${dim("/help · /reset · /exit")}`,
    "",
  ];
}

function resolveDisplayModel(state: ChatState, intentRuntime?: IntentRuntime): string {
  const inBuild = intentRuntime?.mode === "build" && intentRuntime.build;
  const entryId = inBuild ? state.config.builder_model_id : state.config.chat_model_id;
  const entry = state.models?.models?.[entryId];
  return entry?.model || entryId;
}

function renderInputFrameTop(): string {
  if (!uiActive()) {
    return "";
  }
  const ctx = uiContext();
  const b = boxChars(ctx);
  return paintCode("90", `${b.tl}${b.h.repeat(ctx.width - 2)}${b.tr}`, ctx);
}

function renderInputFrameBottom(): string {
  if (!uiActive()) {
    return "";
  }
  const ctx = uiContext();
  const b = boxChars(ctx);
  return paintCode("90", `${b.bl}${b.h.repeat(ctx.width - 2)}${b.br}`, ctx);
}

function renderInputPromptPrefix(intentRuntime: IntentRuntime, modelId: string): string {
  if (!uiActive()) {
    return `${renderPromptLabel(modelId, intentRuntime)} > `;
  }
  const ctx = uiContext();
  const b = boxChars(ctx);
  const sym = glyph("prompt", ctx);
  const promptColor =
    intentRuntime.mode === "build" && intentRuntime.build
      ? intentRuntime.build.type === "edit"
        ? "1;33"
        : "1;36"
      : BRAND_GREEN_ANSI;
  return `${paintCode("90", b.v, ctx)} ${paintCode(promptColor, sym, ctx)} `;
}

function renderStatusLine(state: ChatState, intentRuntime: IntentRuntime): string {
  if (!uiActive()) {
    return "";
  }
  const ctx = uiContext();
  const dim = (text: string) => paintCode("90", text, ctx);
  const dot = dim(glyph("dot", ctx));
  const accentColor =
    intentRuntime.mode === "build" && intentRuntime.build
      ? intentRuntime.build.type === "edit"
        ? "33"
        : "36"
      : BRAND_GREEN_ANSI;
  const accent = (text: string) => paintCode(accentColor, text, ctx);
  const modeLabel =
    intentRuntime.mode === "build" && intentRuntime.build
      ? `${intentRuntime.build.type}:${intentRuntime.build.skill_id}`
      : "chat";
  return `  ${dim("mode:")} ${accent(modeLabel)}  ${dot}  ${dim("model:")} ${resolveDisplayModel(state, intentRuntime)}`;
}

function formatChatLine(line: string): string {
  if (!uiActive() || !line) {
    return line;
  }
  const ctx = uiContext();
  // Tool announce lines start with `→ `, leave them but add color.
  if (line.startsWith("→ ")) {
    return paintCode(BRAND_GREEN_ANSI, line, ctx);
  }
  if (line.startsWith("saved: ")) {
    return `  ${paintCode(BRAND_GREEN_ANSI, glyph("check", ctx), ctx)} ${paintCode("90", line, ctx)}`;
  }
  if (line.startsWith("[skill error:") || line.startsWith("[skill not allowed:")) {
    return `  ${paintCode("31", glyph("cross", ctx), ctx)} ${paintCode("31", line, ctx)}`;
  }
  return line;
}

function formatAssistantNarrative(text: string): string {
  if (!uiActive() || !text) {
    return text;
  }
  const ctx = uiContext();
  const bullet = paintCode(BRAND_GREEN_ANSI, glyph("bullet", ctx), ctx);
  const lines = text.split("\n");
  return lines
    .map((line, idx) => (idx === 0 ? `${bullet} ${line}` : `  ${line}`))
    .join("\n");
}

const AGENT_SIN_VERSION = agentSinVersion();

type CliBuildHooks = BuildModeHandlerOptions & { finish(): void };

async function withCliBuildHooks<T>(
  config: AppConfig,
  trimmed: string,
  run: (hooks: CliBuildHooks) => Promise<T>,
): Promise<T> {
  const hooks = cliBuildHooks(config, trimmed);
  try {
    return await run(hooks);
  } finally {
    hooks.finish();
  }
}

function cliBuildHooks(config: AppConfig, trimmed: string): CliBuildHooks {
  const spinner = new Spinner();
  const labelBase = `build ${config.builder_model_id}`;
  const promptHint = trimmed.trim().replace(/\s+/g, " ").slice(0, 36);
  const baseLabel = promptHint ? `${labelBase}: ${promptHint}` : labelBase;
  const updateProgress = makeSpinnerProgress(spinner, baseLabel);
  let started = false;
  return {
    onProgress(event) {
      if (!started) {
        spinner.start(baseLabel);
        started = true;
      }
      updateProgress(event);
    },
    finish() {
      if (started) {
        spinner.stop();
      }
    },
  };
}

function chatHelpLines(): string[] {
  return lLines(
    [
      "Free-form messages go to AI, and registered skills are called when useful.",
      "Slash commands:",
      "  /skills [--all]               List skills (--all includes builtins; select to inspect/delete)",
      "  /models                       List models",
      "  /model                        Pick chat/builder models interactively",
      "  /build list                   List skill drafts",
      "  /logs [--run id] [--skill id] Run logs",
      "  /logs --events [--tail N]     Conversation/CLI/skill event logs",
      "  /config                       Show current settings",
      "  /profile                      Show soul.md / user.md / memory.md",
      "  /profile append <soul|user|memory> <text>",
      "  /reset                        Reset chat history",
      "  /help                         Show this help",
      "  /exit                         Exit",
      "",
      "In build/edit mode, dedicated commands are available (/test /status /back; /register is shown for compatibility).",
    ],
    [
      "自由な会話入力はAIに送られ、必要に応じて登録済みスキルが呼び出されます。",
      "スラッシュコマンド:",
      "  /skills [--all]               スキル一覧 (--all でビルトインも表示)",
      "  /models                       モデル一覧",
      "  /model                        対話的にchat/builderモデルを選択",
      "  /build list                   作成中のスキル一覧",
      "  /logs [--run id] [--skill id] 実行ログ",
      "  /logs --events [--tail N]     会話/CLI/スキルのイベントログ",
      "  /config                       現在の設定を表示",
      "  /profile                      soul.md / user.md / memory.md を表示",
      "  /profile append <soul|user|memory> <text>",
      "  /reset                        会話履歴をリセット",
      "  /help                         このヘルプ",
      "  /exit                         終了",
      "",
      "ビルド/編集モード中は専用コマンド (/test /status /back、/register は互換表示) に切り替わります。",
    ],
  );
}

async function buildChatTestCommand(config: AppConfig, rest: string[]): Promise<string[]> {
  const [skillId, ...optionParts] = rest.slice(1);
  if (!skillId) {
    return [l("Usage: /build test <skill-id> [--payload '{...}']", "使い方: /build test <skill-id> [--payload '{...}']")];
  }
  const options = parseOptions(optionParts);
  return buildTestLines(config, skillId, buildPayloadFromOptions(options));
}

async function buildChatDraftCommand(config: AppConfig, rest: string[]): Promise<string[]> {
  const [skillId, ...messageParts] = rest.slice(1);
  const message = messageParts.join(" ").trim();
  if (!skillId || !message) {
    return [l('Usage: /build chat <skill-id> "message"', '使い方: /build chat <skill-id> "メッセージ"')];
  }
  return withCliBuildHooks(config, message, (hooks) =>
    buildChatLines(config, skillId, message, { onProgress: hooks.onProgress }),
  );
}

async function buildChatStatusCommand(config: AppConfig, rest: string[]): Promise<string[]> {
  const skillId = rest[1];
  if (!skillId) {
    return [l("Usage: /build status <skill-id>", "使い方: /build status <skill-id>")];
  }
  return buildStatusLines(config, skillId);
}

function chatRunPayload(skillId: string, text: string): Record<string, unknown> {
  if (!text) {
    return {};
  }
  if (skillId === "memo-search") {
    return { query: text };
  }
  if (["todo-done", "todo-delete"].includes(skillId)) {
    return { id: text };
  }
  return { text };
}

async function chatWithModel(
  config: AppConfig,
  userText: string,
  history: ChatTurn[],
  preferredSkillId?: string,
  intentRuntime?: IntentRuntime,
): Promise<string[]> {
  return chatRespond(config, userText, history, {
    formatNarrative: formatAssistantNarrative,
    spinner: new Spinner(),
    eventSource: "chat",
    preferredSkillId,
    onBuildSuggestion: (suggestion) => setPendingBuildSuggestion(intentRuntime, suggestion, userText),
  });
}

function parseOptions(args: string[]): Options {
  const options: Options = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value.startsWith("--")) {
      const key = value.slice(2).replaceAll("-", "_");
      const next = args[i + 1];
      const optionValue = next && !next.startsWith("--") ? next : true;
      if (optionValue !== true) {
        i += 1;
      }
      const previous = options[key];
      if (previous === undefined) {
        options[key] = optionValue;
      } else if (Array.isArray(previous)) {
        options[key] = [...previous, optionValue];
      } else {
        options[key] = [previous, optionValue];
      }
    } else {
      options._.push(value);
    }
  }
  return options;
}

function optionsToSetupOptions(options: Options): SetupWorkspaceOptions {
  const chatModel = stringOption(options.model) || stringOption(options.chat_model);
  const enableModels = listOption(options.enable);
  return {
    workspace: stringOption(options.workspace),
    notesDir: stringOption(options.notes_dir),
    skillsDir: stringOption(options.skills_dir),
    memoryDir: stringOption(options.memory_dir),
    indexDir: stringOption(options.index_dir),
    logsDir: stringOption(options.logs_dir),
    chatModel,
    builder: stringOption(options.builder),
    enableModels,
    forceReconfigure: Boolean(options.reconfigure),
  };
}

function shouldPromptSetup(options: Options): boolean {
  if (options.keep || options.yes || options.defaults || options.no_input) {
    return false;
  }
  if (options.wizard || options.reconfigure) {
    return true;
  }
  const configurableOptions = [
    "workspace",
    "notes_dir",
    "skills_dir",
    "memory_dir",
    "index_dir",
    "logs_dir",
    "model",
    "chat_model",
    "builder",
    "enable",
  ];
  return process.stdin.isTTY && !configurableOptions.some((key) => options[key] !== undefined);
}

// setup 画面の見た目を整えるためのヘルパー群。
// stdout が TTY でない / NO_COLOR が設定されているときはエスケープを吐かない。
const SETUP_COLOR_ENABLED = process.stdout.isTTY && process.env.NO_COLOR === undefined;
function setupTone(open: string, close: string, text: string): string {
  return SETUP_COLOR_ENABLED ? `\x1b[${open}m${text}\x1b[${close}m` : text;
}
const setupTones = {
  bold: (s: string) => setupTone("1", "22", s),
  dim: (s: string) => setupTone("2", "22", s),
  cyan: (s: string) => setupTone("36", "39", s),
};
// 日本語等の East-Asian 文字を概ね幅 2 として扱う簡易計算。
// 罫線パディングが大きくズレない程度に揃えば十分。
function setupDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += cp >= 0x1100 ? 2 : 1;
  }
  return width;
}
const SETUP_DIVIDER_WIDTH = 46;
function setupSectionDivider(title: string): string {
  const left = "─── ";
  const right = " ";
  const used = setupDisplayWidth(left) + setupDisplayWidth(title) + setupDisplayWidth(right);
  const fill = Math.max(3, SETUP_DIVIDER_WIDTH - used);
  return setupTones.dim(left) + setupTones.bold(title) + setupTones.dim(right + "─".repeat(fill));
}

async function promptSetupOptions(base: SetupWorkspaceOptions): Promise<SetupWorkspaceOptions> {
  const workspace = base.workspace ? base.workspace : defaultWorkspace();
  const modelsFile = modelsPath(workspace);
  const modelsExisting = await pathExists(modelsFile);

  // 初回セットアップでも案内に使えるよう、ここで .env のひな形を作っておく。
  // 既存環境では何もしない。
  await mkdir(workspace, { recursive: true });
  const dotenv = await ensureDotenvSkeleton(workspace);
  await loadDotenv(workspace);
  const dotenvKeys = await readDotenvKeys(workspace);
  const hasConfiguredApiKey = Array.from(dotenvKeys).some((key) => /_API_KEY(S)?(_\d+)?$/.test(key) || /_KEY$/.test(key));

  console.log(setupSectionDivider(l("Agent-Sin setup", "Agent-Sin setup")));
  console.log("");
  console.log(`${setupTones.bold("Workspace")} : ${setupTones.cyan(workspace)}`);
  console.log(`${setupTones.bold(".env     ")} : ${setupTones.cyan(dotenv.path)}`);
  console.log("");

  // .env に API キーが 1 件も書かれていないときは、初回 / 再設定どちらでも案内する。
  // (前回の自動実行などで models.yaml だけが先に作られているケースも拾える)
  if (!modelsExisting || !hasConfiguredApiKey) {
    console.log(l(
      "Add the API keys you want to use to .env, then re-run setup so they get detected.",
      "先に .env に API キーを書いてください。サンプルはコメントアウト済みなので、",
    ));
    console.log(l(
      "Sample entries are already commented in the file — uncomment the ones you need.",
      "使う行を有効化して setup を再実行すると検出されます。",
    ));
    console.log(setupTones.dim(l(
      "Note: Codex CLI / Claude Code CLI just need a CLI login — no .env entry required.",
      "※ Codex CLI / Claude Code CLI はログイン済みなら .env 不要です。",
    )));
    console.log("");
  }

  const interactive = process.stdin.isTTY;
  const scriptedAnswers = interactive ? null : await readSetupAnswersFromInput();
  let scriptIndex = 0;
  const ask = async (label: string, fallback: string): Promise<string> => {
    const bracket = setupTones.dim(`[${fallback}]`);
    if (interactive) {
      const rl = createInterface({ input, output });
      try {
        const answer = (await rl.question(`  ${label} ${bracket}: `)).trim();
        return answer || fallback;
      } finally {
        rl.close();
      }
    }
    console.log(`  ${label} ${bracket}:`);
    const answer = (scriptedAnswers?.[scriptIndex]?.trim() || "");
    scriptIndex += 1;
    return answer || fallback;
  };

  if (modelsExisting) {
    const current = await currentSetupDefaults(workspace);
    console.log(setupTones.bold(l("Current model settings", "現在のモデル設定")));
    console.log(`  ${setupTones.dim("chat   ")} ${current.chatLabel}`);
    console.log(`  ${setupTones.dim("builder")} ${current.builderLabel}`);
    console.log("");
    const reconfigureLabel = l("Reconfigure models?", "モデルを再設定しますか？");
    const reconfigure = base.forceReconfigure
      ? true
      : await askReconfigurePrompt(reconfigureLabel, interactive, async () => {
          const answer = scriptedAnswers?.[scriptIndex]?.trim() || "";
          scriptIndex += 1;
          return answer;
        });
    if (!reconfigure) {
      console.log(l("Keeping existing model settings.", "既存のモデル設定をそのまま使います。"));
      console.log("");
      return base;
    }
    console.log("");
    return promptSetupModelChoices(base, workspace, ask, {
      chat: current.chat,
      builder: current.builder,
    });
  }

  return promptSetupModelChoices(base, workspace, ask);
}

type SetupAsk = (label: string, fallback: string) => Promise<string>;

interface SetupChoiceDefaults {
  provider?: string;
  model?: string;
  effort?: string;
}

async function promptSetupModelChoices(
  base: SetupWorkspaceOptions,
  workspace: string,
  ask: SetupAsk,
  defaults: { chat?: SetupChoiceDefaults; builder?: SetupChoiceDefaults } = {},
): Promise<SetupWorkspaceOptions> {
  const detected = await detectAvailableProviders(workspace);
  if (detected.length > 0) {
    console.log(setupTones.bold(l("Available providers", "使えるプロバイダ")));
    const idWidth = Math.max(...detected.map((p) => p.id.length));
    const labelWidth = Math.max(...detected.map((p) => p.label.length));
    for (const [index, p] of detected.entries()) {
      const num = setupTones.cyan(String(index + 1).padStart(2));
      const id = p.id.padEnd(idWidth);
      const label = p.label.padEnd(labelWidth);
      const hint = setupTones.dim(`(${p.hint})`);
      console.log(`  ${num}  ${id}   ${label}   ${hint}`);
    }
  } else {
    console.log(setupTones.dim(l("No usable providers detected (no CLI or API key found in .env).", "使えそうなプロバイダは検出できませんでした (CLI も .env の API キーも見つからない)。")));
    console.log(setupTones.dim(l("You can continue and edit .env / models.yaml later.", "そのまま進めて後から .env / models.yaml を編集することもできます。")));
  }

  const fallbackProvider = pickFallbackProvider(detected);
  const detectedIds = detected.map((p) => p.id);
  const numericHint = detected.length > 0
    ? l(`Enter a number (1-${detected.length}) or provider id. Empty Enter uses [default].`, `番号 (1-${detected.length}) かプロバイダ ID を入力。空 Enter で [既定値] 採用。`)
    : l("Press Enter to use the [default] value.", "空 Enter で [既定値] が使われます。");

  console.log("");
  console.log(setupSectionDivider(l("[1/2] Chat model", "[1/2] チャットで使うモデル")));
  console.log(setupTones.dim(numericHint));
  console.log("");
  const chat = await askProviderChoice(ask, "chat", fallbackProvider, defaults.chat, detectedIds);

  console.log("");
  console.log(setupSectionDivider(l("[2/2] Builder model (skill generation)", "[2/2] ビルダー (スキル生成) で使うモデル")));
  console.log(setupTones.dim(l(
    "Recommended: a CLI provider (codex / claude-code). API providers also work for simple skills.",
    "推奨: CLI 系 (codex / claude-code) が安定。API 系でも作れますが簡単なスキル向きです。",
  )));
  console.log(setupTones.dim(numericHint));
  console.log("");
  const builder = await askProviderChoice(ask, "builder", chat.provider || fallbackProvider, defaults.builder, detectedIds);

  const pairIds = deriveSetupChoicePairIds(chat, builder);
  return {
    ...base,
    initialModels: { chat, builder },
    chatModel: pairIds.chat,
    builder: pairIds.builder,
  };
}

async function askYesNo(ask: SetupAsk, label: string, defaultValue: boolean): Promise<boolean> {
  const fallback = defaultValue ? "y" : "n";
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const answer = (await ask(label, fallback)).trim().toLowerCase();
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    console.log(l("  ! Enter y or n.", "  ⚠ y か n を入力してください。"));
  }
  throw new Error(l("Yes/no input could not be resolved. Aborting setup.", "確認入力が解決できませんでした。setup を中断します。"));
}

async function askReconfigurePrompt(
  label: string,
  interactive: boolean,
  readScripted: () => Promise<string>,
): Promise<boolean> {
  const prompt = `${label}${setupTones.dim("[y/n]")}: `;
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    let raw: string;
    if (interactive) {
      const rl = createInterface({ input, output });
      try {
        raw = await rl.question(prompt);
      } finally {
        rl.close();
      }
    } else {
      console.log(prompt);
      raw = await readScripted();
    }
    const answer = raw.trim().toLowerCase();
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    console.log(l("  ! Enter y or n.", "  ⚠ y か n を入力してください。"));
  }
  throw new Error(l("Yes/no input could not be resolved. Aborting setup.", "確認入力が解決できませんでした。setup を中断します。"));
}

async function currentSetupDefaults(workspace: string): Promise<{
  chat?: SetupChoiceDefaults;
  builder?: SetupChoiceDefaults;
  chatLabel: string;
  builderLabel: string;
}> {
  const models = await loadModels(workspace);
  const chatId = currentRoleId(models, "chat");
  const builderId = currentRoleId(models, "builder");
  const chatEntry = chatId ? models.models[chatId] : undefined;
  const builderEntry = builderId ? models.models[builderId] : undefined;
  return {
    chat: choiceDefaultsFromEntry(chatId, chatEntry),
    builder: choiceDefaultsFromEntry(builderId, builderEntry),
    chatLabel: formatSetupModelSummary(chatId, chatEntry),
    builderLabel: formatSetupModelSummary(builderId, builderEntry),
  };
}

function currentRoleId(models: ModelConfig, role: "chat" | "builder"): string | undefined {
  const roleId = role === "chat" ? models.roles?.chat : models.roles?.builder;
  if (roleId && models.models[roleId]) return roleId;
  if (models.models[role]) return role;
  const defaultId = role === "chat" ? "codex-low" : "codex-xhigh";
  if (models.models[defaultId]) return defaultId;
  const enabled = Object.entries(models.models).find(([, entry]) => entry.enabled);
  return enabled?.[0] || Object.keys(models.models)[0];
}

function choiceDefaultsFromEntry(
  id: string | undefined,
  entry: ModelConfig["models"][string] | undefined,
): SetupChoiceDefaults | undefined {
  if (!id || !entry) return undefined;
  const provider = inferSetupProvider(id, entry);
  return {
    provider,
    model: entry.model,
    effort: entry.effort,
  };
}

function formatSetupModelSummary(
  id: string | undefined,
  entry: ModelConfig["models"][string] | undefined,
): string {
  if (!id) return "-";
  if (!entry) return l(`${id} (missing)`, `${id} (見つかりません)`);
  const provider = inferSetupProvider(id, entry) || entry.type;
  const fields = [provider];
  if (entry.model) fields.push(entry.model);
  if (entry.effort) fields.push(`effort=${entry.effort}`);
  return `${id} (${fields.join(" / ")})`;
}

function inferSetupProvider(id: string, entry: ModelConfig["models"][string]): string | undefined {
  if (entry.provider) return entry.provider;
  if (entry.type === "ollama") return "ollama";
  const exact = PROVIDER_CATALOG.find((provider) => provider.id === id);
  if (exact) return exact.id;
  const prefixed = PROVIDER_CATALOG.find((provider) => id.startsWith(`${provider.id}-`));
  return prefixed?.id;
}

function pickFallbackProvider(detected: { id: string }[]): string {
  if (detected.length > 0) return detected[0].id;
  return "codex";
}

const ALLOWED_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const MAX_PROMPT_ATTEMPTS = 5;

async function askProviderChoice(
  ask: (label: string, fallback: string) => Promise<string>,
  role: "chat" | "builder",
  fallbackProvider: string,
  defaults?: SetupChoiceDefaults,
  detectedIds: string[] = [],
): Promise<SetupModelChoice> {
  const knownProviders = PROVIDER_CATALOG.map((p) => p.id);
  const providerDefault = knownProviders.includes(defaults?.provider || "")
    ? defaults?.provider || fallbackProvider
    : fallbackProvider;

  // プロバイダ: 番号 (検出済みリストの順) か PROVIDER_CATALOG の id を受け付ける。
  // 大文字小文字や前後空白は許容して正規化する。
  let provider = "";
  let catalog: ProviderCatalogEntry | undefined;
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const raw = await ask(l("Provider", "プロバイダ"), providerDefault);
    const trimmed = raw.trim();
    const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= detectedIds.length) {
      provider = detectedIds[numeric - 1];
    } else {
      provider = trimmed.toLowerCase();
    }
    catalog = PROVIDER_CATALOG.find((p) => p.id === provider);
    if (catalog) break;
    console.log(l(`  ! Unknown provider "${raw}".`, `  ⚠ プロバイダ "${raw}" は不明です。`));
    if (detectedIds.length > 0) {
      console.log(l(`    Enter a number (1-${detectedIds.length}) or one of: ${knownProviders.join(" / ")}`, `    番号 (1-${detectedIds.length}) または次のいずれかを入力: ${knownProviders.join(" / ")}`));
    } else {
      console.log(l(`    Available: ${knownProviders.join(" / ")}`, `    使えるのは: ${knownProviders.join(" / ")}`));
    }
    console.log(l(`    Press Enter to use [${providerDefault}].`, `    そのまま Enter で [${providerDefault}] を採用できます。`));
    catalog = undefined;
  }
  if (!catalog) {
    throw new Error(
      l(
        `Provider input could not be resolved after ${MAX_PROMPT_ATTEMPTS} attempts. Aborting setup.`,
        `プロバイダの入力が ${MAX_PROMPT_ATTEMPTS} 回試行しても解決できませんでした。setup を中断します。`,
      ),
    );
  }

  // モデル: 必須なので空は弾く。ただしフォールバック (catalog.defaultModel) があれば空 Enter で採用。
  // フォールバックが無いプロバイダは任意で空可。
  let model: string | undefined;
  const sameProviderDefaults = defaults?.provider === provider ? defaults : undefined;
  const modelDefault = sameProviderDefaults?.model || catalog.defaultModel || "";
  if (modelDefault) {
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
      const candidate = (await ask(l("Model", "モデル"), modelDefault)).trim();
      if (candidate) {
        model = candidate;
        break;
      }
      console.log(l(`  ! Model name cannot be empty (Enter uses [${modelDefault}]).`, `  ⚠ モデル名は空にできません (Enter のみで [${modelDefault}] が入ります)。`));
    }
    if (!model) {
      throw new Error(l("Model name was not provided. Aborting setup.", "モデル名が入力できませんでした。setup を中断します。"));
    }
  } else {
    const candidate = (await ask(l("Model (optional, can be empty)", "モデル (任意、空可)"), "")).trim();
    model = candidate || undefined;
  }

  // effort: 必要なプロバイダのみ。allowed なリストに無いと弾く。
  let effort: string | undefined;
  if (catalog.needsEffort) {
    const catalogEffortDefault =
      role === "chat" ? catalog.defaultChatEffort || "low" : catalog.defaultBuilderEffort || "xhigh";
    const effortDefault =
      sameProviderDefaults?.effort && (ALLOWED_EFFORTS as readonly string[]).includes(sameProviderDefaults.effort)
        ? sameProviderDefaults.effort
        : catalogEffortDefault;
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
      const raw = await ask(l("effort (low/medium/high/xhigh)", "effort (low/medium/high/xhigh)"), effortDefault);
      const normalized = raw.trim().toLowerCase();
      if ((ALLOWED_EFFORTS as readonly string[]).includes(normalized)) {
        effort = normalized;
        break;
      }
      console.log(l(`  ! Invalid effort "${raw}". Use one of: ${ALLOWED_EFFORTS.join(" / ")}.`, `  ⚠ effort "${raw}" は無効。${ALLOWED_EFFORTS.join(" / ")} のいずれかを入力してください。`));
    }
    if (!effort) {
      throw new Error(l("effort was not provided. Aborting setup.", "effort が入力できませんでした。setup を中断します。"));
    }
  }

  return { provider, model, effort };
}

async function readSetupAnswersFromInput(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

function stringOption(value: OptionValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const last = value.at(-1);
    return typeof last === "string" ? last : undefined;
  }
  return undefined;
}

function listOption(value: OptionValue | undefined): string[] {
  if (typeof value === "string") {
    return splitListOption(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? splitListOption(item) : []));
  }
  return [];
}

function splitListOption(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function printSetupHelp(): void {
  console.log(l(`Agent-Sin setup

Usage:
  agent-sin setup [--model entry] [--builder entry]
                  [--chat-codex-model name] [--chat-effort level]
                  [--builder-codex-model name] [--builder-effort level]
  agent-sin setup --reconfigure
  agent-sin setup --keep
  agent-sin setup --yes

Examples:
  agent-sin setup
  agent-sin setup --model chat --builder builder
  agent-sin setup --chat-codex-model gpt-5.5 --chat-effort low
  agent-sin setup --builder-codex-model gpt-5.5 --builder-effort xhigh
  agent-sin setup --reconfigure
  agent-sin setup --keep
  agent-sin setup --enable chat,builder,openai
  agent-sin setup --yes`, `Agent-Sin セットアップ

使い方:
  agent-sin setup [--model entry] [--builder entry]
                  [--chat-codex-model name] [--chat-effort level]
                  [--builder-codex-model name] [--builder-effort level]
  agent-sin setup --reconfigure
  agent-sin setup --keep
  agent-sin setup --yes

例:
  agent-sin setup
  agent-sin setup --model chat --builder builder
  agent-sin setup --chat-codex-model gpt-5.5 --chat-effort low
  agent-sin setup --builder-codex-model gpt-5.5 --builder-effort xhigh
  agent-sin setup --reconfigure
  agent-sin setup --keep
  agent-sin setup --enable chat,builder,openai
  agent-sin setup --yes`));
}

function optionsToArgs(options: Options): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key !== "_") {
      result[key] = value;
    }
  }
  return result;
}

function parseJsonOption(value: OptionValue, name: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error(l(`${name} requires a JSON object`, `${name} には JSON object が必要です`));
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(l(`${name} requires a JSON object`, `${name} には JSON object が必要です`));
  }
  return parsed as Record<string, unknown>;
}

function printHelp(): void {
  console.log(l(`Agent-Sin CLI

Usage:
  agent-sin setup [--yes] [--model model-id]
  agent-sin start [message]
  agent-sin start --daemon
  agent-sin chat [message]
  agent-sin skills
  agent-sin run memo-save --text "..."
  agent-sin run memo-search --query "..."
  agent-sin run <skill-id> [--key value]
  agent-sin build [skill-id] [--prompt "..."]
  agent-sin build list
  agent-sin build chat <skill-id> "change request"
  agent-sin build status <skill-id>
  agent-sin build test <skill-id> [--payload '{...}']
  agent-sin skill new <id> [--runtime python|typescript] [--name ...] [--description ...]
  agent-sin skill validate <id>
  agent-sin skill test <id> [--payload '{...}']
  agent-sin profile show [soul|user|memory]
  agent-sin profile append <soul|user|memory> <text>
  agent-sin models
  agent-sin models keys [--provider openai|gemini|anthropic] [--check]
  agent-sin model set [chat|builder] <model-id>
  agent-sin logs [--skill skill-id]
  agent-sin logs --run <run-id>
  agent-sin logs --events [--tail 50] [--source chat|skill|cli|setup|build|schedule|discord|telegram] [--level info|warn|error]
  agent-sin daemon [--once]
  agent-sin gateway [--no-discord] [--no-telegram]
  agent-sin service status|install|start|stop|restart
  agent-sin schedules
  agent-sin schedules trigger <id>
  agent-sin notify --title <title> --body <body> [--channel macos|discord|telegram|slack|mail|auto] [--thread-id <id>] [--to <addr>] [--subtitle <s>] [--sound]
  agent-sin discord
  agent-sin telegram
  agent-sin telegram id [--save]
  agent-sin export [--out <file>]
  agent-sin import <archive> [--force] [--dry-run] [--no-backup]
  agent-sin config`, `Agent-Sin CLI

使い方:
  agent-sin setup [--yes] [--model model-id]
  agent-sin start [message]
  agent-sin start --daemon
  agent-sin chat [message]
  agent-sin skills
  agent-sin run memo-save --text "..."
  agent-sin run memo-search --query "..."
  agent-sin run <skill-id> [--key value]
  agent-sin build [skill-id] [--prompt "..."]
  agent-sin build list
  agent-sin build chat <skill-id> "変更内容"
  agent-sin build status <skill-id>
  agent-sin build test <skill-id> [--payload '{...}']
  agent-sin skill new <id> [--runtime python|typescript] [--name ...] [--description ...]
  agent-sin skill validate <id>
  agent-sin skill test <id> [--payload '{...}']
  agent-sin profile show [soul|user|memory]
  agent-sin profile append <soul|user|memory> <text>
  agent-sin models
  agent-sin models keys [--provider openai|gemini|anthropic] [--check]
  agent-sin model set [chat|builder] <model-id>
  agent-sin logs [--skill skill-id]
  agent-sin logs --run <run-id>
  agent-sin logs --events [--tail 50] [--source chat|skill|cli|setup|build|schedule|discord|telegram] [--level info|warn|error]
  agent-sin daemon [--once]
  agent-sin gateway [--no-discord] [--no-telegram]
  agent-sin service status|install|start|stop|restart
  agent-sin schedules
  agent-sin schedules trigger <id>
  agent-sin notify --title <title> --body <body> [--channel macos|discord|telegram|slack|mail|auto] [--thread-id <id>] [--to <addr>] [--subtitle <s>] [--sound]
  agent-sin discord
  agent-sin telegram
  agent-sin telegram id [--save]
  agent-sin export [--out <file>]
  agent-sin import <archive> [--force] [--dry-run] [--no-backup]
  agent-sin config`));
}

async function cmdNotify(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const positional = options._;
  const title = stringOption(options.title) || positional[0] || "";
  const body = stringOption(options.body) || positional.slice(1).join(" ") || "";
  const subtitle = stringOption(options.subtitle);
  const sound = Boolean(options.sound);
  const channelRaw = stringOption(options.channel) || "auto";
  const to = stringOption(options.to);
  const threadId = stringOption(options.thread_id);
  const discordThreadId = threadId || stringOption(options.discord_thread_id);
  const telegramThreadId = threadId || stringOption(options.telegram_thread_id);
  if (!title && !body) {
    console.error(
      l(
        "Usage: agent-sin notify --title <title> --body <body> [--channel macos|discord|telegram|slack|mail|auto] [--thread-id <id>] [--to <addr>] [--subtitle <s>] [--sound]",
        "使い方: agent-sin notify --title <title> --body <body> [--channel macos|discord|telegram|slack|mail|auto] [--thread-id <id>] [--to <addr>] [--subtitle <s>] [--sound]",
      ),
    );
    return 1;
  }
  const allowed = ["auto", "macos", "discord", "telegram", "slack", "mail", "stderr"];
  if (!allowed.includes(channelRaw)) {
    console.error(l(`Invalid --channel: ${channelRaw} (allowed: ${allowed.join(", ")})`, `--channel が不正です: ${channelRaw} (使用可: ${allowed.join(", ")})`));
    return 1;
  }
  try {
    const result = await notify({
      title,
      body,
      subtitle,
      sound,
      channel: channelRaw as "auto" | "macos" | "discord" | "telegram" | "slack" | "mail" | "stderr",
      to,
      discordThreadId,
      telegramThreadId,
    });
    console.log(`notify: ${result.channel} ${result.ok ? "ok" : l("failed", "失敗")}${result.detail ? ` - ${result.detail}` : ""}`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(l(`notify failed: ${message}`, `通知に失敗しました: ${message}`));
    return 1;
  }
}

async function cmdDiscord(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    console.log(l(`Usage:
  agent-sin discord

Run as a Discord bot. Reads from environment variables:
  AGENT_SIN_DISCORD_BOT_TOKEN            Discord bot token (required)
  AGENT_SIN_DISCORD_ALLOWED_USER_IDS     Comma-separated Discord user IDs allowed to talk to the bot (required)
  AGENT_SIN_DISCORD_LISTEN_CHANNEL_IDS   Optional: parent channels where @mentioning the bot auto-creates a
                                         new thread. Inside that thread no @mention is needed. Requires the
                                         privileged Message Content intent in the dev portal.

The bot reacts to your message in real time (received → thinking → skill → done / error).
Created thread IDs are persisted under <workspace>/discord/bot-threads.json.
Press Ctrl+C to stop.`, `使い方:
  agent-sin discord

Discord bot として起動します。環境変数を読み込みます:
  AGENT_SIN_DISCORD_BOT_TOKEN            Discord bot token (必須)
  AGENT_SIN_DISCORD_ALLOWED_USER_IDS     bot と会話できる Discord user ID のカンマ区切り (必須)
  AGENT_SIN_DISCORD_LISTEN_CHANNEL_IDS   任意: bot メンションで新規スレッドを作る親チャンネル

受信 → 考え中 → スキル → 完了 / エラーをリアルタイムに反映します。
作成したスレッド ID は <workspace>/discord/bot-threads.json に保存します。
停止は Ctrl+C です。`));
    return 0;
  }
  const config = await loadConfig();
  await warnIfSchedulesNeedService(config);
  return await runDiscordBot(config);
}

async function cmdTelegram(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const subcommand = options._[0];
  if (subcommand === "id" || subcommand === "whoami") {
    return cmdTelegramId(options);
  }
  if (options.help) {
    console.log(l(`Usage:
  agent-sin telegram
  agent-sin telegram id [--save] [--wait seconds]

Run as a Telegram bot. Reads from environment variables:
  AGENT_SIN_TELEGRAM_BOT_TOKEN            Telegram bot token from BotFather (required)
  AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS     Your Telegram user ID(s), comma-separated (required)
  AGENT_SIN_TELEGRAM_LISTEN_CHAT_IDS      Optional: group chat IDs used for logging and notify fallback

The bot responds in DMs, when mentioned, or when you reply to one of its messages.
Private chat topics are kept separate, and private chats use draft streaming while generating.
Progress messages are quiet by default. Use /progress detail in a chat when needed.
Polling offset is persisted under <workspace>/telegram/offset.json.
Press Ctrl+C to stop.`, `使い方:
  agent-sin telegram
  agent-sin telegram id [--save] [--wait seconds]

Telegram bot として起動します。環境変数を読み込みます:
  AGENT_SIN_TELEGRAM_BOT_TOKEN            BotFather の Telegram bot token (必須)
  AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS     Telegram user ID のカンマ区切り (必須)
  AGENT_SIN_TELEGRAM_LISTEN_CHAT_IDS      任意: ログや通知のフォールバックに使う group chat ID

DM、メンション、bot への返信に応答します。
private chat は生成中に draft streaming を使います。
進捗通知は静音が既定です。必要ならチャットで /progress detail を使ってください。
Polling offset は <workspace>/telegram/offset.json に保存します。
停止は Ctrl+C です。`));
    return 0;
  }
  if (subcommand) {
    console.error(l(`Unknown subcommand: telegram ${subcommand}`, `不明なサブコマンドです: telegram ${subcommand}`));
    console.error(l("Usage: agent-sin telegram [id --save]", "使い方: agent-sin telegram [id --save]"));
    return 1;
  }
  const config = await loadConfig();
  await warnIfSchedulesNeedService(config);
  return await runTelegramBot(config);
}

async function cmdTelegramId(options: Options): Promise<number> {
  const token = (process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    console.error(l("AGENT_SIN_TELEGRAM_BOT_TOKEN is not set. Add it to ~/.agent-sin/.env first.", "AGENT_SIN_TELEGRAM_BOT_TOKEN が未設定です。先に ~/.agent-sin/.env に追加してください。"));
    return 1;
  }
  const waitSeconds = parsePositiveInteger(stringOption(options.wait) || "5", 5);
  let updates: TelegramUpdate[];
  try {
    updates = await fetchTelegramUpdatesForIdentity(token, waitSeconds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(l(`Telegram updates could not be read: ${message}`, `Telegram updates を読めませんでした: ${message}`));
    console.error(l("If another agent-sin telegram process is running, stop it briefly and run this command again.", "別の agent-sin telegram が起動中なら一度止めてから再実行してください。"));
    return 1;
  }
  const candidates = extractTelegramIdentityCandidates(updates);
  if (candidates.length === 0) {
    console.log(l("Telegram user ID was not found in pending updates.", "pending update から Telegram user ID が見つかりませんでした。"));
    console.log(l("Send a new DM such as /start or id to your bot, wait a few seconds, then run:", "bot に /start や id などの新しい DM を送り、数秒待ってから実行してください:"));
    console.log("  agent-sin telegram id");
    console.log(l("If it still stays empty, run: agent-sin telegram id --wait 30 and send the DM while it waits.", "まだ空なら agent-sin telegram id --wait 30 を実行し、待機中に DM を送ってください。"));
    return 1;
  }

  console.log(l("Telegram user ID candidates:", "Telegram user ID 候補:"));
  for (const candidate of candidates.slice(0, 5)) {
    console.log(
      `  user_id=${candidate.userId} chat_id=${candidate.chatId} chat=${candidate.chatType} name=${candidate.displayName}`,
    );
  }

  if (!options.save) {
    console.log("");
    console.log(l("To save the first private user to ~/.agent-sin/.env:", "最初の private user を ~/.agent-sin/.env に保存するには:"));
    console.log("  agent-sin telegram id --save");
    return 0;
  }

  const selected = selectTelegramIdentityCandidate(candidates, stringOption(options.user_id));
  if (!selected) {
    console.error(l("Could not choose a Telegram user ID. Re-run with --user-id <id>.", "Telegram user ID を選べませんでした。--user-id <id> を付けて再実行してください。"));
    return 1;
  }
  const config = await loadConfig();
  const entries = [{ key: "AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS", value: selected.userId }];
  if (selected.chatType === "private" && !process.env.AGENT_SIN_TELEGRAM_NOTIFY_CHAT_ID && !process.env.AGENT_SIN_TELEGRAM_CHAT_ID) {
    entries.push({ key: "AGENT_SIN_TELEGRAM_NOTIFY_CHAT_ID", value: selected.chatId });
  }
  await upsertDotenv(config.workspace, entries);
  console.log(l(`Saved AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS=${selected.userId}`, `保存しました AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS=${selected.userId}`));
  if (entries.some((entry) => entry.key === "AGENT_SIN_TELEGRAM_NOTIFY_CHAT_ID")) {
    console.log(l(`Saved AGENT_SIN_TELEGRAM_NOTIFY_CHAT_ID=${selected.chatId}`, `保存しました AGENT_SIN_TELEGRAM_NOTIFY_CHAT_ID=${selected.chatId}`));
  }
  return 0;
}

function parsePositiveInteger(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function fetchTelegramUpdatesForIdentity(token: string, waitSeconds: number): Promise<TelegramUpdate[]> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timeout: waitSeconds,
      allowed_updates: ["message"],
    }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: TelegramUpdate[];
    description?: string;
  };
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram API returned HTTP ${response.status}`);
  }
  return Array.isArray(data.result) ? data.result : [];
}

function selectTelegramIdentityCandidate(
  candidates: TelegramIdentityCandidate[],
  userId?: string,
): TelegramIdentityCandidate | null {
  if (userId) {
    return candidates.find((candidate) => candidate.userId === userId) || null;
  }
  return candidates.find((candidate) => candidate.chatType === "private") || candidates[0] || null;
}

async function cmdSchedules(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "trigger") {
    return cmdSchedulesTrigger(rest);
  }
  if (sub && sub !== "list") {
    console.error(l(`Unknown subcommand: schedules ${sub}`, `不明なサブコマンドです: schedules ${sub}`));
    return 1;
  }
  const config = await loadConfig();
  const schedules = await loadSchedules(config.workspace);
  if (schedules.length === 0) {
    console.log(l(`No schedules. Run \`agent-sin run schedule-add --payload '{...}'\` or edit ${path.join(config.workspace, "schedules.yaml")}`, `スケジュールはありません。 \`agent-sin run schedule-add --payload '{...}'\` を実行するか ${path.join(config.workspace, "schedules.yaml")} を編集してください`));
    return 0;
  }
  const now = new Date();
  console.log("id\tcron\tskill\tenabled\tnext_run");
  for (const schedule of schedules) {
    const next = schedule.enabled ? nextRunAfter(schedule.expression, now) : null;
    const nextStr = next ? next.toISOString() : "-";
    console.log(`${schedule.id}\t${schedule.cron}\t${schedule.skill}\t${schedule.enabled}\t${nextStr}`);
  }
  await warnIfSchedulesNeedService(config, schedules);
  return 0;
}

async function cmdSchedulesTrigger(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error(l("Usage: agent-sin schedules trigger <id>", "使い方: agent-sin schedules trigger <id>"));
    return 1;
  }
  const config = await loadConfig();
  const schedules = await loadSchedules(config.workspace);
  const schedule = schedules.find((entry) => entry.id === id);
  if (!schedule) {
    console.error(l(`Schedule not found: ${id}`, `スケジュールが見つかりません: ${id}`));
    return 1;
  }
  const result = await runScheduledSkill(config, schedule, "trigger");
  return result;
}

async function cmdDaemon(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const config = await loadConfig();
  return runScheduleDaemon(config, { once: Boolean(options.once) });
}

async function cmdGateway(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    console.log(l(`Usage:
  agent-sin gateway [--no-discord] [--no-telegram] [--once]
  agent-sin start --daemon
  agent-sin service run

Run Agent-Sin as a long-lived gateway. It starts the scheduler when enabled
schedules exist, and starts Discord / Telegram bots when their environment variables
are configured. Use agent-sin service install on macOS to keep it running.`, `使い方:
  agent-sin gateway [--no-discord] [--no-telegram] [--once]
  agent-sin start --daemon
  agent-sin service run

Agent-Sin を常駐 gateway として起動します。有効なスケジュールがあれば scheduler を、
環境変数が設定済みなら Discord / Telegram bot を起動します。
macOS で常駐させるには agent-sin service install を使ってください。`));
    return 0;
  }

  const config = await loadConfig();
  await maybePromoteDailyMemory(config, { eventSource: "schedule" });
  const schedules = await loadSchedules(config.workspace);
  const enabled = schedules.filter((schedule) => schedule.enabled);
  const startScheduler = enabled.length > 0;
  const startDiscord = !options.no_discord && hasDiscordConfig();
  const startTelegram = !options.no_telegram && hasTelegramConfig();
  if (!startScheduler && !startDiscord && !startTelegram) {
    console.log(l("agent-sin gateway: no enabled schedules and chat bots are not configured.", "agent-sin gateway: 有効なスケジュールがなく、チャット bot も未設定です。"));
    console.log(l("Add schedules, or set Discord allowed user IDs / Telegram bot token.", "スケジュールを追加するか、Discord allowed user IDs / Telegram bot token を設定してください。"));
    return 0;
  }
  console.log(
    l(
      `agent-sin gateway: starting (${startScheduler ? `${enabled.length} schedule(s)` : "scheduler idle"}, ${
        startDiscord ? "discord on" : "discord off"
      }, ${startTelegram ? "telegram on" : "telegram off"})`,
      `agent-sin gateway: 起動します (${startScheduler ? `${enabled.length}件のスケジュール` : "scheduler 待機"}, ${
        startDiscord ? "discord 有効" : "discord 無効"
      }, ${startTelegram ? "telegram 有効" : "telegram 無効"})`,
    ),
  );
  const startupVersion = agentSinVersionFresh();
  const versionCheckInterval = setInterval(() => {
    const current = agentSinVersionFresh();
    if (current !== startupVersion && current !== "unknown") {
      console.log(
        l(
          `agent-sin gateway: detected upgrade ${startupVersion} -> ${current}, exiting so launchd restarts with the new code.`,
          `agent-sin gateway: アップデートを検知 (${startupVersion} -> ${current}). launchd が新しいコードで再起動できるように終了します。`,
        ),
      );
      clearInterval(versionCheckInterval);
      process.exit(0);
    }
  }, 5 * 60 * 1000);
  versionCheckInterval.unref?.();

  const tasks: Array<Promise<number>> = [];
  if (startScheduler) {
    tasks.push(runScheduleDaemon(config, { once: Boolean(options.once) }));
  }
  if (startDiscord) {
    tasks.push(runDiscordBot(config));
  } else if (!options.no_discord && !startTelegram) {
    console.log(l("agent-sin gateway: Discord not configured.", "agent-sin gateway: Discord は未設定です。"));
  }
  if (startTelegram) {
    tasks.push(runTelegramBot(config));
  } else if (!options.no_telegram && !startDiscord) {
    console.log(l("agent-sin gateway: Telegram not configured.", "agent-sin gateway: Telegram は未設定です。"));
  }
  const results = await Promise.all(tasks);
  clearInterval(versionCheckInterval);
  return Math.max(...results);
}

async function cmdService(args: string[]): Promise<number> {
  const [sub = "status", ...rest] = args;
  const options = parseOptions(rest);
  const config = await loadConfig();
  switch (sub) {
    case "run":
      return cmdGateway(rest);
    case "plist":
    case "manifest": {
      const provider = getServiceProvider();
      if (!provider.supported) {
        console.error(provider.notSupportedReason());
        return 1;
      }
      console.log(provider.manifestText(config));
      return 0;
    }
    case "install":
      return installService(config, options);
    case "start":
      return startService(config);
    case "stop":
      return stopService(config);
    case "restart": {
      await stopService(config, { quiet: true, wait: true });
      return startService(config);
    }
    case "status":
      return serviceStatus(config);
    case "help":
    case "--help":
    case "-h":
      printServiceHelp();
      return 0;
    default:
      console.error(l(`Unknown subcommand: service ${sub}`, `不明なサブコマンドです: service ${sub}`));
      printServiceHelp();
      return 1;
  }
}

async function runScheduleDaemon(
  config: AppConfig,
  options: { once?: boolean; stop?: StopController } = {},
): Promise<number> {
  await maybePromoteDailyMemory(config, { eventSource: "schedule" });
  const schedules = await loadSchedules(config.workspace);
  const enabled = schedules.filter((schedule) => schedule.enabled);
  if (enabled.length === 0) {
    console.log(
      l(
        `No enabled schedules. Run \`agent-sin run schedule-add --payload '{...}'\` (or schedule-toggle to re-enable) or edit ${path.join(config.workspace, "schedules.yaml")}`,
        `有効なスケジュールはありません。 \`agent-sin run schedule-add --payload '{...}'\` を実行するか schedule-toggle で再有効化、または ${path.join(config.workspace, "schedules.yaml")} を編集してください`,
      ),
    );
    return 0;
  }
  console.log(l(`agent-sin daemon: ${enabled.length} active schedule(s)`, `agent-sin daemon: 有効なスケジュール ${enabled.length}件`));
  for (const schedule of enabled) {
    const next = nextRunAfter(schedule.expression, new Date());
    console.log(`  ${schedule.id}\t${schedule.cron}\t${schedule.skill}\tnext=${next ? next.toISOString() : "-"}`);
  }
  await appendEventLog(config, {
    level: "info",
    source: "schedule",
    event: "daemon_started",
    details: { count: enabled.length, schedules: enabled.map((schedule) => schedule.id) },
  });

  const stop = options.stop || createStopController();
  while (!stop.signaled) {
    const now = new Date();
    const delay = msUntilNextMinute(now);
    await sleepInterruptible(delay, stop);
    if (stop.signaled) {
      break;
    }
    const tick = roundDownToMinute(new Date());
    for (const schedule of enabled) {
      if (matchesCron(schedule.expression, tick)) {
        await runScheduledSkill(config, schedule, "tick");
      }
    }
    if (options.once) {
      break;
    }
  }
  await appendEventLog(config, {
    level: "info",
    source: "schedule",
    event: "daemon_stopped",
  });
  console.log(l("agent-sin daemon: stopped", "agent-sin daemon: 停止しました"));
  return 0;
}

async function runScheduledSkill(
  config: AppConfig,
  schedule: ScheduleEntry,
  reason: "trigger" | "tick",
): Promise<number> {
  await appendEventLog(config, {
    level: "info",
    source: "schedule",
    event: "schedule_fired",
    message: `${schedule.id} → ${schedule.skill}`,
    details: { schedule_id: schedule.id, skill_id: schedule.skill, reason, cron: schedule.cron },
  });
  try {
    const response = await runSkill(config, schedule.skill, schedule.args, { approved: schedule.approve });
    console.log(
      `[${schedule.id}] ${response.result.status} ${response.result.title}${response.result.summary ? ` / ${response.result.summary}` : ""}`,
    );
    for (const saved of response.saved_outputs.filter((item) => item.show_saved !== false)) {
      console.log(`[${schedule.id}] ${l(`saved: ${saved.path}`, `保存: ${saved.path}`)}`);
    }
    return response.result.status === "error" ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${schedule.id}] ${l(`error: ${message}`, `エラー: ${message}`)}`);
    await appendEventLog(config, {
      level: "error",
      source: "schedule",
      event: "schedule_error",
      message,
      details: { schedule_id: schedule.id, skill_id: schedule.skill, reason },
    });
    return 1;
  }
}

interface StopController {
  signaled: boolean;
  resolveWaiters: Set<() => void>;
}

function createStopController(): StopController {
  const controller: StopController = { signaled: false, resolveWaiters: new Set() };
  const handler = () => {
    if (controller.signaled) {
      return;
    }
    controller.signaled = true;
    for (const resolve of controller.resolveWaiters) {
      resolve();
    }
    controller.resolveWaiters.clear();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return controller;
}

function sleepInterruptible(ms: number, controller: StopController): Promise<void> {
  if (controller.signaled || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      controller.resolveWaiters.delete(settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    controller.resolveWaiters.add(settle);
  });
}

function msUntilNextMinute(from: Date): number {
  const next = roundDownToMinute(new Date(from.getTime() + 60_000));
  return Math.max(0, next.getTime() - from.getTime());
}

function roundDownToMinute(date: Date): Date {
  const copy = new Date(date.getTime());
  copy.setSeconds(0, 0);
  return copy;
}

function hasDiscordConfig(): boolean {
  return Boolean(
    (process.env.AGENT_SIN_DISCORD_BOT_TOKEN || "").trim() &&
      (process.env.AGENT_SIN_DISCORD_ALLOWED_USER_IDS || "").trim(),
  );
}

function hasTelegramConfig(): boolean {
  return Boolean(
    (process.env.AGENT_SIN_TELEGRAM_BOT_TOKEN || "").trim() &&
      (process.env.AGENT_SIN_TELEGRAM_ALLOWED_USER_IDS || "").trim(),
  );
}

async function warnIfSchedulesNeedService(config: AppConfig, knownSchedules?: ScheduleEntry[]): Promise<void> {
  const schedules = knownSchedules || (await loadSchedules(config.workspace));
  const enabled = schedules.filter((schedule) => schedule.enabled);
  if (enabled.length === 0) {
    return;
  }
  if (await isSchedulerProcessRunning()) {
    return;
  }
  console.log(
    l(
      `warning: ${enabled.length} enabled schedule(s), but no scheduler daemon is running. Run: agent-sin start --daemon`,
      `警告: 有効なスケジュールが ${enabled.length}件ありますが、scheduler daemon が起動していません。実行: agent-sin start --daemon`,
    ),
  );
  if (process.platform === "darwin" || process.platform === "win32") {
    console.log(l("         For always-on startup: agent-sin service install", "         常駐起動するには: agent-sin service install"));
  }
}

function printServiceHelp(): void {
  const platformLine =
    process.platform === "darwin"
      ? l("On macOS, install writes a LaunchAgent that keeps agent-sin service run alive.", "macOS では install が LaunchAgent を作成し、agent-sin service run を常駐させます。")
      : process.platform === "win32"
        ? l("On Windows, install creates a Task Scheduler logon task that keeps agent-sin service run alive.", "Windows では install が Task Scheduler のログオンタスクを作成し、agent-sin service run を常駐させます。")
        : l("agent-sin service is supported on macOS (launchd) and Windows (Task Scheduler).", "agent-sin service は macOS (launchd) と Windows (Task Scheduler) で対応しています。");
  const manifestCmd = process.platform === "win32" ? "agent-sin service manifest" : "agent-sin service plist";
  console.log(l(`Agent-Sin service

Usage:
  agent-sin service status
  agent-sin service install [--no-start]
  agent-sin service start
  agent-sin service stop
  agent-sin service restart
  ${manifestCmd}
  agent-sin service run

${platformLine}
The service runs the scheduler and, when configured, Discord / Telegram bots.`, `Agent-Sin service

使い方:
  agent-sin service status
  agent-sin service install [--no-start]
  agent-sin service start
  agent-sin service stop
  agent-sin service restart
  ${manifestCmd}
  agent-sin service run

${platformLine}
service は scheduler と、設定済みの場合は Discord / Telegram bot を起動します。`));
}

async function installService(config: AppConfig, options: Options): Promise<number> {
  const provider = getServiceProvider();
  if (!provider.supported) {
    console.error(provider.notSupportedReason());
    return 1;
  }
  try {
    await provider.install(config, { noStart: Boolean(options.no_start) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const status = await provider.status(config);
  console.log(l(`service installed: ${status.manifestPath}`, `service をインストールしました: ${status.manifestPath}`));
  if (options.no_start) {
    console.log(l("service not started (--no-start).", "service は起動していません (--no-start)。"));
  } else {
    console.log(l(`service started: ${serviceLabel()}`, `service を起動しました: ${serviceLabel()}`));
  }
  return 0;
}

async function startService(config: AppConfig): Promise<number> {
  const provider = getServiceProvider();
  if (!provider.supported) {
    console.error(provider.notSupportedReason());
    return 1;
  }
  try {
    await provider.start(config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(l(`service started: ${serviceLabel()}`, `service を起動しました: ${serviceLabel()}`));
  return 0;
}

async function stopService(_config: AppConfig, options: { quiet?: boolean; wait?: boolean } = {}): Promise<number> {
  const provider = getServiceProvider();
  if (!provider.supported) {
    if (!options.quiet) console.error(provider.notSupportedReason());
    return 1;
  }
  try {
    await provider.stop({ quiet: options.quiet, wait: options.wait });
  } catch (error) {
    if (!options.quiet) console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!options.quiet) {
    console.log(l(`service stopped: ${serviceLabel()}`, `service を停止しました: ${serviceLabel()}`));
  }
  return 0;
}

async function serviceStatus(config: AppConfig): Promise<number> {
  const provider = getServiceProvider();
  const schedules = await loadSchedules(config.workspace);
  const enabled = schedules.filter((schedule) => schedule.enabled);
  const processes = await findAgentSinServiceProcesses();
  console.log(`service: ${serviceLabel()}`);
  console.log(`workspace: ${config.workspace}`);
  if (provider.supported) {
    const status = await provider.status(config);
    const manifestKindLabel = status.manifestKind === "schtasks" ? "schtasks" : "plist";
    console.log(
      `${manifestKindLabel}: ${status.manifestPath || "(none)"} ${status.installed ? "installed" : "missing"}`,
    );
  } else {
    console.log(l(`platform: not supported on ${process.platform}`, `platform: ${process.platform} は未対応です`));
  }
  console.log(l(`enabled schedules: ${enabled.length}`, `有効なスケジュール: ${enabled.length}`));
  console.log(l(`scheduler process: ${processes.some((line) => isSchedulerCommandLine(line)) ? "running" : "not running"}`, `scheduler process: ${processes.some((line) => isSchedulerCommandLine(line)) ? "起動中" : "未起動"}`));
  console.log(l(`discord process: ${processes.some((line) => /\sdiscord(?:\s|$)/.test(line)) ? "running" : "not running"}`, `discord process: ${processes.some((line) => /\sdiscord(?:\s|$)/.test(line)) ? "起動中" : "未起動"}`));
  console.log(l(`telegram process: ${processes.some((line) => /\stelegram(?:\s|$)/.test(line)) ? "running" : "not running"}`, `telegram process: ${processes.some((line) => /\stelegram(?:\s|$)/.test(line)) ? "起動中" : "未起動"}`));
  if (processes.length > 0) {
    for (const line of processes) {
      console.log(`  ${line}`);
    }
  }
  if (enabled.length > 0 && !processes.some((line) => isSchedulerCommandLine(line)) && provider.supported) {
    console.log(l("next: agent-sin service install", "次: agent-sin service install"));
  }
  return 0;
}

async function cmdExport(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    printExportHelp();
    return 0;
  }
  const workspace = stringOption(options.workspace) || defaultWorkspace();
  if (!(await pathExists(workspace))) {
    console.error(l(`Workspace not found: ${workspace}`, `ワークスペースが見つかりません: ${workspace}`));
    console.error(l("Run `agent-sin setup` first.", "先に `agent-sin setup` を実行してください。"));
    return 1;
  }
  const result = await exportWorkspace({
    workspace,
    outFile: stringOption(options.out),
    includeSecrets: Boolean(options.include_secrets),
    includeLogs: Boolean(options.include_logs),
    includeIndex: Boolean(options.include_index),
  });
  if (result.includedItems.includes(".env")) {
    console.log(l("! Includes .env. Treat this archive as containing API keys.", "⚠ .env を含みます。APIキー入りアーカイブとして扱ってください。"));
  }
  console.log(`Archive: ${result.archivePath}`);
  console.log(`Size: ${formatBytes(result.byteSize)}`);
  console.log(`Items: ${result.includedItems.join(", ")}`);
  for (const warning of result.warnings) {
    console.log(l(`note: ${warning}`, `注: ${warning}`));
  }
  console.log("");
  console.log(l("Restore on another computer with:", "移行先のPCで以下を実行して復元できます:"));
  console.log(`  agent-sin import ${result.archivePath}`);
  return 0;
}

function printExportHelp(): void {
  console.log(l(`Agent-Sin export

Usage:
  agent-sin export [--out <file>]

Defaults to a migration backup with .env, logs, index, skills, memory, notes, schedules.yaml, Discord / Telegram state, config.toml, and models.yaml.
Excludes only regenerated or bulky runtime folders such as .venv, node_modules, and .DS_Store.
Outputs to ./agent-sin-backup-YYYYMMDD-HHmmss.tar.gz when --out is omitted.`, `Agent-Sin export

使い方:
  agent-sin export [--out <file>]

.env、logs、index、skills、memory、notes、schedules.yaml、Discord / Telegram 状態、config.toml、models.yaml を含む移行バックアップを作成します。
.venv、node_modules、.DS_Store など再生成可能または大きい実行時フォルダだけ除外します。
--out を省略すると ./agent-sin-backup-YYYYMMDD-HHmmss.tar.gz に出力します。`));
}

async function cmdImport(args: string[]): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    printImportHelp();
    return 0;
  }
  const archive = options._[0];
  if (!archive) {
    console.error(l("Usage: agent-sin import <archive> [--force] [--dry-run] [--no-backup]", "使い方: agent-sin import <archive> [--force] [--dry-run] [--no-backup]"));
    return 1;
  }
  const dryRun = Boolean(options.dry_run);
  const force = Boolean(options.force);
  const backup = !options.no_backup;
  const workspace = stringOption(options.workspace) || defaultWorkspace();

  if (dryRun) {
    const entries = await listArchiveEntries(archive);
    console.log(`Archive: ${path.resolve(archive)}`);
    console.log(`Workspace (target): ${workspace}`);
    console.log(`Entries: ${entries.length}`);
    for (const entry of entries) {
      console.log(`  ${entry}`);
    }
    return 0;
  }

  if (await pathExists(workspace)) {
    if (!force && process.stdin.isTTY) {
      const rl = createInterface({ input, output });
      try {
        const message = backup
          ? l(`Back up and overwrite existing workspace ${workspace}. Continue? [y/N]: `, `既存ワークスペース ${workspace} を退避してから上書きします。続行しますか? [y/N]: `)
          : l(`Overwrite existing workspace ${workspace} without backup. Continue? [y/N]: `, `既存ワークスペース ${workspace} を上書きします (バックアップなし)。続行しますか? [y/N]: `);
        const answer = (await rl.question(message)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log(l("Canceled.", "中止しました。"));
          return 1;
        }
      } finally {
        rl.close();
      }
    }
  }

  const result = await importWorkspace({
    archivePath: archive,
    workspace,
    backup,
  });
  console.log(`Workspace: ${result.workspace}`);
  console.log(`Restored entries: ${result.entries.length}`);
  if (result.backupPath) {
    console.log(`Backup: ${result.backupPath}`);
  }
  console.log("");
  console.log(l("Next: agent-sin start", "次: agent-sin start"));
  return 0;
}

function printImportHelp(): void {
  console.log(l(`Agent-Sin import

Usage:
  agent-sin import <archive.tar.gz> [--force] [--dry-run] [--no-backup]

  --force      Skip the overwrite confirmation prompt.
  --dry-run    List archive entries without extracting.
  --no-backup  Skip renaming the existing workspace to a .bak directory.`, `Agent-Sin import

使い方:
  agent-sin import <archive.tar.gz> [--force] [--dry-run] [--no-backup]

  --force      上書き確認を省略します。
  --dry-run    展開せずアーカイブの中身だけ表示します。
  --no-backup  既存ワークスペースを .bak に退避しません。`));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .finally(async () => {
    await shutdownSharedCodexAppServer().catch(() => undefined);
  });
