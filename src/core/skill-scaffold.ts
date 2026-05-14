import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModels, type AppConfig } from "./config.js";
import { loadSkillManifest, resolveSkillEntryPath, type SkillManifest } from "./skill-registry.js";
import { l } from "./i18n.js";

export type SkillRuntimeChoice = "python" | "typescript";

export interface SkillScaffoldOptions {
  id: string;
  runtime: SkillRuntimeChoice;
  name?: string;
  description?: string;
  templateRoot?: string;
}

export interface SkillScaffoldResult {
  skill_id: string;
  skill_dir: string;
  manifest_path: string;
  entry_path: string;
  files: string[];
  runtime: SkillRuntimeChoice;
}

export async function scaffoldSkill(
  config: AppConfig,
  options: SkillScaffoldOptions,
): Promise<SkillScaffoldResult> {
  validateSkillId(options.id);
  const templateDir = options.templateRoot
    ? path.join(options.templateRoot, templateDirName(options.runtime))
    : resolveDefaultTemplateDir(options.runtime);
  await assertTemplateExists(templateDir);

  const target = path.join(config.skills_dir, options.id);
  if (await exists(target)) {
    throw new Error(l(`Skill directory already exists: ${target}`, `スキルディレクトリが既に存在します: ${target}`));
  }
  await mkdir(target, { recursive: true });

  const written: string[] = [];
  await copyTemplate(templateDir, target, target, written);
  await rewriteManifest(path.join(target, "skill.yaml"), {
    ...options,
    name: options.name || titleizeSkillId(options.id),
  });

  const entryName = options.runtime === "python" ? "main.py" : "main.ts";
  return {
    skill_id: options.id,
    skill_dir: target,
    manifest_path: path.join(target, "skill.yaml"),
    entry_path: path.join(target, entryName),
    files: written.sort(),
    runtime: options.runtime,
  };
}

export function validateSkillId(id: string): void {
  if (!id) {
    throw new Error(l("Skill id is required", "Skill id は必須です"));
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(
      l(
        `Invalid skill id: '${id}' (must be kebab-case, start with a lowercase letter, allow [a-z0-9-])`,
        `skill id が不正です: '${id}' (kebab-case、小文字開始、[a-z0-9-] のみ使用可)`,
      ),
    );
  }
  if (id.length > 64) {
    throw new Error(l(`Skill id is too long (max 64 chars): ${id}`, `Skill id が長すぎます (最大64文字): ${id}`));
  }
}

function templateDirName(runtime: SkillRuntimeChoice): string {
  return runtime === "python" ? "skill-python" : "skill-typescript";
}

function titleizeSkillId(id: string): string {
  return id
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveDefaultTemplateDir(runtime: SkillRuntimeChoice): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../..");
  return path.join(root, "templates", templateDirName(runtime));
}

async function assertTemplateExists(dir: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(l(`Template path is not a directory: ${dir}`, `テンプレートパスがディレクトリではありません: ${dir}`));
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Template path")) {
      throw error;
    }
    throw new Error(l(`Skill template not found: ${dir}`, `スキルテンプレートが見つかりません: ${dir}`));
  }
}

async function copyTemplate(
  templateDir: string,
  targetRoot: string,
  current: string,
  written: string[],
): Promise<void> {
  const sourceCurrent = current === targetRoot ? templateDir : current.replace(targetRoot, templateDir);
  for (const entry of await readdir(sourceCurrent, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const sourcePath = path.join(sourceCurrent, entry.name);
    const targetPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyTemplate(templateDir, targetRoot, targetPath, written);
      continue;
    }
    if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
      written.push(path.relative(targetRoot, targetPath));
    }
  }
}

async function rewriteManifest(file: string, options: SkillScaffoldOptions): Promise<void> {
  const raw = await readFile(file, "utf8");
  let next = replaceLine(raw, /^id:\s+.+$/m, `id: ${options.id}`);
  if (options.name) {
    next = replaceLine(next, /^name:\s+.+$/m, `name: ${options.name}`);
  }
  if (options.description) {
    next = replaceLine(next, /^description:\s+.+$/m, `description: ${options.description}`);
  }
  next = next.replace(/^(\s*namespace:)\s+.+$/m, `$1 ${options.id}`);
  await writeFile(file, next, "utf8");
}

function replaceLine(content: string, pattern: RegExp, replacement: string): string {
  if (pattern.test(content)) {
    return content.replace(pattern, replacement);
  }
  return `${replacement}\n${content}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export interface ValidateSkillResult {
  ok: boolean;
  manifest?: SkillManifest;
  skill_dir: string;
  errors: string[];
  warnings: string[];
}

export interface ValidateSkillOptions {
  knownModelIds?: Set<string>;
}

export async function validateInstalledSkill(
  config: AppConfig,
  skillId: string,
): Promise<ValidateSkillResult> {
  return validateSkillDirectory(path.join(config.skills_dir, skillId), skillId, {
    knownModelIds: await loadKnownModelIds(config),
  });
}

export async function validateSkillDirectory(
  skillDir: string,
  skillId: string,
  options: ValidateSkillOptions = {},
): Promise<ValidateSkillResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!(await exists(skillDir))) {
    errors.push(l(`Skill directory not found: ${skillDir}`, `スキルディレクトリが見つかりません: ${skillDir}`));
    return { ok: false, skill_dir: skillDir, errors, warnings };
  }

  let manifest: SkillManifest | undefined;
  try {
    manifest = await loadSkillManifest(skillDir);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, skill_dir: skillDir, errors, warnings };
  }

  if (manifest.id !== skillId) {
    errors.push(l(`Manifest id "${manifest.id}" does not match directory name "${skillId}"`, `Manifest id "${manifest.id}" がディレクトリ名 "${skillId}" と一致しません`));
  }
  if (!manifest.description || manifest.description.trim().length === 0) {
    warnings.push(l("description is empty (chat mode uses it to decide when to call this skill)", "description が空です (chat mode がこのスキルを呼ぶ判断に使います)"));
  }
  const phrases = manifest.invocation?.phrases?.filter((phrase) => typeof phrase === "string" && phrase.trim()) || [];
  const hasCommand = typeof manifest.invocation?.command === "string" && manifest.invocation.command.trim().length > 0;
  if (!hasCommand && phrases.length === 0) {
    errors.push(l("invocation.phrases is required so chat mode can call this skill (or set invocation.command).", "invocation.phrases は必須です。チャットからスキルを呼ぶための代表的な発話を3個以上書いてください (または invocation.command を設定)。"));
  }

  let entryPath = "";
  try {
    entryPath = await resolveSkillEntryPath(manifest);
    if (manifest.runtime === "python" && !manifest.entry.endsWith(".py")) {
      warnings.push(l(`runtime=python but entry "${manifest.entry}" does not end with .py`, `runtime=python ですが entry "${manifest.entry}" が .py で終わっていません`));
    } else if (manifest.runtime === "typescript" && !/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(manifest.entry)) {
      warnings.push(l(`runtime=typescript but entry "${manifest.entry}" has unsupported extension`, `runtime=typescript ですが entry "${manifest.entry}" の拡張子が未対応です`));
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  validateRequiredEnvConventions(manifest, errors);

  for (const output of manifest.outputs) {
    if (!output.id) {
      errors.push(l("outputs[].id is required", "outputs[].id は必須です"));
    }
    if (output.type !== "markdown" && output.type !== "json") {
      errors.push(l(`outputs[${output.id}].type must be 'markdown' or 'json' (got '${output.type}')`, `outputs[${output.id}].type は 'markdown' または 'json' である必要があります ('${output.type}')`));
    }
    if (!output.path) {
      warnings.push(l(`outputs[${output.id}].path is empty`, `outputs[${output.id}].path が空です`));
    }
    if (!output.filename) {
      warnings.push(l(`outputs[${output.id}].filename is empty`, `outputs[${output.id}].filename が空です`));
    }
  }

  if (manifest.memory && !manifest.memory.namespace) {
    errors.push(l("memory.namespace is required when memory section is present", "memory セクションがある場合 memory.namespace は必須です"));
  }

  if (manifest.ai_steps) {
    const seen = new Set<string>();
    for (const step of manifest.ai_steps) {
      if (!step.id) {
        errors.push(l("ai_steps[].id is required", "ai_steps[].id は必須です"));
        continue;
      }
      if (seen.has(step.id)) {
        errors.push(l(`ai_steps[].id duplicated: ${step.id}`, `ai_steps[].id が重複しています: ${step.id}`));
      }
      seen.add(step.id);
      if (!step.model) {
        warnings.push(l(`ai_steps[${step.id}].model is empty`, `ai_steps[${step.id}].model が空です`));
      } else if (options.knownModelIds && !options.knownModelIds.has(step.model)) {
        errors.push(l(`ai_steps[${step.id}].model references unknown model id "${step.model}"`, `ai_steps[${step.id}].model が不明な model id "${step.model}" を参照しています`));
      }
      if (!step.purpose) {
        warnings.push(l(`ai_steps[${step.id}].purpose is empty (helps the model behave correctly)`, `ai_steps[${step.id}].purpose が空です (モデルの挙動安定に役立ちます)`));
      }
    }
  }

  if (entryPath) {
    await validateSourceConventions(entryPath, errors);
  }

  return { ok: errors.length === 0, manifest, skill_dir: skillDir, errors, warnings };
}

export async function loadKnownModelIds(config: AppConfig): Promise<Set<string>> {
  try {
    const models = await loadModels(config.workspace);
    const ids = new Set<string>(Object.keys(models.models || {}));
    for (const role of Object.keys(models.roles || {})) {
      ids.add(role);
    }
    return ids;
  } catch {
    return new Set();
  }
}

function validateRequiredEnvConventions(manifest: SkillManifest, errors: string[]): void {
  for (const entry of manifest.required_env || []) {
    const name = entry.name.trim();
    if (/^AGENT_SIN_/i.test(name)) {
      errors.push(l(`required_env "${name}" is reserved for agent-sin runtime settings`, `required_env "${name}" は agent-sin 本体設定のため予約されています`));
    }
    if (name === "DISCORD_WEBHOOK_URL") {
      errors.push(l('required_env "DISCORD_WEBHOOK_URL" must not be used; call agent-sin notify for Discord notifications', 'required_env "DISCORD_WEBHOOK_URL" は使えません。Discord通知は agent-sin notify を使ってください'));
    }
    if (name === "TELEGRAM_BOT_TOKEN") {
      errors.push(l('required_env "TELEGRAM_BOT_TOKEN" must not be used; call agent-sin notify for Telegram notifications', 'required_env "TELEGRAM_BOT_TOKEN" は使えません。Telegram通知は agent-sin notify を使ってください'));
    }
  }
}

async function validateSourceConventions(entryPath: string, errors: string[]): Promise<void> {
  let source = "";
  try {
    source = await readFile(entryPath, "utf8");
  } catch {
    return;
  }
  if (/\bDISCORD_WEBHOOK_URL\b/.test(source)) {
    errors.push(l('entry file must not read DISCORD_WEBHOOK_URL; use "agent-sin notify --channel discord"', 'entry file は DISCORD_WEBHOOK_URL を読んではいけません。"agent-sin notify --channel discord" を使ってください'));
  }
  if (/discord\.com\/api\/webhooks/i.test(source)) {
    errors.push(l('entry file must not post directly to Discord webhooks; use "agent-sin notify --channel discord"', 'entry file は Discord webhook へ直接POSTしてはいけません。"agent-sin notify --channel discord" を使ってください'));
  }
  if (/\bTELEGRAM_BOT_TOKEN\b/.test(source)) {
    errors.push(l('entry file must not read TELEGRAM_BOT_TOKEN; use "agent-sin notify --channel telegram"', 'entry file は TELEGRAM_BOT_TOKEN を読んではいけません。"agent-sin notify --channel telegram" を使ってください'));
  }
  if (/api\.telegram\.org\/bot/i.test(source)) {
    errors.push(l('entry file must not post directly to Telegram Bot API; use "agent-sin notify --channel telegram"', 'entry file は Telegram Bot API へ直接POSTしてはいけません。"agent-sin notify --channel telegram" を使ってください'));
  }
}
