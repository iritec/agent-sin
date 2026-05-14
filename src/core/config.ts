import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ensureDotenvSkeleton } from "./secrets.js";
import { ensureProfileMemoryFiles } from "./profile-memory.js";
import { migrateLegacyBuiltinCopies } from "./builtin-skills.js";
import { l, setLocale, type Locale } from "./i18n.js";

let cachedInstallRoot: string | null = null;

export function agentSinInstallRoot(): string {
  if (cachedInstallRoot) return cachedInstallRoot;
  const start = (() => {
    try {
      return fileURLToPath(import.meta.url);
    } catch {
      return process.argv[1] || process.cwd();
    }
  })();
  let current = path.dirname(start);
  for (let i = 0; i < 8; i += 1) {
    try {
      const info = statSync(path.join(current, "package.json"));
      if (info.isFile()) {
        cachedInstallRoot = current;
        return current;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  cachedInstallRoot = path.dirname(start);
  return cachedInstallRoot;
}

export interface AppConfig {
  version: number;
  workspace: string;
  notes_dir: string;
  skills_dir: string;
  memory_dir: string;
  index_dir: string;
  logs_dir: string;
  log_retention_days: number;
  event_log_retention_days: number;
  defaults: {
    note_format: string;
    locale?: Locale;
  };
  // チャット / ビルダー役割の実体モデル ID。models.yaml の `roles` から導出する派生フィールドで、
  // config.toml には永続化しない。loadConfig / setupWorkspace 完了後は必ず埋まる。
  chat_model_id: string;
  builder_model_id: string;
}

export type ModelType = "api" | "ollama" | "cli";

export interface ModelEntry {
  // 旧 "login" は読み込み時に "cli" に正規化される。
  type: ModelType;
  model?: string;
  provider?: string;
  effort?: string;
  enabled: boolean;
}

export interface ModelConfig {
  // 論理ロール (chat / builder) を実体モデル ID にマップする。
  // 旧構造との互換のため optional。未設定なら config.toml の defaults をフォールバックする。
  roles?: {
    chat?: string;
    builder?: string;
  };
  models: Record<string, ModelEntry>;
}

export interface SetupWorkspaceOptions {
  workspace?: string;
  notesDir?: string;
  skillsDir?: string;
  memoryDir?: string;
  indexDir?: string;
  logsDir?: string;
  chatModel?: string;
  builder?: string;
  enableModels?: string[];
  forceReconfigure?: boolean;
  // 初回 setup で対話的に決めた chat / builder の構成。
  // ここが渡された場合のみ models.yaml をテンプレからではなくこの構成で動的生成する。
  initialModels?: {
    chat: SetupModelChoice;
    builder: SetupModelChoice;
  };
}

export interface SetupModelChoice {
  // 例: "codex" / "openai" / "gemini" / "anthropic" / "ollama" / "claude-code"
  provider: string;
  // プロバイダ側のモデル名 (gpt-5.5 / gemini-2.5-flash / opus 等)。未指定可。
  model?: string;
  // codex / claude-code 向けの効果レベル。未指定可。
  effort?: string;
}

export interface ProviderCatalogEntry {
  // models.yaml 内のエントリ ID にも使う安定キー
  id: string;
  // 画面表示用ラベル
  label: string;
  type: ModelType;
  // 検出ヒント (CLI 名 / 必要な env キー)
  binary?: string;
  envKeys?: string[];
  defaultModel?: string;
  needsEffort?: boolean;
  defaultChatEffort?: string;
  defaultBuilderEffort?: string;
}

// セットアップで提示するプロバイダの正典。models.yaml の ID もここを起点に決まる。
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "codex",
    label: "Codex CLI",
    type: "cli",
    binary: "codex",
    defaultModel: "gpt-5.5",
    needsEffort: true,
    defaultChatEffort: "low",
    defaultBuilderEffort: "xhigh",
  },
  {
    id: "claude-code",
    label: "Claude Code CLI",
    type: "cli",
    binary: "claude",
    defaultModel: "opus",
    needsEffort: true,
    defaultChatEffort: "medium",
    defaultBuilderEffort: "xhigh",
  },
  {
    id: "openai",
    label: "OpenAI API",
    type: "api",
    envKeys: ["OPENAI_API_KEY", "OPENAI_API_KEYS"],
    defaultModel: "gpt-5.5",
  },
  {
    id: "gemini",
    label: "Google Gemini API",
    type: "api",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-2.5-flash",
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    type: "api",
    envKeys: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-opus-4-7",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    type: "ollama",
    defaultModel: "gemma4:26b",
  },
];

export class SetupRequiredError extends Error {
  constructor(public readonly configPath: string) {
    super(l("Agent-Sin is not set up. Run: agent-sin setup", "Agent-Sin はセットアップされていません。実行: agent-sin setup"));
  }
}

export function defaultWorkspace(): string {
  return process.env.AGENT_SIN_HOME
    ? expandHome(process.env.AGENT_SIN_HOME)
    : path.join(os.homedir(), ".agent-sin");
}

export function configPath(workspace = defaultWorkspace()): string {
  return path.join(workspace, "config.toml");
}

export function legacyConfigPath(workspace = defaultWorkspace()): string {
  return path.join(workspace, "config.yaml");
}

export function modelsPath(workspace = defaultWorkspace()): string {
  return path.join(workspace, "models.yaml");
}

export function schedulesPath(workspace = defaultWorkspace()): string {
  return path.join(workspace, "schedules.yaml");
}

export function legacySchedulesPath(workspace = defaultWorkspace()): string {
  return path.join(workspace, "schedules", "schedules.yaml");
}

export function defaultConfig(workspace = defaultWorkspace()): AppConfig {
  return {
    version: 1,
    workspace,
    notes_dir: path.join(workspace, "notes"),
    skills_dir: path.join(workspace, "skills"),
    memory_dir: path.join(workspace, "memory"),
    index_dir: path.join(workspace, "index"),
    logs_dir: path.join(workspace, "logs"),
    log_retention_days: 14,
    event_log_retention_days: 90,
    defaults: {
      note_format: "daily_markdown",
      locale: detectInstallLocale(),
    },
    chat_model_id: "codex-low",
    builder_model_id: "codex-xhigh",
  };
}

function detectInstallLocale(): Locale | undefined {
  const explicit = (process.env.AGENT_SIN_LOCALE || "").trim().toLowerCase();
  if (explicit === "ja" || explicit === "en") return explicit;
  // Prefer the OS-level locale (Intl) over shell LANG: when a user switches the
  // macOS system language, the shell's LANG often keeps its old value, which
  // would otherwise persist a stale ja locale into config.toml.
  try {
    const intlLocale = (Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase();
    if (/^ja(-|$)/.test(intlLocale)) return "ja";
    if (/^en(-|$)/.test(intlLocale)) return "en";
  } catch {
    // ignored
  }
  const lang = (process.env.LC_ALL || process.env.LANG || "").trim();
  if (lang) {
    return /^ja(_|$|-)/i.test(lang) ? "ja" : "en";
  }
  return undefined;
}

export function defaultModels(): ModelConfig {
  return {
    roles: {
      chat: "codex-low",
      builder: "codex-xhigh",
    },
    models: {
      "codex-low": {
        type: "cli",
        provider: "codex",
        model: "gpt-5.5",
        effort: "low",
        enabled: true,
      },
      "codex-xhigh": {
        type: "cli",
        provider: "codex",
        model: "gpt-5.5",
        effort: "xhigh",
        enabled: true,
      },
      "ollama-gemma": {
        type: "ollama",
        model: "gemma4:26b",
        enabled: false,
      },
      openai: {
        type: "api",
        provider: "openai",
        model: "gpt-5.5",
        enabled: false,
      },
      gemini: {
        type: "api",
        provider: "gemini",
        model: "gemini-2.5-flash",
        enabled: false,
      },
      anthropic: {
        type: "api",
        provider: "anthropic",
        model: "claude-opus-4-7",
        enabled: false,
      },
      "claude-code": {
        type: "cli",
        provider: "claude-code",
        enabled: false,
      },
    },
  };
}

// 初回 setup 時に書き出すモデル定義テンプレート。
// プロバイダごとの追加例をコメントアウトで併記し、ユーザーが必要なものだけ
// `enabled: true` に切り替えて使えるようにする。
// 既存ファイルがある場合は yaml.parseDocument 経由で更新するので、
// このコメントブロックはユーザーが手動で残したコメントごと保持される。
export const MODELS_YAML_TEMPLATE = `# agent-sin model registry
#
# \`roles\` maps logical roles (chat / builder) to concrete model entries.
# \`models\` contains only concrete model definitions.
#
# Types:
#   api    ... HTTP API (write API keys in ~/.agent-sin/.env)
#   ollama ... local Ollama (defaults to localhost:11434 unless OLLAMA_HOST is set)
#   cli    ... separately authenticated external CLI (codex / claude-code)
#
# Provider examples are commented out.
# Uncomment only the providers you want to use and set \`enabled: true\`.

roles:
  chat: codex-low
  builder: codex-xhigh

models:
  codex-low:
    type: cli
    provider: codex
    model: gpt-5.5
    effort: low
    enabled: true

  codex-xhigh:
    type: cli
    provider: codex
    model: gpt-5.5
    effort: xhigh
    enabled: true

  # --- Examples. Uncomment only the providers you use. ---

  # OpenAI API (set OPENAI_API_KEY in .env)
  # openai:
  #   type: api
  #   provider: openai
  #   model: gpt-5.5
  #   enabled: true

  # Google Gemini API (set GEMINI_API_KEY in .env)
  # gemini:
  #   type: api
  #   provider: gemini
  #   model: gemini-2.5-flash
  #   enabled: true

  # Anthropic Claude API (set ANTHROPIC_API_KEY in .env)
  # anthropic:
  #   type: api
  #   provider: anthropic
  #   model: claude-opus-4-7
  #   enabled: true

  # Ollama (local LLM; run \`ollama pull <model>\` first)
  # ollama-gemma:
  #   type: ollama
  #   model: gemma4:26b
  #   enabled: true

  # Claude Code CLI (already logged in with \`claude\`)
  # claude-code:
  #   type: cli
  #   provider: claude-code
  #   model: opus
  #   effort: xhigh
  #   enabled: true

`;

const MODELS_YAML_TEMPLATE_JA = `# agent-sin model registry
#
# \`roles\` は論理的な役割（chat / builder）から実体モデルへの参照です。
# \`models\` には実体モデルの定義だけを並べます。
#
# 種別 (type):
#   api    ... HTTP API (~/.agent-sin/.env に API キーを書く)
#   ollama ... ローカル Ollama (OLLAMA_HOST 未設定なら localhost:11434)
#   cli    ... 別途ログイン済みの外部 CLI (codex / claude-code)
#
# 例として用意したプロバイダはコメントアウトしてあります。
# 使いたいものだけ \`#\` を外して \`enabled: true\` にしてください。

roles:
  chat: codex-low
  builder: codex-xhigh

models:
  codex-low:
    type: cli
    provider: codex
    model: gpt-5.5
    effort: low
    enabled: true

  codex-xhigh:
    type: cli
    provider: codex
    model: gpt-5.5
    effort: xhigh
    enabled: true

  # --- 以下は例。使うものだけコメントアウトを解除 ---

  # OpenAI API (.env に OPENAI_API_KEY を設定)
  # openai:
  #   type: api
  #   provider: openai
  #   model: gpt-5.5
  #   enabled: true

  # Google Gemini API (.env に GEMINI_API_KEY を設定)
  # gemini:
  #   type: api
  #   provider: gemini
  #   model: gemini-2.5-flash
  #   enabled: true

  # Anthropic Claude API (.env に ANTHROPIC_API_KEY を設定)
  # anthropic:
  #   type: api
  #   provider: anthropic
  #   model: claude-opus-4-7
  #   enabled: true

  # Ollama (ローカル LLM。\`ollama pull <model>\` 済みであること)
  # ollama-gemma:
  #   type: ollama
  #   model: gemma4:26b
  #   enabled: true

  # Claude Code CLI (\`claude\` ログイン済み)
  # claude-code:
  #   type: cli
  #   provider: claude-code
  #   model: opus
  #   effort: xhigh
  #   enabled: true

`;

function localizedModelsYamlTemplate(): string {
  return l(MODELS_YAML_TEMPLATE, MODELS_YAML_TEMPLATE_JA);
}

export interface DetectedProvider {
  id: string;
  label: string;
  hint: string;
}

// セットアップ時に「実際にこの環境で使えそうなプロバイダ」を検出する。
// 検出は早く・副作用なしで終わるものだけにする (バイナリの存在 / 環境変数 / 短い HTTP 確認)。
// API キー系プロバイダはワークスペースの .env に書かれているキーだけを対象にする。
// シェルから export されただけのキーは「このワークスペース用」とは限らないので拾わない。
export async function detectAvailableProviders(workspaceForEnv?: string): Promise<DetectedProvider[]> {
  let dotenvKeys: Set<string> = new Set();
  if (workspaceForEnv) {
    try {
      const { readDotenvKeys } = await import("./secrets.js");
      dotenvKeys = await readDotenvKeys(workspaceForEnv);
    } catch {
      // .env が無くても続行する
    }
  }
  const results: DetectedProvider[] = [];
  await Promise.all(
    PROVIDER_CATALOG.map(async (entry) => {
      const detection = await detectProvider(entry, dotenvKeys);
      if (detection) results.push({ id: entry.id, label: entry.label, hint: detection });
    }),
  );
  // PROVIDER_CATALOG の並びを保持
  const order = new Map(PROVIDER_CATALOG.map((p, i) => [p.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  return results;
}

async function detectProvider(entry: ProviderCatalogEntry, dotenvKeys: Set<string>): Promise<string | null> {
  if (entry.binary) {
    const found = await findExecutable(entry.binary);
    if (found) return l(`${entry.binary} CLI found`, `${entry.binary} CLI 検出`);
    return null;
  }
  if (entry.envKeys) {
    for (const key of entry.envKeys) {
      if (dotenvKeys.has(key)) return l(`${key} found in .env`, `.env に ${key} を検出`);
    }
    return null;
  }
  if (entry.id === "ollama") {
    return (await ollamaReachable()) ? l("server responded", "サーバー応答あり") : null;
  }
  return null;
}

async function findExecutable(name: string): Promise<boolean> {
  const pathEnv = process.env.PATH || "";
  const sep = path.delimiter;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, name + ext);
        const info = await stat(candidate);
        if (info.isFile()) return true;
      } catch {
        // not found, keep searching
      }
    }
  }
  return false;
}

async function ollamaReachable(): Promise<boolean> {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);
  try {
    const response = await fetch(`${host}/api/version`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 初回 setup で対話的に決めた chat / builder の構成から、コメント付き models.yaml を組み立てる。
// 使ったプロバイダは active な実体定義として、それ以外は <PROVIDER_CATALOG> 由来のコメント例として残す。
export function renderModelsYamlFromChoices(
  chat: SetupModelChoice,
  builder: SetupModelChoice,
): string {
  const { chat: chatEntry, builder: builderEntry } = buildSetupDescriptorPair(chat, builder);
  // 両方が同じ ID に解決される場合 (同じプロバイダ・モデル・effort) は 1 つだけ書く
  const usedIds = new Map<string, EntryDescriptor>();
  usedIds.set(chatEntry.id, chatEntry);
  if (!usedIds.has(builderEntry.id)) {
    usedIds.set(builderEntry.id, builderEntry);
  }

  // 例ブロックでは「現在 active なプロバイダ」と被らないように除外
  const usedProviders = new Set<string>();
  if (chat.provider) usedProviders.add(chat.provider);
  if (builder.provider) usedProviders.add(builder.provider);

  const lines: string[] = [];
  lines.push("# agent-sin model registry");
  lines.push("#");
  lines.push(l("# `roles` maps logical roles (chat / builder) to concrete model entries.", "# `roles` は論理的な役割（chat / builder）から実体モデルへの参照です。"));
  lines.push(l("# `models` contains only concrete model definitions.", "# `models` には実体モデルの定義だけを並べます。"));
  lines.push("#");
  lines.push(l("# Types:", "# 種別 (type):"));
  lines.push(l("#   api    ... HTTP API (write API keys in ~/.agent-sin/.env)", "#   api    ... HTTP API (~/.agent-sin/.env に API キーを書く)"));
  lines.push(l("#   ollama ... local Ollama (defaults to localhost:11434 unless OLLAMA_HOST is set)", "#   ollama ... ローカル Ollama (OLLAMA_HOST 未設定なら localhost:11434)"));
  lines.push(l("#   cli    ... separately authenticated external CLI (codex / claude-code)", "#   cli    ... 別途ログイン済みの外部 CLI (codex / claude-code)"));
  lines.push("#");
  lines.push(l("# Model IDs can be named freely. They only need to match the IDs pointed to by `roles.chat` / `roles.builder`.", "# モデル ID は自由に名付けられます。`roles.chat` / `roles.builder` が指す ID と"));
  lines.push(l("#", "# `models:` 配下の ID が一致していれば OK です。"));
  lines.push("");
  lines.push("roles:");
  lines.push(`  chat: ${chatEntry.id}`);
  lines.push(`  builder: ${builderEntry.id}`);
  lines.push("");
  lines.push("models:");
  for (const descriptor of usedIds.values()) {
    lines.push(...renderEntry(descriptor, false));
    lines.push("");
  }
  const exampleProviders = PROVIDER_CATALOG.filter((p) => !usedProviders.has(p.id));
  if (exampleProviders.length > 0) {
    lines.push(l("  # --- Examples. Uncomment only the providers you use. ---", "  # --- 以下は例。使うものだけコメントアウトを解除 ---"));
    lines.push("");
    for (const provider of exampleProviders) {
      const example = buildEntryDescriptor(
        { provider: provider.id, model: provider.defaultModel, effort: provider.defaultBuilderEffort },
        "chat",
      );
      example.id = provider.id;
      lines.push(`  # ${provider.label}${exampleEnvHint(provider)}`);
      lines.push(...renderEntry(example, true));
      lines.push("");
    }
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function exampleEnvHint(entry: ProviderCatalogEntry): string {
  if (entry.envKeys && entry.envKeys[0]) return l(` (set ${entry.envKeys[0]} in .env)`, ` (.env に ${entry.envKeys[0]} を設定)`);
  if (entry.binary) return l(` (already logged in with \`${entry.binary}\`)`, ` (\`${entry.binary}\` ログイン済み)`);
  if (entry.id === "ollama") return l(" (run `ollama pull <model>` first)", " (`ollama pull <model>` 済みであること)");
  return "";
}

interface EntryDescriptor {
  id: string;
  type: ModelType;
  provider?: string;
  model?: string;
  effort?: string;
}

function buildEntryDescriptor(choice: SetupModelChoice, role: "chat" | "builder"): EntryDescriptor {
  const catalog = PROVIDER_CATALOG.find((p) => p.id === choice.provider);
  const type: ModelType = catalog?.type ?? "api";
  const effort =
    choice.effort ??
    (role === "chat" ? catalog?.defaultChatEffort : catalog?.defaultBuilderEffort);
  const model = choice.model ?? catalog?.defaultModel;
  const id = deriveSetupId(choice.provider, effort, type);
  return {
    id,
    type,
    provider: choice.provider,
    model,
    effort: catalog?.needsEffort ? effort : undefined,
  };
}

// 外部から「この選択は何 ID になる？」を問い合わせるためのヘルパー。
// (config.defaults を選択後の ID に揃える用)
export function deriveSetupChoiceId(choice: SetupModelChoice, role: "chat" | "builder"): string {
  return buildEntryDescriptor(choice, role).id;
}

// chat と builder のペアを見て、同じ ID に解決されるが内容が異なる場合は
// `-chat` / `-builder` を付けて衝突を解消する。
// (例: 同じプロバイダ openai を chat=gpt-5.4-mini, builder=gpt-5.5 にしたいケース)
export function deriveSetupChoicePairIds(
  chat: SetupModelChoice,
  builder: SetupModelChoice,
): { chat: string; builder: string } {
  const pair = buildSetupDescriptorPair(chat, builder);
  return { chat: pair.chat.id, builder: pair.builder.id };
}

function buildSetupDescriptorPair(
  chat: SetupModelChoice,
  builder: SetupModelChoice,
): { chat: EntryDescriptor; builder: EntryDescriptor } {
  const chatEntry = buildEntryDescriptor(chat, "chat");
  const builderEntry = buildEntryDescriptor(builder, "builder");
  if (chatEntry.id === builderEntry.id && entriesDiffer(chatEntry, builderEntry)) {
    chatEntry.id = `${chatEntry.id}-chat`;
    builderEntry.id = `${builderEntry.id}-builder`;
  }
  return { chat: chatEntry, builder: builderEntry };
}

function entriesDiffer(a: EntryDescriptor, b: EntryDescriptor): boolean {
  return (
    (a.model ?? "") !== (b.model ?? "") ||
    (a.effort ?? "") !== (b.effort ?? "") ||
    a.type !== b.type ||
    (a.provider ?? "") !== (b.provider ?? "")
  );
}

function deriveSetupId(provider: string, effort: string | undefined, type: ModelType): string {
  if (type === "cli" && effort) {
    return `${provider}-${effort}`;
  }
  if (type === "ollama") {
    return provider === "ollama" ? "ollama" : provider;
  }
  return provider;
}

function renderEntry(descriptor: EntryDescriptor, commented: boolean): string[] {
  const prefix = commented ? "  # " : "  ";
  const childPrefix = commented ? "  #   " : "    ";
  const fields: Array<[string, string]> = [];
  fields.push(["type", descriptor.type]);
  if (descriptor.provider && descriptor.provider !== descriptor.id) {
    fields.push(["provider", descriptor.provider]);
  } else if (descriptor.provider && descriptor.type !== "ollama") {
    fields.push(["provider", descriptor.provider]);
  }
  if (descriptor.model) fields.push(["model", descriptor.model]);
  if (descriptor.effort) fields.push(["effort", descriptor.effort]);
  fields.push(["enabled", "true"]);
  const lines: string[] = [];
  lines.push(`${prefix}${descriptor.id}:`);
  for (const [key, value] of fields) {
    lines.push(`${childPrefix}${key}: ${value}`);
  }
  return lines;
}

function applySetupChoicesToModels(
  models: ModelConfig,
  choices: { chat: SetupModelChoice; builder: SetupModelChoice },
): void {
  const { chat: chatEntry, builder: builderEntry } = buildSetupDescriptorPair(choices.chat, choices.builder);
  models.roles = {
    ...(models.roles || {}),
    chat: chatEntry.id,
    builder: builderEntry.id,
  };
  for (const descriptor of [chatEntry, builderEntry]) {
    models.models[descriptor.id] = modelEntryFromDescriptor(descriptor);
  }
}

function modelEntryFromDescriptor(descriptor: EntryDescriptor): ModelEntry {
  const entry: ModelEntry = {
    type: descriptor.type,
    enabled: true,
  };
  if (descriptor.provider && descriptor.type !== "ollama") {
    entry.provider = descriptor.provider;
  }
  if (descriptor.model) {
    entry.model = descriptor.model;
  }
  if (descriptor.effort) {
    entry.effort = descriptor.effort;
  }
  return entry;
}

export async function setupWorkspace(options: SetupWorkspaceOptions = {}): Promise<AppConfig> {
  const workspace = options.workspace ? expandHome(options.workspace) : defaultWorkspace();
  const initial = defaultConfig(workspace);
  await mkdir(initial.workspace, { recursive: true });
  let config = initial;
  let legacyRoleIds: { chat?: string; builder?: string } | undefined;
  try {
    const raw = await readFile(configPath(initial.workspace), "utf8");
    const parsed = parseTomlConfigWithLegacy(raw);
    config = normalizeConfig(parsed.config);
    legacyRoleIds = parsed.legacy_role_ids;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    config = await loadLegacyConfigOrDefault(initial.workspace, initial);
  }

  config = applySetupOptions(config, options);
  const modelsFile = modelsPath(config.workspace);
  const hadExistingModels = await pathExists(modelsFile);
  if (!hadExistingModels) {
    await mkdir(path.dirname(modelsFile), { recursive: true });
    if (options.initialModels) {
      const yaml = renderModelsYamlFromChoices(
        options.initialModels.chat,
        options.initialModels.builder,
      );
      await writeFile(modelsFile, yaml, "utf8");
      const pairIds = deriveSetupChoicePairIds(options.initialModels.chat, options.initialModels.builder);
      config.chat_model_id = pairIds.chat;
      config.builder_model_id = pairIds.builder;
    } else {
      await writeFile(modelsFile, localizedModelsYamlTemplate(), "utf8");
    }
  } else {
    // 旧形式 (type: login / roles なし) を新形式へ移行。
    // 旧 config.toml の `[defaults] chat_model` / `builder` があればそれを優先する。
    const preferredChat = legacyRoleIds?.chat || config.chat_model_id;
    const preferredBuilder = legacyRoleIds?.builder || config.builder_model_id;
    const migration = await migrateModelsYamlIfLegacy(config.workspace, {
      preferredRoles: {
        chat: preferredChat,
        builder: preferredBuilder,
      },
    });
    if (migration.changed) {
      if (migration.renamed.chat && config.chat_model_id === "chat") {
        config.chat_model_id = migration.renamed.chat;
      }
      if (migration.renamed.builder && config.builder_model_id === "builder") {
        config.builder_model_id = migration.renamed.builder;
      }
    }
    if (options.initialModels) {
      const models = await loadModelsOrDefault(config.workspace);
      applySetupChoicesToModels(models, options.initialModels);
      await writeModelsYaml(modelsFile, models);
      const pairIds = deriveSetupChoicePairIds(options.initialModels.chat, options.initialModels.builder);
      config.chat_model_id = pairIds.chat;
      config.builder_model_id = pairIds.builder;
    }
  }
  let models = await loadModelsOrDefault(config.workspace);
  // 旧 config.toml の [defaults] chat_model / builder が残っていて、
  // かつ models.yaml.roles が未設定なら一度だけ転記する。
  let rolesChanged = false;
  if (legacyRoleIds) {
    const nextRoles = { ...(models.roles || {}) };
    if (legacyRoleIds.chat && !nextRoles.chat && models.models[legacyRoleIds.chat]) {
      nextRoles.chat = legacyRoleIds.chat;
      rolesChanged = true;
    }
    if (legacyRoleIds.builder && !nextRoles.builder && models.models[legacyRoleIds.builder]) {
      nextRoles.builder = legacyRoleIds.builder;
      rolesChanged = true;
    }
    if (rolesChanged) {
      models = { ...models, roles: nextRoles };
    }
  }
  // models.yaml.roles から実体 ID を導出する。
  config.chat_model_id = resolveRoleIdFromModels(models, "chat", config.chat_model_id);
  config.builder_model_id = resolveRoleIdFromModels(models, "builder", config.builder_model_id);
  const enabledModelIds = new Set(options.enableModels || []);
  enabledModelIds.add(config.chat_model_id);
  enabledModelIds.add(config.builder_model_id);
  validateKnownModel(config.chat_model_id, models);
  validateKnownModel(config.builder_model_id, models);
  let modelsChanged = rolesChanged;
  for (const modelId of enabledModelIds) {
    validateKnownModel(modelId, models);
    if (models.models[modelId].enabled !== true) {
      models.models[modelId].enabled = true;
      modelsChanged = true;
    }
  }

  await ensureWorkspaceDirs(config);
  await writeConfig(configPath(config.workspace), config);
  if (modelsChanged) {
    await writeModelsYaml(modelsFile, models);
  }
  await migrateLegacySchedules(config.workspace);
  await ensureSchedulesSkeleton(schedulesPath(config.workspace));
  await ensureDailyMemoIndexSchedule(config);
  await migrateLegacyBuiltinCopies(config.skills_dir);
  await ensureProfileMemoryFiles(config);
  await ensureDotenvSkeleton(config.workspace);
  return config;
}

// models.yaml の roles から実体モデル ID を取り出す。未設定 / 不正の場合は fallback を返す。
function resolveRoleIdFromModels(
  models: ModelConfig,
  role: ModelRole,
  fallback: string,
): string {
  const fromRoles = role === "chat" ? models.roles?.chat : models.roles?.builder;
  if (fromRoles && models.models[fromRoles]) {
    return fromRoles;
  }
  if (fallback && models.models[fallback]) {
    return fallback;
  }
  return fromRoles || fallback;
}

async function migrateLegacySchedules(workspace: string): Promise<void> {
  const legacy = legacySchedulesPath(workspace);
  const target = schedulesPath(workspace);
  try {
    await stat(target);
    return;
  } catch {
    // Target missing — see if a legacy copy exists.
  }
  let legacyContent: string;
  try {
    legacyContent = await readFile(legacy, "utf8");
  } catch {
    return;
  }
  await writeFile(target, legacyContent, "utf8");
  await rm(legacy, { force: true }).catch(() => undefined);
  await rmdir(path.dirname(legacy)).catch(() => undefined);
}

async function ensureSchedulesSkeleton(file: string): Promise<void> {
  try {
    await stat(file);
    return;
  } catch {
    // Missing — create empty skeleton.
  }
  const skeleton = l(`# Agent-Sin schedules
# Run "agent-sin daemon" to start the scheduler. Cron format: "min hour dom month dow"
# Edit this file and restart the daemon for changes to take effect.
schedules: []
`, `# Agent-Sin schedules
# scheduler を起動するには "agent-sin daemon" を実行します。Cron形式: "min hour dom month dow"
# 変更を反映するにはこのファイルを編集して daemon を再起動してください。
schedules: []
`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, skeleton, "utf8");
}

const DAILY_MEMO_INDEX_ID = "daily-memo-index";

function dailyMemoIndexMarkerPath(workspace: string): string {
  return path.join(workspace, ".daily-memo-index-installed");
}

export async function ensureDailyMemoIndexSchedule(config: AppConfig): Promise<void> {
  const marker = dailyMemoIndexMarkerPath(config.workspace);
  try {
    await stat(marker);
    return;
  } catch {
    // No marker — proceed with detection.
  }

  const file = schedulesPath(config.workspace);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return;
  }

  let parsed: { schedules?: unknown };
  try {
    parsed = (YAML.parse(raw) as { schedules?: unknown }) ?? {};
  } catch {
    return;
  }
  const schedules = Array.isArray(parsed.schedules) ? [...(parsed.schedules as unknown[])] : [];
  const alreadyRegistered = schedules.some(
    (entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === DAILY_MEMO_INDEX_ID,
  );

  if (alreadyRegistered) {
    await writeFile(marker, "", "utf8");
    return;
  }

  const detected = await detectMemoIndexDependencies(config.workspace);
  if (!detected) return;

  schedules.push({
    id: DAILY_MEMO_INDEX_ID,
    description: "意味検索用のメモ索引を毎日更新する",
    cron: "0 3 * * *",
    skill: "memo-index",
    enabled: true,
  });
  await writeFile(file, YAML.stringify({ ...parsed, schedules }), "utf8");
  await writeFile(marker, "", "utf8");
}

async function detectMemoIndexDependencies(workspace: string): Promise<boolean> {
  const venvPython = path.join(workspace, ".venv", "bin", "python");
  const candidates: string[] = [];
  try {
    await stat(venvPython);
    candidates.push(venvPython);
  } catch {
    // venv not present — fall through to system python.
  }
  candidates.push("python3");

  for (const python of candidates) {
    if (await tryImportMemoIndexDeps(python)) return true;
  }
  return false;
}

function tryImportMemoIndexDeps(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let proc;
    try {
      proc = spawn(python, ["-c", "import chromadb, sentence_transformers"], { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      finish(false);
    }, 4000);
    proc.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

export async function ensureWorkspaceDirs(config: AppConfig): Promise<void> {
  await mkdir(config.workspace, { recursive: true });
  await mkdir(config.notes_dir, { recursive: true });
  await mkdir(config.skills_dir, { recursive: true });
  await mkdir(config.memory_dir, { recursive: true });
  await mkdir(path.join(config.memory_dir, "skill-memory"), { recursive: true });
  await mkdir(path.join(config.memory_dir, "profile"), { recursive: true });
  await mkdir(path.join(config.memory_dir, "daily"), { recursive: true });
  await mkdir(path.join(config.index_dir, "local-index"), { recursive: true });
  await mkdir(config.logs_dir, { recursive: true });
  await mkdir(path.join(config.logs_dir, "runs"), { recursive: true });
}

export async function loadConfig(): Promise<AppConfig> {
  const file = configPath();
  let config: AppConfig;
  try {
    const raw = await readFile(file, "utf8");
    config = normalizeConfig(parseTomlConfig(raw));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    try {
      const legacyRaw = await readFile(legacyConfigPath(), "utf8");
      config = normalizeConfig(YAML.parse(legacyRaw) as AppConfig);
    } catch (legacyError) {
      if (!isMissingFile(legacyError)) {
        throw legacyError;
      }
      throw new SetupRequiredError(file);
    }
  }
  applyConfigLocale(config);
  return applyModelRoles(config);
}

function applyConfigLocale(config: AppConfig): void {
  const explicit = (process.env.AGENT_SIN_LOCALE || "").trim().toLowerCase();
  if (explicit === "ja" || explicit === "en") {
    setLocale(explicit);
    return;
  }
  const locale = config.defaults?.locale;
  if (locale === "ja" || locale === "en") {
    setLocale(locale);
    return;
  }
  setLocale(null);
}

// models.yaml の roles を AppConfig.chat_model_id / builder_model_id に反映する。
// config.toml には保存しないため、loadConfig のたびにここで導出する。
async function applyModelRoles(config: AppConfig): Promise<AppConfig> {
  try {
    const models = await loadModels(config.workspace);
    config.chat_model_id = resolveRoleIdFromModels(models, "chat", config.chat_model_id);
    config.builder_model_id = resolveRoleIdFromModels(models, "builder", config.builder_model_id);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  return config;
}

export async function loadModels(workspace = defaultWorkspace()): Promise<ModelConfig> {
  const raw = await readFile(modelsPath(workspace), "utf8");
  const parsed = YAML.parse(raw) as ModelConfig;
  return normalizeModelConfig(parsed);
}

// 旧 type: login を type: cli にメモリ上だけ寄せる正規化。
// ファイル自体の書き換えは migrateModelsYamlIfLegacy が担当する。
export function normalizeModelConfig(input: ModelConfig): ModelConfig {
  const result: ModelConfig = {
    roles: input.roles ? { ...input.roles } : undefined,
    models: {},
  };
  for (const [id, entry] of Object.entries(input.models || {})) {
    const normalizedType = (entry.type as string) === "login" ? "cli" : (entry.type as ModelType);
    result.models[id] = { ...entry, type: normalizedType };
  }
  return result;
}

export type ModelRole = "chat" | "builder";

// 論理ロールから実体モデル ID を解決する。models.yaml の roles を真実の源とする。
export function resolveRoleId(
  config: AppConfig,
  models: ModelConfig | null,
  role: ModelRole,
): string {
  const fromRoles = role === "chat" ? models?.roles?.chat : models?.roles?.builder;
  if (fromRoles) return fromRoles;
  return role === "chat" ? config.chat_model_id : config.builder_model_id;
}

export async function setRoleModel(role: ModelRole, modelId: string): Promise<AppConfig> {
  const config = await loadConfig();
  const models = await loadModels(config.workspace);
  if (!models.models[modelId]) {
    throw new Error(l(`Unknown model: ${modelId}`, `不明なモデルです: ${modelId}`));
  }
  if (role === "chat") {
    config.chat_model_id = modelId;
  } else {
    config.builder_model_id = modelId;
  }
  models.models[modelId].enabled = true;
  models.roles = { ...(models.roles || {}), [role]: modelId };
  await writeModelsYaml(modelsPath(config.workspace), models);
  return config;
}

export async function setDefaultModel(modelId: string): Promise<AppConfig> {
  return setRoleModel("chat", modelId);
}

export async function writeYaml(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, YAML.stringify(value), "utf8");
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

// 既存の models.yaml にあるコメント・並び順・ユーザー独自のエントリを保ったまま
// 値だけ更新するための書き込みヘルパー。
// 内部表現と一致しないキーはユーザー編集として保持し、テンプレに残しておいた
// コメントアウト済みの例も残す。
export async function writeModelsYaml(file: string, models: ModelConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  let doc: YAML.Document.Parsed | null = null;
  try {
    const raw = await readFile(file, "utf8");
    doc = YAML.parseDocument(raw);
    if (doc.errors.length > 0) {
      doc = null;
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  if (!doc || doc.contents == null) {
    // ファイル無し / パース失敗時はテンプレを起点に書き戻す。
    doc = YAML.parseDocument(localizedModelsYamlTemplate());
  }
  if (models.roles) {
    for (const role of ["chat", "builder"] as const) {
      const id = models.roles[role];
      if (id) doc.setIn(["roles", role], id);
    }
  }
  for (const [id, entry] of Object.entries(models.models)) {
    const keyPath = ["models", id];
    if (!doc.hasIn(keyPath)) {
      doc.setIn(keyPath, entry);
      continue;
    }
    for (const [field, value] of Object.entries(entry)) {
      doc.setIn([...keyPath, field], value);
    }
  }
  await writeFile(file, doc.toString(), "utf8");
}

export interface ModelsYamlMigrationResult {
  changed: boolean;
  // 旧 ID → 新 ID のマップ（chat/builder のリネームがあった場合のみエントリあり）。
  renamed: Record<string, string>;
  // ユーザーに見せる短い説明。changed が true のときだけ意味がある。
  notes: string[];
}

export interface MigrationOptions {
  // 追加する roles ブロックの参照先。指定された ID が旧形式の "chat"/"builder"
  // ならリネーム後 ID に解決し、それ以外（既存の実体名）ならそのまま使う。
  // 未指定なら旧形式 ID をフォールバックに使う。
  preferredRoles?: { chat?: string; builder?: string };
}

// 旧形式 (type: login / IDが chat・builder / roles なし) を検出して、
// コメントを保ったまま新形式へ書き換える。
// 既に新形式なら何もせず { changed: false } を返す。
export async function migrateModelsYamlIfLegacy(
  workspace: string = defaultWorkspace(),
  options: MigrationOptions = {},
): Promise<ModelsYamlMigrationResult> {
  const file = modelsPath(workspace);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { changed: false, renamed: {}, notes: [] };
    }
    throw error;
  }
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length > 0 || doc.contents == null) {
    return { changed: false, renamed: {}, notes: [] };
  }

  const renamed: Record<string, string> = {};
  const notes: string[] = [];
  let changed = false;

  const modelsNode = doc.get("models") as YAML.YAMLMap | undefined;
  if (!modelsNode || !YAML.isMap(modelsNode)) {
    return { changed: false, renamed: {}, notes: [] };
  }

  // type: login → type: cli を一括正規化
  for (const item of modelsNode.items) {
    const value = item.value;
    if (YAML.isMap(value)) {
      const typeVal = value.get("type");
      if (typeVal === "login") {
        value.set("type", "cli");
        changed = true;
      }
    }
  }
  if (changed) notes.push("type: login → type: cli に統一");

  // chat / builder をエンティティ名にリネーム（コンフリクト時はスキップ）
  const existingIds = new Set<string>(
    modelsNode.items
      .map((it) => (YAML.isScalar(it.key) ? String(it.key.value) : null))
      .filter((id): id is string => !!id),
  );

  for (const oldId of ["chat", "builder"] as const) {
    if (!existingIds.has(oldId)) continue;
    const entry = modelsNode.get(oldId) as YAML.YAMLMap | undefined;
    if (!entry || !YAML.isMap(entry)) continue;
    const newId = deriveEntityId(entry, oldId, existingIds);
    if (!newId || newId === oldId) continue;
    // 既存キーを差し替え (順序保持)
    for (const item of modelsNode.items) {
      if (YAML.isScalar(item.key) && item.key.value === oldId) {
        item.key = doc.createNode(newId) as YAML.Scalar<string>;
        break;
      }
    }
    existingIds.delete(oldId);
    existingIds.add(newId);
    renamed[oldId] = newId;
    changed = true;
    notes.push(`${oldId} → ${newId} にリネーム`);
  }

  // roles 未設定なら追加。優先順:
  // 1. options.preferredRoles で渡された値（config.toml の現在値など）。
  //    旧 ID ("chat"/"builder") はリネーム後 ID に解決する。
  // 2. リネーム済みなら新 ID。
  // 3. 既存に旧 ID があればそのまま参照。
  if (!doc.has("roles")) {
    const resolveTarget = (
      preferred: string | undefined,
      role: "chat" | "builder",
    ): string | undefined => {
      if (preferred) {
        // 旧 ID を渡された場合はリネーム後 ID に置き換える
        if (renamed[preferred]) return renamed[preferred];
        if (existingIds.has(preferred)) return preferred;
      }
      if (renamed[role]) return renamed[role];
      if (existingIds.has(role)) return role;
      return undefined;
    };
    const chatTarget = resolveTarget(options.preferredRoles?.chat, "chat");
    const builderTarget = resolveTarget(options.preferredRoles?.builder, "builder");
    if (chatTarget || builderTarget) {
      const rolesMap = doc.createNode({}) as YAML.YAMLMap;
      if (chatTarget) rolesMap.set("chat", chatTarget);
      if (builderTarget) rolesMap.set("builder", builderTarget);
      // roles: ブロックを先頭近く（models: の前）に挿入。
      const rootMap = doc.contents as YAML.YAMLMap;
      const newPair = doc.createPair("roles", rolesMap) as YAML.Pair;
      const modelsIdx = rootMap.items.findIndex(
        (it) => YAML.isScalar(it.key) && it.key.value === "models",
      );
      if (modelsIdx >= 0) {
        rootMap.items.splice(modelsIdx, 0, newPair);
      } else {
        rootMap.items.push(newPair);
      }
      changed = true;
      notes.push("roles: ブロックを追加");
    }
  }

  if (changed) {
    await writeFile(file, doc.toString(), "utf8");
  }
  return { changed, renamed, notes };
}

function deriveEntityId(
  entry: YAML.YAMLMap,
  fallbackRole: "chat" | "builder",
  taken: Set<string>,
): string | null {
  const provider = entry.get("provider");
  const type = entry.get("type");
  const effort = entry.get("effort");
  const modelName = entry.get("model");
  let candidate: string | null = null;
  if (provider === "codex") {
    candidate = `codex-${effort || (fallbackRole === "chat" ? "low" : "xhigh")}`;
  } else if (provider === "claude-code") {
    candidate = effort ? `claude-code-${effort}` : "claude-code";
  } else if (type === "api" && typeof provider === "string") {
    candidate = provider;
  } else if (type === "ollama" && typeof modelName === "string") {
    candidate = `ollama-${modelName.split(":")[0]}`;
  }
  if (!candidate) return null;
  // 衝突回避
  let final = candidate;
  let n = 2;
  while (taken.has(final)) {
    final = `${candidate}-${n}`;
    n += 1;
  }
  return final;
}

export async function writeConfig(file: string, config: AppConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyTomlConfig(config), "utf8");
}

export function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function normalizeConfig(config: AppConfig): AppConfig {
  const workspace = expandHome(config.workspace || defaultWorkspace());
  return {
    ...config,
    workspace,
    notes_dir: expandHome(config.notes_dir || path.join(workspace, "notes")),
    skills_dir: expandHome(config.skills_dir || path.join(workspace, "skills")),
    memory_dir: expandHome(config.memory_dir || path.join(workspace, "memory")),
    index_dir: expandHome(config.index_dir || path.join(workspace, "index")),
    logs_dir: expandHome(config.logs_dir || path.join(workspace, "logs")),
    log_retention_days:
      typeof config.log_retention_days === "number" && config.log_retention_days >= 0
        ? config.log_retention_days
        : 14,
    event_log_retention_days:
      typeof config.event_log_retention_days === "number" && config.event_log_retention_days >= 0
        ? config.event_log_retention_days
        : 90,
    defaults: {
      note_format: config.defaults?.note_format || "daily_markdown",
      ...(normalizeLocaleValue(config.defaults?.locale)
        ? { locale: normalizeLocaleValue(config.defaults?.locale)! }
        : {}),
    },
    // chat_model_id / builder_model_id は loadConfig / setupWorkspace で
    // models.yaml.roles から導出される。ここでは空文字を許容する。
    chat_model_id: config.chat_model_id || "",
    builder_model_id: config.builder_model_id || "",
  };
}

function normalizeLocaleValue(value: unknown): Locale | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === "ja" || lower === "en") return lower;
  return undefined;
}

async function loadLegacyConfigOrDefault(workspace: string, fallback: AppConfig): Promise<AppConfig> {
  try {
    const raw = await readFile(legacyConfigPath(workspace), "utf8");
    return normalizeConfig(YAML.parse(raw) as AppConfig);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    return fallback;
  }
}

function applySetupOptions(config: AppConfig, options: SetupWorkspaceOptions): AppConfig {
  const next: AppConfig = {
    ...config,
    defaults: {
      ...config.defaults,
    },
  };
  if (options.workspace) {
    next.workspace = expandHome(options.workspace);
  }
  if (options.notesDir) {
    next.notes_dir = expandHome(options.notesDir);
  }
  if (options.skillsDir) {
    next.skills_dir = expandHome(options.skillsDir);
  }
  if (options.memoryDir) {
    next.memory_dir = expandHome(options.memoryDir);
  }
  if (options.indexDir) {
    next.index_dir = expandHome(options.indexDir);
  }
  if (options.logsDir) {
    next.logs_dir = expandHome(options.logsDir);
  }
  if (options.chatModel) {
    next.chat_model_id = options.chatModel;
  }
  if (options.builder) {
    next.builder_model_id = options.builder;
  }
  return normalizeConfig(next);
}

async function loadModelsOrDefault(workspace: string): Promise<ModelConfig> {
  try {
    return await loadModels(workspace);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    return defaultModels();
  }
}

function validateKnownModel(modelId: string, models: ModelConfig): void {
  if (!models.models[modelId]) {
    const known = Object.keys(models.models).join(", ");
    throw new Error(l(`Unknown model: ${modelId}. Available models: ${known}`, `不明なモデルです: ${modelId}。利用可能なモデル: ${known}`));
  }
}

function stringifyTomlConfig(config: AppConfig): string {
  const defaultsLines = [`note_format = ${tomlString(config.defaults.note_format)}`];
  if (config.defaults.locale === "ja" || config.defaults.locale === "en") {
    defaultsLines.push(`locale = ${tomlString(config.defaults.locale)}`);
  }
  return [
    `version = ${config.version}`,
    `workspace = ${tomlString(config.workspace)}`,
    `notes_dir = ${tomlString(config.notes_dir)}`,
    `skills_dir = ${tomlString(config.skills_dir)}`,
    `memory_dir = ${tomlString(config.memory_dir)}`,
    `index_dir = ${tomlString(config.index_dir)}`,
    `logs_dir = ${tomlString(config.logs_dir)}`,
    `log_retention_days = ${config.log_retention_days}`,
    `event_log_retention_days = ${config.event_log_retention_days}`,
    "",
    "[defaults]",
    ...defaultsLines,
    "",
  ].join("\n");
}

// 旧 config.toml の `[defaults] chat_model` / `builder` を読み取って一時的に保持する。
// setupWorkspace で models.yaml.roles に転記するためだけに使う。
export interface ParsedTomlConfig {
  config: AppConfig;
  legacy_role_ids?: {
    chat?: string;
    builder?: string;
  };
}

function parseTomlConfig(raw: string): AppConfig {
  return parseTomlConfigWithLegacy(raw).config;
}

export function parseTomlConfigWithLegacy(raw: string): ParsedTomlConfig {
  const parsed: Record<string, unknown> & {
    defaults: Record<string, string>;
  } = {
    defaults: {},
  };
  const legacy: { chat?: string; builder?: string } = {};
  let section: "root" | "defaults" | "ignored" = "root";
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line === "[defaults]") {
      section = "defaults";
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = "ignored";
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    const value = parseTomlValue(rawValue);
    if (section === "defaults") {
      // 旧フィールド (chat_model / builder) は models.yaml.roles に統合済み。
      // ここでは捕捉だけ行い、defaults セクションには書き戻さない。
      if (key === "chat_model") {
        legacy.chat = String(value);
        continue;
      }
      if (key === "builder") {
        legacy.builder = String(value);
        continue;
      }
      parsed.defaults = {
        ...parsed.defaults,
        [key]: String(value),
      };
    } else if (section === "ignored") {
      continue;
    } else {
      Object.assign(parsed, { [key]: value });
    }
  }
  const config = parsed as unknown as AppConfig;
  const result: ParsedTomlConfig = { config };
  if (legacy.chat || legacy.builder) {
    result.legacy_role_ids = legacy;
  }
  return result;
}

function parseTomlValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
