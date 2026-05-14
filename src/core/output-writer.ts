import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { SkillManifest, SkillOutputDefinition } from "./skill-registry.js";
import type { SkillResult } from "../skills-sdk/types.js";
import { l } from "./i18n.js";

export interface SavedOutput {
  id: string;
  type: string;
  path: string;
  append: boolean;
  show_saved: boolean;
}

export async function writeSkillOutputs(
  config: AppConfig,
  manifest: SkillManifest,
  result: SkillResult,
  date = new Date(),
): Promise<SavedOutput[]> {
  const saved: SavedOutput[] = [];
  for (const output of manifest.outputs || []) {
    const value = result.outputs?.[output.id];
    if (!value) {
      continue;
    }
    if (output.type !== "markdown") {
      throw new Error(l(`Unsupported output type: ${output.type}`, `未対応の出力形式です: ${output.type}`));
    }
    const file = resolveOutputFile(config, output, date);
    assertAllowedOutputPath(config, file);
    await writeMarkdown(file, output, value, date);
    saved.push({
      id: output.id,
      type: output.type,
      path: file,
      append: output.append ?? false,
      show_saved: output.show_saved !== false,
    });
  }
  return saved;
}

export function resolveOutputFile(config: AppConfig, output: SkillOutputDefinition, date: Date): string {
  const renderedDir = renderTemplate(output.path, date);
  const renderedFilename = renderTemplate(output.filename, date);
  const normalized = renderedDir.replace(/^\.?\//, "");

  if (normalized === "notes" || normalized.startsWith("notes/")) {
    const rest = normalized.replace(/^notes\/?/, "");
    return path.join(config.notes_dir, rest, renderedFilename);
  }
  if (path.isAbsolute(normalized)) {
    return path.join(normalized, renderedFilename);
  }
  return path.join(config.workspace, normalized, renderedFilename);
}

export function renderTemplate(template: string, date: Date): string {
  const yyyy = String(date.getFullYear());
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const isoDate = `${yyyy}-${MM}-${dd}`;
  return template
    .replaceAll("{{yyyy}}", yyyy)
    .replaceAll("{{MM}}", MM)
    .replaceAll("{{dd}}", dd)
    .replaceAll("{{date}}", isoDate)
    .replaceAll("{{datetime}}", date.toISOString());
}

async function writeMarkdown(
  file: string,
  output: SkillOutputDefinition,
  value: { content?: string; frontmatter?: Record<string, unknown> },
  date: Date,
): Promise<void> {
  const content = value.content || "";
  await mkdir(path.dirname(file), { recursive: true });

  if (output.append) {
    const existing = await readTextIfExists(file);
    const prefix = existing ? "" : initialMarkdown(value.frontmatter, date);
    await writeFile(file, `${prefix}${existing}${ensureTrailingNewline(content)}`, "utf8");
    return;
  }

  await writeFile(file, `${initialFrontmatter(value.frontmatter)}${content}`, "utf8");
}

function initialMarkdown(frontmatter: Record<string, unknown> | undefined, date: Date): string {
  const title = renderTemplate("# {{date}}\n\n", date);
  return `${initialFrontmatter(frontmatter)}${title}`;
}

function initialFrontmatter(frontmatter: Record<string, unknown> | undefined): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return "";
  }
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function assertAllowedOutputPath(config: AppConfig, file: string): void {
  const resolved = path.resolve(file);
  const allowedRoots = [path.resolve(config.workspace), path.resolve(config.notes_dir)];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(l(`Output path is outside allowed directories: ${file}`, `出力先が許可された場所の外です: ${file}`));
  }
}
