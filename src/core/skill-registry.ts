import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { loadSkillSettings } from "./skill-settings.js";
import { l, localizeObject } from "./i18n.js";

export type SkillRuntime = "python" | "typescript";

export type SkillSource = "builtin" | "user";

export interface SkillOutputDefinition {
  id: string;
  type: "markdown" | "json";
  path: string;
  filename: string;
  append?: boolean;
  show_saved?: boolean;
}

export type DiscordSlashOptionType = "string" | "integer" | "number" | "boolean";

export interface DiscordSlashOptionChoice {
  name: string;
  value: string | number;
}

export interface DiscordSlashOption {
  name: string;
  type: DiscordSlashOptionType;
  description?: string;
  description_ja?: string;
  required?: boolean;
  choices?: DiscordSlashOptionChoice[];
}

export interface DiscordSlashInvocation {
  description?: string;
  description_ja?: string;
  options?: DiscordSlashOption[];
}

export interface SkillManifest {
  id: string;
  name: string;
  description?: string;
  runtime: SkillRuntime;
  entry: string;
  handler: string;
  invocation?: {
    command?: string;
    phrases?: string[];
    discord_slash?: DiscordSlashInvocation;
  };
  input: {
    schema: Record<string, unknown>;
  };
  outputs: SkillOutputDefinition[];
  ai_steps?: Array<{
    id: string;
    purpose: string;
    model: string;
    optional?: boolean;
  }>;
  memory?: {
    namespace: string;
    read?: boolean;
    write?: boolean;
  };
  retry?: {
    max_attempts?: number;
    delay_ms?: number;
  };
  required_env?: Array<{
    name: string;
    description?: string;
    optional?: boolean;
  }>;
  enabled?: boolean;
  output_mode?: string;
  /**
   * Marks a skill as performing user-visible side effects (add, delete, send,
   * update, save). The chat engine drops the LLM's narrative for any turn that
   * invokes a side-effect skill so the deterministic skill result is the only
   * record — both for the user and in the conversation history. This prevents
   * future-tense announcements like "I'll add it now" from sitting next to a
   * successful tool result and getting misread as "not done yet" on the next
   * turn.
   */
  side_effect?: boolean;
  dir: string;
  /**
   * Where this skill was loaded from. `builtin` = packaged with agent-sin
   * (read-only, structurally protected from deletion). `user` = lives in the
   * user's workspace skills directory. Derived from the resolved path; the
   * value in skill.yaml itself is ignored to prevent a workspace file from
   * impersonating a builtin.
   */
  source: SkillSource;
  /**
   * Set to true in a workspace skill manifest to deliberately override a
   * builtin skill with the same id. Without this flag, workspace copies of
   * builtin ids are ignored (and cleaned up by migration).
   */
  override?: boolean;
}

export function builtinSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../..", "builtin-skills");
}

export async function listBuiltinSkillIds(): Promise<Set<string>> {
  return new Set(await readSkillDirIds(builtinSkillsDir()));
}

export async function listSkillManifests(workspaceSkillsDir: string): Promise<SkillManifest[]> {
  const builtinManifests = await readManifestsFromDir(builtinSkillsDir(), "builtin");
  const builtinIds = new Set(builtinManifests.map((m) => m.id));
  const workspaceManifests = await readManifestsFromDir(workspaceSkillsDir, "user");

  const byId = new Map<string, SkillManifest>();
  for (const manifest of builtinManifests) {
    byId.set(manifest.id, manifest);
  }
  for (const manifest of workspaceManifests) {
    if (builtinIds.has(manifest.id) && manifest.override !== true) {
      // Workspace dir collides with a builtin id but did not opt in to override.
      // Ignore it here — migration archives or deletes it on the next startup.
      continue;
    }
    byId.set(manifest.id, manifest);
  }

  const workspace = path.dirname(workspaceSkillsDir);
  const settings = await loadSkillSettings(workspace);
  for (const manifest of byId.values()) {
    if (settings.disabled.has(manifest.id)) {
      manifest.enabled = false;
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export async function findSkillManifest(skillsDir: string, skillId: string): Promise<SkillManifest> {
  const manifests = await listSkillManifests(skillsDir);
  const manifest = manifests.find((item) => item.id === skillId);
  if (!manifest) {
    throw new Error(l(`Skill not found: ${skillId}`, `スキルが見つかりません: ${skillId}`));
  }
  return manifest;
}

export async function loadSkillManifest(skillDir: string): Promise<SkillManifest> {
  const raw = await readFile(path.join(skillDir, "skill.yaml"), "utf8");
  const parsedRaw = YAML.parse(raw) as Record<string, unknown>;
  const parsed = applyManifestDefaults(localizeObject(parsedRaw));
  validateManifest(parsed);
  const source: SkillSource = isInsideBuiltin(skillDir) ? "builtin" : "user";
  const override = parsed.override === true && source === "user";
  return {
    ...parsed,
    outputs: parsed.outputs || [],
    ai_steps: parsed.ai_steps || [],
    required_env: Array.isArray(parsed.required_env)
      ? parsed.required_env
          .filter((entry) => entry && typeof entry.name === "string" && entry.name.length > 0)
          .map((entry) => ({
            name: entry.name,
            description: typeof entry.description === "string" ? entry.description : undefined,
            optional: entry.optional === true,
          }))
      : undefined,
    enabled: parsed.enabled ?? true,
    output_mode: parsed.output_mode,
    side_effect: parsed.side_effect === true,
    dir: skillDir,
    source,
    override,
  };
}

export async function resolveSkillEntryPath(manifest: SkillManifest): Promise<string> {
  assertSafeRelativeSkillPath(manifest.entry, "entry");
  const logicalDir = path.resolve(manifest.dir);
  const dir = await realpath(manifest.dir);
  const candidate = path.resolve(manifest.dir, manifest.entry);
  if (!isPathInside(logicalDir, candidate)) {
    throw new Error(l(`Skill entry must stay inside skill directory: ${manifest.entry}`, `スキル entry はスキルディレクトリ内にある必要があります: ${manifest.entry}`));
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error(l(`Entry file not found: ${path.join(manifest.dir, manifest.entry)}`, `entry ファイルが見つかりません: ${path.join(manifest.dir, manifest.entry)}`));
  }
  if (!isPathInside(dir, resolved)) {
    throw new Error(l(`Skill entry must stay inside skill directory: ${manifest.entry}`, `スキル entry はスキルディレクトリ内にある必要があります: ${manifest.entry}`));
  }
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(l(`Skill entry is not a file: ${manifest.entry}`, `スキル entry がファイルではありません: ${manifest.entry}`));
  }
  return resolved;
}

async function readSkillDirIds(skillsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }
    const manifestPath = path.join(skillsDir, entry.name, "skill.yaml");
    try {
      await stat(manifestPath);
      ids.push(entry.name);
    } catch {
      continue;
    }
  }
  return ids;
}

async function readManifestsFromDir(
  skillsDir: string,
  source: SkillSource,
): Promise<SkillManifest[]> {
  const ids = await readSkillDirIds(skillsDir);
  const manifests: SkillManifest[] = [];
  for (const id of ids) {
    const skillDir = path.join(skillsDir, id);
    try {
      const manifest = await loadSkillManifest(skillDir);
      // loadSkillManifest derives source from the actual path. If the caller
      // expected this dir to map to `source` but the path is elsewhere
      // (e.g. symlinks), prefer the path-derived value — it's authoritative.
      manifests.push(manifest.source === source ? manifest : { ...manifest, source });
    } catch (error) {
      if (source === "builtin") {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(l(`Invalid builtin skill "${id}": ${message}`, `ビルトインスキル "${id}" が不正です: ${message}`));
      }
      continue;
    }
  }
  return manifests;
}

function isInsideBuiltin(dir: string): boolean {
  const root = builtinSkillsDir();
  const resolved = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function applyManifestDefaults(
  raw: Record<string, unknown>,
): Omit<SkillManifest, "dir" | "source"> {
  const manifest = { ...raw } as Record<string, unknown>;
  if (typeof manifest.name !== "string" && typeof manifest.id === "string") {
    manifest.name = manifest.id;
  }
  delete manifest.triggers;
  if (typeof manifest.handler !== "string" || manifest.handler.length === 0) {
    manifest.handler = "run";
  }
  if (typeof manifest.entry !== "string" || manifest.entry.length === 0) {
    if (manifest.runtime === "python") manifest.entry = "main.py";
    else if (manifest.runtime === "typescript") manifest.entry = "main.ts";
  }
  if (
    !manifest.input ||
    typeof manifest.input !== "object" ||
    Array.isArray(manifest.input) ||
    !(manifest.input as Record<string, unknown>).schema
  ) {
    manifest.input = { schema: { type: "object", additionalProperties: true } };
  }
  if (!Array.isArray(manifest.outputs)) manifest.outputs = [];
  if (typeof manifest.output_mode !== "string" || manifest.output_mode.trim().length === 0) {
    delete manifest.output_mode;
  }
  return manifest as unknown as Omit<SkillManifest, "dir" | "source">;
}

function validateManifest(manifest: Omit<SkillManifest, "dir" | "source">): void {
  // Hard requirements only — handler/entry are auto-filled from runtime defaults.
  const required = ["id", "runtime"];
  for (const key of required) {
    if (!(key in manifest) || (manifest as Record<string, unknown>)[key] === undefined) {
      throw new Error(l(`Invalid skill manifest: missing ${key}`, `skill manifest が不正です: ${key} がありません`));
    }
  }
  if (!["python", "typescript"].includes(manifest.runtime)) {
    throw new Error(l(`Invalid skill runtime: ${manifest.runtime}`, `skill runtime が不正です: ${manifest.runtime}`));
  }
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
    throw new Error(l(`Invalid skill id: ${manifest.id}`, `skill id が不正です: ${manifest.id}`));
  }
  if (typeof manifest.entry !== "string" || manifest.entry.length === 0) {
    throw new Error(l("Invalid skill manifest: missing entry", "skill manifest が不正です: entry がありません"));
  }
  if (typeof manifest.handler !== "string" || manifest.handler.length === 0) {
    throw new Error(l("Invalid skill manifest: missing handler", "skill manifest が不正です: handler がありません"));
  }
  assertSafeRelativeSkillPath(manifest.entry, "entry");
  if (manifest.retry?.max_attempts !== undefined && manifest.retry.max_attempts < 0) {
    throw new Error(l("Invalid skill manifest: retry.max_attempts must be 0 or greater", "skill manifest が不正です: retry.max_attempts は0以上である必要があります"));
  }
  validateInvocation(manifest);
}

function validateInvocation(manifest: Omit<SkillManifest, "dir" | "source">): void {
  if (!manifest.invocation) {
    return;
  }
  const command = manifest.invocation.command;
  if (command !== undefined && (typeof command !== "string" || command.trim().length === 0)) {
    throw new Error(l("Invalid skill manifest: invocation.command must be a non-empty string", "skill manifest が不正です: invocation.command は空でない string である必要があります"));
  }
  const phrases = manifest.invocation.phrases;
  if (phrases !== undefined) {
    if (!Array.isArray(phrases) || phrases.some((phrase) => typeof phrase !== "string" || phrase.trim().length === 0)) {
      throw new Error(l("Invalid skill manifest: invocation.phrases must be a list of non-empty strings", "skill manifest が不正です: invocation.phrases は空でない string のリストである必要があります"));
    }
  }
  validateDiscordSlash(manifest);
}

const DISCORD_SLASH_OPTION_TYPES: readonly DiscordSlashOptionType[] = [
  "string",
  "integer",
  "number",
  "boolean",
];
const DISCORD_SLASH_NAME_RE = /^[\w-]{1,32}$/;

function validateDiscordSlash(manifest: Omit<SkillManifest, "dir" | "source">): void {
  const slash = manifest.invocation?.discord_slash;
  if (slash === undefined) return;
  if (typeof slash !== "object" || slash === null || Array.isArray(slash)) {
    throw new Error(l(
      "Invalid skill manifest: invocation.discord_slash must be an object",
      "skill manifest が不正です: invocation.discord_slash はオブジェクトである必要があります",
    ));
  }
  if (slash.description !== undefined && (typeof slash.description !== "string" || slash.description.length === 0)) {
    throw new Error(l(
      "Invalid skill manifest: invocation.discord_slash.description must be a non-empty string",
      "skill manifest が不正です: invocation.discord_slash.description は空でない string である必要があります",
    ));
  }
  if (slash.description_ja !== undefined && (typeof slash.description_ja !== "string" || slash.description_ja.length === 0)) {
    throw new Error(l(
      "Invalid skill manifest: invocation.discord_slash.description_ja must be a non-empty string",
      "skill manifest が不正です: invocation.discord_slash.description_ja は空でない string である必要があります",
    ));
  }
  if (slash.options !== undefined) {
    if (!Array.isArray(slash.options)) {
      throw new Error(l(
        "Invalid skill manifest: invocation.discord_slash.options must be a list",
        "skill manifest が不正です: invocation.discord_slash.options は配列である必要があります",
      ));
    }
    const seen = new Set<string>();
    for (const option of slash.options) {
      validateDiscordSlashOption(option, seen);
    }
  }
}

function validateDiscordSlashOption(option: unknown, seen: Set<string>): void {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    throw new Error(l(
      "Invalid skill manifest: invocation.discord_slash.options[*] must be an object",
      "skill manifest が不正です: invocation.discord_slash.options の要素はオブジェクトである必要があります",
    ));
  }
  const opt = option as Record<string, unknown>;
  const name = opt.name;
  if (typeof name !== "string" || !DISCORD_SLASH_NAME_RE.test(name)) {
    throw new Error(l(
      `Invalid skill manifest: invocation.discord_slash.options[*].name must match ${DISCORD_SLASH_NAME_RE} (got ${JSON.stringify(name)})`,
      `skill manifest が不正です: invocation.discord_slash.options[*].name は ${DISCORD_SLASH_NAME_RE} に一致する必要があります (${JSON.stringify(name)})`,
    ));
  }
  if (seen.has(name)) {
    throw new Error(l(
      `Invalid skill manifest: duplicate discord_slash option name "${name}"`,
      `skill manifest が不正です: discord_slash の option name "${name}" が重複しています`,
    ));
  }
  seen.add(name);
  const type = opt.type;
  if (typeof type !== "string" || !DISCORD_SLASH_OPTION_TYPES.includes(type as DiscordSlashOptionType)) {
    throw new Error(l(
      `Invalid skill manifest: invocation.discord_slash.options[*].type must be one of ${DISCORD_SLASH_OPTION_TYPES.join("|")} (got ${JSON.stringify(type)})`,
      `skill manifest が不正です: invocation.discord_slash.options[*].type は ${DISCORD_SLASH_OPTION_TYPES.join("|")} のいずれかである必要があります (${JSON.stringify(type)})`,
    ));
  }
  if (opt.description !== undefined && (typeof opt.description !== "string" || opt.description.length === 0)) {
    throw new Error(l(
      "Invalid skill manifest: invocation.discord_slash.options[*].description must be a non-empty string",
      "skill manifest が不正です: invocation.discord_slash.options[*].description は空でない string である必要があります",
    ));
  }
  if (opt.description_ja !== undefined && (typeof opt.description_ja !== "string" || opt.description_ja.length === 0)) {
    throw new Error(l(
      "Invalid skill manifest: invocation.discord_slash.options[*].description_ja must be a non-empty string",
      "skill manifest が不正です: invocation.discord_slash.options[*].description_ja は空でない string である必要があります",
    ));
  }
  if (opt.required !== undefined && typeof opt.required !== "boolean") {
    throw new Error(l(
      "Invalid skill manifest: invocation.discord_slash.options[*].required must be a boolean",
      "skill manifest が不正です: invocation.discord_slash.options[*].required は boolean である必要があります",
    ));
  }
  if (opt.choices !== undefined) {
    if (type === "boolean") {
      throw new Error(l(
        "Invalid skill manifest: discord_slash boolean option cannot have choices",
        "skill manifest が不正です: discord_slash の boolean option には choices を指定できません",
      ));
    }
    if (!Array.isArray(opt.choices)) {
      throw new Error(l(
        "Invalid skill manifest: invocation.discord_slash.options[*].choices must be a list",
        "skill manifest が不正です: invocation.discord_slash.options[*].choices は配列である必要があります",
      ));
    }
    for (const choice of opt.choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        throw new Error(l(
          "Invalid skill manifest: discord_slash choice must be an object",
          "skill manifest が不正です: discord_slash の choice はオブジェクトである必要があります",
        ));
      }
      const c = choice as Record<string, unknown>;
      if (typeof c.name !== "string" || c.name.length === 0) {
        throw new Error(l(
          "Invalid skill manifest: discord_slash choice.name must be a non-empty string",
          "skill manifest が不正です: discord_slash の choice.name は空でない string である必要があります",
        ));
      }
      const expectedValueType = type === "string" ? "string" : "number";
      if (typeof c.value !== expectedValueType) {
        throw new Error(l(
          `Invalid skill manifest: discord_slash choice.value must be a ${expectedValueType} for option type ${type}`,
          `skill manifest が不正です: discord_slash の choice.value は option type ${type} に対して ${expectedValueType} である必要があります`,
        ));
      }
    }
  }
}

function assertSafeRelativeSkillPath(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(l(`Invalid skill manifest: ${label} must be a non-empty relative path`, `skill manifest が不正です: ${label} は空でない相対パスである必要があります`));
  }
  if (value.includes("\0")) {
    throw new Error(l(`Invalid skill manifest: ${label} contains a null byte`, `skill manifest が不正です: ${label} に null byte が含まれています`));
  }
  if (path.isAbsolute(value)) {
    throw new Error(l(`Invalid skill manifest: ${label} must be relative`, `skill manifest が不正です: ${label} は相対パスである必要があります`));
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(l(`Invalid skill manifest: ${label} must stay inside the skill directory`, `skill manifest が不正です: ${label} はスキルディレクトリ内にある必要があります`));
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
